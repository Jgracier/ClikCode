/** Claude Code's tool hooks, run by ClikCode's own agent (the Gateway and
 * ClikCode Local lanes) so a user's hooks behave the same whichever lane runs
 * the turn.
 *
 * Read from the files Claude Code reads -- `~/.claude/settings.json`, then the
 * workspace's `.claude/settings.json` and `.claude/settings.local.json` -- in
 * Claude's own shape:
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "Bash|Write",
 *       "hooks": [ { "type": "command", "command": "...", "timeout": 60 } ] } ],
 *     "PostToolUse": [ ... ] } }
 *
 * Tools are matched by Claude's names (ClikCode's `bash` is `Bash`,
 * `write_file` is `Write`, ...) and the hook receives Claude's JSON on stdin
 * (`tool_name`, `tool_input` with `file_path`), so a hook written for Claude
 * Code needs no change.
 *
 * Semantics kept from Claude Code, within what this loop allows:
 *   - PreToolUse: exit 2, or stdout JSON `{"decision":"block"}` /
 *     `hookSpecificOutput.permissionDecision: "deny"`, BLOCKS the call with the
 *     reason (stderr or the JSON's). A hook can never grant a permission.
 *   - PostToolUse: exit 2 (stderr) or `{"decision":"block","reason"}` is fed
 *     back to the model after the tool's own output.
 *   - Any other exit is a hook error: reported, never blocking. */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ModelToolCall } from './model-client.js';
import type { ToolRunResult } from './tool-contract.js';

interface HookCommand { type?: string; command?: string; timeout?: number }
interface HookGroup { matcher?: string; hooks?: HookCommand[] }
type HookEvent = 'PreToolUse' | 'PostToolUse';
export type HookConfig = Partial<Record<HookEvent, HookGroup[]>>;

/** ClikCode's tool names as Claude Code names them. MCP tools share Claude's `mcp__server__tool` form. */
const CLAUDE_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash', bash_output: 'BashOutput', kill_bash: 'KillShell',
  read_file: 'Read', write_file: 'Write', edit_file: 'Edit', multi_edit: 'MultiEdit',
  list_dir: 'LS', glob: 'Glob', grep: 'Grep',
  web_fetch: 'WebFetch', web_search: 'WebSearch',
  todo_write: 'TodoWrite', task: 'Task', skill: 'Skill', exit_plan_mode: 'ExitPlanMode',
};

export function claudeToolName(name: string): string {
  return CLAUDE_TOOL_NAMES[name] ?? name;
}

/** Claude's argument names: a file tool's `path` is `file_path`. */
function claudeToolInput(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!['read_file', 'write_file', 'edit_file', 'multi_edit'].includes(name) || typeof args.path !== 'string') return args;
  const { path: filePath, ...rest } = args;
  return { file_path: filePath, ...rest };
}

/** Claude's matcher: empty or `*` matches every tool; otherwise a regex over the tool name. */
export function hookMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    // fail-open-ok: an unparseable matcher is compared literally, as Claude Code does for a plain name.
    return matcher === toolName;
  }
}

async function readHookFile(file: string): Promise<HookConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    // fail-open-ok: a settings file that does not exist declares no hooks.
    return undefined;
  }
  try {
    const hooks = (JSON.parse(raw) as { hooks?: HookConfig }).hooks;
    return hooks && typeof hooks === 'object' ? hooks : undefined;
  } catch {
    // fail-open-ok: Claude Code refuses a settings file it cannot parse the same way; no hooks from it.
    return undefined;
  }
}

/** Every tool hook the user's Claude settings declare, merged in Claude's order (user, project, local). */
export async function readClaudeHooks(cwd: string, home: string = homedir()): Promise<HookConfig> {
  const files = [
    path.join(home, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];
  const merged: HookConfig = {};
  for (const config of await Promise.all(files.map(readHookFile))) {
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      const groups = config?.[event];
      if (Array.isArray(groups)) merged[event] = [...(merged[event] ?? []), ...groups];
    }
  }
  return merged;
}

interface HookRun { code: number | null; stdout: string; stderr: string }

function runHookCommand(command: string, payload: unknown, cwd: string, timeoutSeconds: number): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += `\nhook timed out after ${timeoutSeconds}s`;
    }, timeoutSeconds * 1000);
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-64_000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64_000); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

/** The block reason a hook's result carries, if it blocks. */
function blockReason(run: HookRun, event: HookEvent): string | undefined {
  if (run.code === 2) return run.stderr.trim() || `blocked by a ${event} hook`;
  if (run.code !== 0) return undefined;
  try {
    const out = JSON.parse(run.stdout) as { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    if (out.decision === 'block') return out.reason ?? `blocked by a ${event} hook`;
    if (event === 'PreToolUse' && out.hookSpecificOutput?.permissionDecision === 'deny') {
      return out.hookSpecificOutput.permissionDecisionReason ?? 'denied by a PreToolUse hook';
    }
  } catch {
    // fail-open-ok: plain (non-JSON) stdout on exit 0 is informational, as in Claude Code.
  }
  return undefined;
}

/** The loop's hooks for this config, or undefined when it declares none. */
export function toolHooksFrom(config: HookConfig, onError?: (message: string) => void): {
  preToolUse?(call: ModelToolCall, info: { sessionId: string; cwd: string }): Promise<{ deny?: string } | void>;
  postToolUse?(call: ModelToolCall, result: ToolRunResult, info: { sessionId: string; cwd: string }): Promise<{ output?: string } | void>;
} | undefined {
  const pre = config.PreToolUse ?? [];
  const post = config.PostToolUse ?? [];
  if (!pre.length && !post.length) return undefined;
  const commandsFor = (groups: HookGroup[], tool: string) =>
    groups.filter((group) => hookMatches(group.matcher, tool)).flatMap((group) => group.hooks ?? [])
      .filter((hook) => (hook.type ?? 'command') === 'command' && typeof hook.command === 'string' && hook.command.trim());
  const run = async (event: HookEvent, hooks: HookCommand[], payload: Record<string, unknown>, cwd: string) => {
    for (const hook of hooks) {
      const result = await runHookCommand(hook.command!, payload, cwd, Math.max(1, hook.timeout ?? 60));
      const reason = blockReason(result, event);
      if (reason) return reason;
      if (result.code !== 0) onError?.(`${event} hook \`${hook.command}\` failed (exit ${result.code ?? 'none'}): ${result.stderr.trim().slice(0, 300)}`);
    }
    return undefined;
  };
  return {
    ...(pre.length ? {
      async preToolUse(call, info) {
        const tool = claudeToolName(call.name);
        const hooks = commandsFor(pre, tool);
        if (!hooks.length) return;
        const deny = await run('PreToolUse', hooks, {
          session_id: info.sessionId, cwd: info.cwd, hook_event_name: 'PreToolUse',
          tool_name: tool, tool_input: claudeToolInput(call.name, call.args),
        }, info.cwd);
        return deny ? { deny } : undefined;
      },
    } : {}),
    ...(post.length ? {
      async postToolUse(call, result, info) {
        const tool = claudeToolName(call.name);
        const hooks = commandsFor(post, tool);
        if (!hooks.length) return;
        const feedback = await run('PostToolUse', hooks, {
          session_id: info.sessionId, cwd: info.cwd, hook_event_name: 'PostToolUse',
          tool_name: tool, tool_input: claudeToolInput(call.name, call.args),
          tool_response: { output: result.output, isError: result.isError === true },
        }, info.cwd);
        return feedback ? { output: `${result.output}\n\n[PostToolUse hook] ${feedback}` } : undefined;
      },
    } : {}),
  };
}
