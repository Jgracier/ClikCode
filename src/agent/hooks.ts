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
 *   - UserPromptSubmit: exit 2 / `decision: "block"` refuses the prompt with
 *     the reason; plain stdout or `additionalContext` is added to it.
 *   - SessionStart (matcher: `startup` or `resume`): stdout or
 *     `additionalContext` is added to the first message.
 *   - Stop: exit 2 / `decision: "block"` keeps the agent working, the reason
 *     given to it; `stop_hook_active` is true on a turn a Stop hook continued.
 *   - SubagentStop (matcher: the agent type, `research` or `work`): the same,
 *     for a task/agent sub-agent about to hand its answer back.
 *   - PreCompact (matcher: `auto`; the agent compacts only itself, so never
 *     `manual`): runs before the conversation is compacted; cannot stop it.
 *   - Notification (matcher: `permission_prompt` or `idle_prompt`): the
 *     agent asks for approval, or ends its turn on a question to the user.
 *     Informational; it never delays the prompt.
 *   - SessionEnd is not fired: a conversation here has no end. A worker that
 *     exits (idle, a newer build) is replaced by the next turn's, which picks
 *     the same conversation up.
 *   - Any other exit is a hook error: reported, never blocking. */

import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { killProcessTreePortable } from '../harness/transport/spawn.js';
import type { HookInfo, ModelToolCall } from './model-client.js';
import { scrubEnvironment } from './security.js';
import { isWorkspaceTrusted, trustWorkspace } from './workspace-trust.js';
import type { ToolRunResult } from './tool-contract.js';

interface HookCommand { type?: string; command?: string; timeout?: number }
interface HookGroup { matcher?: string; hooks?: HookCommand[] }
type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart' | 'Stop' | 'SubagentStop' | 'PreCompact' | 'Notification';
const HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop', 'SubagentStop', 'PreCompact', 'Notification'];
export type HookConfig = Partial<Record<HookEvent, HookGroup[]>>;

/** ClikCode's tool names as Claude Code names them. MCP tools share Claude's `mcp__server__tool` form. */
const CLAUDE_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash', bash_output: 'BashOutput', kill_bash: 'KillShell',
  read_file: 'Read', write_file: 'Write', edit_file: 'Edit', multi_edit: 'MultiEdit',
  list_dir: 'LS', glob: 'Glob', grep: 'Grep',
  web_fetch: 'WebFetch', web_search: 'WebSearch',
  todo_write: 'TodoWrite', task: 'Task', skill: 'Skill', exit_plan_mode: 'ExitPlanMode',
  ask_user: 'AskUserQuestion', notebook_edit: 'NotebookEdit',
};

export function claudeToolName(name: string): string {
  return CLAUDE_TOOL_NAMES[name] ?? name;
}

/** Claude's argument names: a file tool's `path` is `file_path`. */
function claudeToolInput(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.path !== 'string') return args;
  const { path: filePath, ...rest } = args;
  if (name === 'notebook_edit') return { notebook_path: filePath, ...rest };
  if (!['read_file', 'write_file', 'edit_file', 'multi_edit'].includes(name)) return args;
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

/** The workspace's own settings files. They come with the repository, so
 * their hooks run only in a workspace the user trusts (workspace-trust.ts). */
function projectHookFiles(cwd: string): string[] {
  return [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
}

function userHookFile(home: string): string {
  return path.join(home, '.claude', 'settings.json');
}

async function mergeHookFiles(files: readonly string[]): Promise<HookConfig> {
  const merged: HookConfig = {};
  // A workspace that IS the home folder names the user file twice; its hooks run once.
  const unique = [...new Set(await Promise.all(files.map((file) => realpath(file).catch(() => path.resolve(file)))))];
  for (const config of await Promise.all(unique.map(readHookFile))) {
    for (const event of HOOK_EVENTS) {
      const groups = config?.[event];
      if (Array.isArray(groups)) merged[event] = [...(merged[event] ?? []), ...groups];
    }
  }
  return merged;
}

/** Every tool hook the user's Claude settings declare, merged in Claude's
 * order (user, project, local). The project's two files are read only when
 * `includeProject` says the workspace is trusted. */
export async function readClaudeHooks(cwd: string, home: string = homedir(), options: { includeProject?: boolean } = {}): Promise<HookConfig> {
  return mergeHookFiles([userHookFile(home), ...(options.includeProject ? projectHookFiles(cwd) : [])]);
}

/** The commands the workspace's own settings would run, for the trust
 * question. Empty when it declares none (or only repeats the user's file). */
export async function projectHookCommands(cwd: string, home: string = homedir()): Promise<string[]> {
  const user = await realpath(userHookFile(home)).catch(() => path.resolve(userHookFile(home)));
  const files: string[] = [];
  for (const file of projectHookFiles(cwd)) {
    if (await realpath(file).catch(() => path.resolve(file)) !== user) files.push(file);
  }
  const config = await mergeHookFiles(files);
  return HOOK_EVENTS.flatMap((event) => (config[event] ?? []).flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [])
    .flatMap((hook) => typeof hook?.command === 'string' && hook.command.trim() ? [`${event}: ${hook.command.trim()}`] : [])));
}

/** Workspaces whose hooks the user declined in this process: asked once, not every turn. */
const declinedWorkspaces = new Set<string>();

/** The hooks a turn in `cwd` runs. The user's own always; the workspace's
 * only once the user trusts it -- asked once through `ask` (a yes is
 * remembered in the state directory), and refused with a `notice` saying so
 * when nothing can ask. */
export async function hooksForWorkspace(options: {
  cwd: string; stateDir: string; home?: string;
  ask?: (title: string, detail: string) => Promise<boolean | 'always'>;
  notice: (message: string) => void;
}): Promise<HookConfig> {
  const home = options.home ?? homedir();
  const commands = await projectHookCommands(options.cwd, home);
  let trusted = commands.length > 0 && await isWorkspaceTrusted(options.stateDir, options.cwd);
  if (commands.length && !trusted && !declinedWorkspaces.has(path.resolve(options.cwd))) {
    const detail = [`${options.cwd}/.claude/settings*.json asks to run, with no approval, on every turn:`, ...commands.map((command) => `  ${command}`),
      '', 'Trust this workspace and run its hooks? Your own ~/.claude hooks run either way.'].join('\n');
    if (options.ask) {
      trusted = Boolean(await options.ask('Trust this workspace\'s hooks?', detail));
      if (trusted) await trustWorkspace(options.stateDir, options.cwd);
      else declinedWorkspaces.add(path.resolve(options.cwd));
    }
    if (!trusted) options.notice(`Not running ${commands.length} hook${commands.length === 1 ? '' : 's'} from this workspace's .claude settings: the workspace is not trusted${options.ask ? '' : ', and no one is here to approve it. Trust it from an interactive session'}.`);
  }
  return readClaudeHooks(options.cwd, home, { includeProject: trusted });
}

interface HookRun { code: number | null; stdout: string; stderr: string }

const HOOK_KILL_GRACE_MS = 2000;

/** Runs one hook in its own process group, with the same scrubbed
 * environment the bash tool gives a command, so a timeout or a cancelled turn
 * stops everything it started -- not just the shell. */
function runHookCommand(command: string, payload: unknown, cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<HookRun> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve({ code: null, stdout: '', stderr: 'turn cancelled before the hook ran' }); return; }
    const detached = process.platform !== 'win32';
    const child = spawn('sh', ['-c', command], { cwd, env: { ...scrubEnvironment(process.env), CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'], detached });
    let stdout = '';
    let stderr = '';
    const signalGroup = (name: NodeJS.Signals): void => {
      // The group outlives its shell when the shell exits first; signal it directly.
      if (detached && child.pid) { try { process.kill(-child.pid, name); return; } catch { /* group already gone */ } }
      killProcessTreePortable(child, name, detached);
    };
    const killGroup = (): void => {
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), HOOK_KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      killGroup();
      stderr += `\nhook timed out after ${timeoutSeconds}s`;
    }, timeoutSeconds * 1000);
    const onAbort = (): void => { killGroup(); stderr += '\nhook stopped: the turn was cancelled'; };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (run: HookRun): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(run); };
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-64_000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64_000); });
    child.on('error', (error) => done({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => done({ code, stdout, stderr }));
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

/** Context a hook adds: `hookSpecificOutput.additionalContext`, else plain stdout on exit 0. */
function addedContext(run: HookRun): string | undefined {
  if (run.code !== 0) return undefined;
  const text = run.stdout.trim();
  if (!text) return undefined;
  try {
    const out = JSON.parse(text) as { hookSpecificOutput?: { additionalContext?: string } };
    return out.hookSpecificOutput?.additionalContext?.trim() || undefined;
  } catch {
    // fail-open-ok: plain stdout is the context itself, as in Claude Code.
    return text;
  }
}

/** The loop's hooks for this config, or undefined when it declares none. */
export function toolHooksFrom(config: HookConfig, onError?: (message: string) => void): {
  preToolUse?(call: ModelToolCall, info: HookInfo): Promise<{ deny?: string } | void>;
  postToolUse?(call: ModelToolCall, result: ToolRunResult, info: HookInfo): Promise<{ output?: string } | void>;
  userPromptSubmit?(prompt: string, info: HookInfo): Promise<{ block?: string; context?: string } | void>;
  sessionStart?(info: HookInfo & { source: 'startup' | 'resume' }): Promise<{ context?: string } | void>;
  stop?(info: HookInfo & { stopHookActive: boolean }): Promise<{ continueWith?: string } | void>;
  subagentStop?(info: SubagentStopInfo): Promise<{ continueWith?: string } | void>;
  preCompact?(info: HookInfo & { trigger: 'auto' | 'manual' }): Promise<void>;
  notification?(info: NotificationInfo): Promise<void>;
} | undefined {
  const pre = config.PreToolUse ?? [];
  const post = config.PostToolUse ?? [];
  const submit = config.UserPromptSubmit ?? [];
  const start = config.SessionStart ?? [];
  const stop = config.Stop ?? [];
  const subagentStop = config.SubagentStop ?? [];
  const preCompact = config.PreCompact ?? [];
  const notify = config.Notification ?? [];
  if (![pre, post, submit, start, stop, subagentStop, preCompact, notify].some((groups) => groups.length)) return undefined;
  /** Every command hook of groups whose matcher names `subject`; `undefined`
   * ignores matchers (UserPromptSubmit and Stop have none in Claude Code). */
  const hooksOf = (groups: HookGroup[], subject?: string) =>
    commandsFor(subject === undefined ? groups.map((group) => ({ ...group, matcher: '' })) : groups, subject ?? '');
  const commandsFor = (groups: HookGroup[], tool: string) =>
    groups.filter((group) => hookMatches(group.matcher, tool)).flatMap((group) => group.hooks ?? [])
      .filter((hook) => (hook.type ?? 'command') === 'command' && typeof hook.command === 'string' && hook.command.trim());
  const run = async (event: HookEvent, hooks: HookCommand[], payload: Record<string, unknown>, cwd: string, signal?: AbortSignal) => {
    for (const hook of hooks) {
      const result = await runHookCommand(hook.command!, payload, cwd, Math.max(1, hook.timeout ?? 60), signal);
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
        }, info.cwd, info.signal);
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
        }, info.cwd, info.signal);
        return feedback ? { output: `${result.output}\n\n[PostToolUse hook] ${feedback}` } : undefined;
      },
    } : {}),
    ...(submit.length ? {
      async userPromptSubmit(prompt, info) {
        const contexts: string[] = [];
        for (const hook of hooksOf(submit)) {
          const outcome = await runHookCommand(hook.command!, { session_id: info.sessionId, cwd: info.cwd, hook_event_name: 'UserPromptSubmit', prompt }, info.cwd, Math.max(1, hook.timeout ?? 60), info.signal);
          const block = blockReason(outcome, 'UserPromptSubmit');
          if (block) return { block };
          const context = addedContext(outcome);
          if (context) contexts.push(context);
          else if (outcome.code !== 0) onError?.(`UserPromptSubmit hook \`${hook.command}\` failed (exit ${outcome.code ?? 'none'}): ${outcome.stderr.trim().slice(0, 300)}`);
        }
        return contexts.length ? { context: contexts.join('\n\n') } : undefined;
      },
    } : {}),
    ...(start.length ? {
      async sessionStart(info) {
        const contexts: string[] = [];
        for (const hook of hooksOf(start, info.source)) {
          const outcome = await runHookCommand(hook.command!, { session_id: info.sessionId, cwd: info.cwd, hook_event_name: 'SessionStart', source: info.source }, info.cwd, Math.max(1, hook.timeout ?? 60), info.signal);
          const context = addedContext(outcome);
          if (context) contexts.push(context);
          else if (outcome.code !== 0) onError?.(`SessionStart hook \`${hook.command}\` failed (exit ${outcome.code ?? 'none'}): ${outcome.stderr.trim().slice(0, 300)}`);
        }
        return contexts.length ? { context: contexts.join('\n\n') } : undefined;
      },
    } : {}),
    ...(stop.length ? {
      async stop(info) {
        for (const hook of hooksOf(stop)) {
          const outcome = await runHookCommand(hook.command!, { session_id: info.sessionId, cwd: info.cwd, hook_event_name: 'Stop', stop_hook_active: info.stopHookActive }, info.cwd, Math.max(1, hook.timeout ?? 60), info.signal);
          const reason = blockReason(outcome, 'Stop');
          if (reason) return { continueWith: reason };
          if (outcome.code !== 0) onError?.(`Stop hook \`${hook.command}\` failed (exit ${outcome.code ?? 'none'}): ${outcome.stderr.trim().slice(0, 300)}`);
        }
        return undefined;
      },
    } : {}),
    ...(subagentStop.length ? {
      async subagentStop(info) {
        const hooks = hooksOf(subagentStop, info.agentType);
        if (!hooks.length) return;
        const reason = await run('SubagentStop', hooks, {
          session_id: info.sessionId, cwd: info.cwd, hook_event_name: 'SubagentStop', stop_hook_active: info.stopHookActive,
          agent_id: info.agentId, agent_type: info.agentType, agent_transcript_path: info.agentTranscriptPath,
        }, info.cwd, info.signal);
        return reason ? { continueWith: reason } : undefined;
      },
    } : {}),
    ...(preCompact.length ? {
      async preCompact(info) {
        await notifyOnly('PreCompact', hooksOf(preCompact, info.trigger), {
          session_id: info.sessionId, cwd: info.cwd, hook_event_name: 'PreCompact', trigger: info.trigger, custom_instructions: '',
        }, info);
      },
    } : {}),
    ...(notify.length ? {
      async notification(info) {
        await notifyOnly('Notification', hooksOf(notify, info.notificationType), {
          session_id: info.sessionId, cwd: info.cwd, hook_event_name: 'Notification', message: info.message, notification_type: info.notificationType,
        }, info);
      },
    } : {}),
  };

  /** An event a hook can watch but not change: every matching hook runs, and
   * a failure is reported. */
  async function notifyOnly(event: HookEvent, hooks: HookCommand[], payload: Record<string, unknown>, info: HookInfo): Promise<void> {
    for (const hook of hooks) {
      const outcome = await runHookCommand(hook.command!, payload, info.cwd, Math.max(1, hook.timeout ?? 60), info.signal);
      if (outcome.code !== 0) onError?.(`${event} hook \`${hook.command}\` failed (exit ${outcome.code ?? 'none'}): ${outcome.stderr.trim().slice(0, 300)}`);
    }
  }
}

export type SubagentStopInfo = HookInfo & { stopHookActive: boolean; agentId: string; agentType: string; agentTranscriptPath: string };
export type NotificationInfo = HookInfo & { message: string; notificationType: 'permission_prompt' | 'idle_prompt' };
