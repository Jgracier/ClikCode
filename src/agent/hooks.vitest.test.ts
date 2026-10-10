import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeToolName, hookMatches, hooksForWorkspace, readClaudeHooks, toolHooksFrom } from './hooks.js';
import { isWorkspaceTrusted } from './workspace-trust.js';

async function workspaceWith(settings: unknown, local?: unknown) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'cc-hooks-'));
  const home = await mkdtemp(path.join(tmpdir(), 'cc-home-'));
  await mkdir(path.join(cwd, '.claude'), { recursive: true });
  await writeFile(path.join(cwd, '.claude', 'settings.json'), JSON.stringify(settings));
  if (local) await writeFile(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify(local));
  return { cwd, home };
}
const info = (cwd: string) => ({ sessionId: 's1', cwd });

describe('Claude Code hooks on ClikCode\'s own agent', () => {
  it('matches by Claude\'s tool names and regex matchers', () => {
    expect(claudeToolName('bash')).toBe('Bash');
    expect(claudeToolName('write_file')).toBe('Write');
    expect(claudeToolName('mcp__clikdeploy__list_apps')).toBe('mcp__clikdeploy__list_apps');
    expect(hookMatches('Bash|Write', 'Write')).toBe(true);
    expect(hookMatches('Write', 'WebFetch')).toBe(false);
    expect(hookMatches('', 'Anything')).toBe(true);
    expect(hookMatches('mcp__.*', 'mcp__clikdeploy__list_apps')).toBe(true);
  });

  it('blocks a call on exit 2 with the hook\'s reason, and hands the hook Claude\'s JSON', async () => {
    const { cwd, home } = await workspaceWith({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'cat > seen.json; echo "no rm -rf here" >&2; exit 2' }] }] } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }))!;
    const verdict = await hooks.preToolUse!({ id: 'c', name: 'bash', args: { command: 'rm -rf /' } }, info(cwd));
    expect(verdict).toEqual({ deny: 'no rm -rf here' });
    const seen = JSON.parse(await readFile(path.join(cwd, 'seen.json'), 'utf8'));
    expect(seen).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, session_id: 's1' });
    // A tool the matcher does not name runs no hook.
    expect(await hooks.preToolUse!({ id: 'd', name: 'read_file', args: { path: 'a' } }, info(cwd))).toBeUndefined();
  });

  it('blocks on a JSON deny decision, and passes a file tool\'s path as file_path', async () => {
    const { cwd, home } = await workspaceWith({}, { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ command: 'cat > seen.json; echo \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"protected file"}}\'' }] }] } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }))!;
    expect(await hooks.preToolUse!({ id: 'c', name: 'write_file', args: { path: '.env', content: 'x' } }, info(cwd))).toEqual({ deny: 'protected file' });
    expect(JSON.parse(await readFile(path.join(cwd, 'seen.json'), 'utf8')).tool_input).toEqual({ file_path: '.env', content: 'x' });
  });

  it('feeds a PostToolUse exit-2 message back to the model, and reports a failing hook without blocking', async () => {
    const errors: string[] = [];
    const { cwd, home } = await workspaceWith({ hooks: {
      PostToolUse: [{ matcher: 'Edit', hooks: [{ command: 'echo "lint: missing semicolon" >&2; exit 2' }] }],
      PreToolUse: [{ matcher: 'Read', hooks: [{ command: 'exit 1' }] }],
    } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }), (message) => errors.push(message))!;
    const after = await hooks.postToolUse!({ id: 'c', name: 'edit_file', args: { path: 'a.ts' } }, { output: 'edited' }, info(cwd));
    expect(after).toEqual({ output: 'edited\n\n[PostToolUse hook] lint: missing semicolon' });
    expect(await hooks.preToolUse!({ id: 'd', name: 'read_file', args: { path: 'a.ts' } }, info(cwd))).toBeUndefined();
    expect(errors[0]).toContain('exit 1');
  });

  it('declares nothing when no settings file has hooks', async () => {
    const { cwd, home } = await workspaceWith({ permissions: {} });
    expect(toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }))).toBeUndefined();
  });
});

describe('the prompt, session and stop hooks', () => {
  it('lets a UserPromptSubmit hook block a prompt or add context to it, ignoring matchers as Claude does', async () => {
    const { cwd, home } = await workspaceWith({ hooks: { UserPromptSubmit: [{ matcher: 'ignored', hooks: [{ command: 'grep -q secret && { echo "no secrets in prompts" >&2; exit 2; }; echo "branch: main"' }] }] } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }))!;
    expect(await hooks.userPromptSubmit!('here is my secret', info(cwd))).toEqual({ block: 'no secrets in prompts' });
    expect(await hooks.userPromptSubmit!('fix the bug', info(cwd))).toEqual({ context: 'branch: main' });
  });

  it('adds SessionStart context for a matching source only', async () => {
    const { cwd, home } = await workspaceWith({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ command: 'echo \'{"hookSpecificOutput":{"additionalContext":"on-call: ana"}}\'' }] }] } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }))!;
    expect(await hooks.sessionStart!({ ...info(cwd), source: 'startup' })).toEqual({ context: 'on-call: ana' });
    expect(await hooks.sessionStart!({ ...info(cwd), source: 'resume' })).toBeUndefined();
  });

  it('lets a Stop hook send the agent back to work, and tells it when it already did', async () => {
    const { cwd, home } = await workspaceWith({ hooks: { Stop: [{ hooks: [{ command: 'grep -q \'"stop_hook_active":true\' && exit 0; echo "tests are not run yet" >&2; exit 2' }] }] } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }))!;
    expect(await hooks.stop!({ ...info(cwd), stopHookActive: false })).toEqual({ continueWith: 'tests are not run yet' });
    expect(await hooks.stop!({ ...info(cwd), stopHookActive: true })).toBeUndefined();
  });
});

describe('the sub-agent, compaction and notification hooks', () => {
  it('lets a SubagentStop hook matching the agent type send a sub-agent back, with Claude\'s fields', async () => {
    const { cwd, home } = await workspaceWith({ hooks: { SubagentStop: [{ matcher: 'work', hooks: [{ command: 'cat > seen.json; echo "check the diff" >&2; exit 2' }] }] } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }))!;
    const stop = { ...info(cwd), stopHookActive: false, agentId: 's1.task.x', agentTranscriptPath: '/t/x.jsonl' };
    expect(await hooks.subagentStop!({ ...stop, agentType: 'work' })).toEqual({ continueWith: 'check the diff' });
    expect(JSON.parse(await readFile(path.join(cwd, 'seen.json'), 'utf8'))).toEqual({
      session_id: 's1', cwd, hook_event_name: 'SubagentStop', stop_hook_active: false,
      agent_id: 's1.task.x', agent_type: 'work', agent_transcript_path: '/t/x.jsonl',
    });
    expect(await hooks.subagentStop!({ ...stop, agentType: 'research' })).toBeUndefined();
  });

  it('runs PreCompact hooks for the auto trigger, and never lets them stop compaction', async () => {
    const errors: string[] = [];
    const { cwd, home } = await workspaceWith({ hooks: { PreCompact: [
      { matcher: 'auto', hooks: [{ command: 'cat > seen.json; exit 2' }] },
      { matcher: 'manual', hooks: [{ command: 'touch manual.txt' }] },
    ] } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }), (message) => errors.push(message))!;
    await expect(hooks.preCompact!({ ...info(cwd), trigger: 'auto' })).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(path.join(cwd, 'seen.json'), 'utf8'))).toEqual({ session_id: 's1', cwd, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' });
    await expect(readFile(path.join(cwd, 'manual.txt'))).rejects.toThrow();
    expect(errors[0]).toMatch(/PreCompact hook .* failed \(exit 2\)/);
  });

  it('hands a Notification hook the message and type, matched by type', async () => {
    const { cwd, home } = await workspaceWith({ hooks: { Notification: [{ matcher: 'permission_prompt', hooks: [{ command: 'cat >> seen.jsonl; echo >> seen.jsonl' }] }] } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }))!;
    await hooks.notification!({ ...info(cwd), message: 'ClikCode needs your permission to use Bash', notificationType: 'permission_prompt' });
    await hooks.notification!({ ...info(cwd), message: 'Which database?', notificationType: 'idle_prompt' });
    const seen = (await readFile(path.join(cwd, 'seen.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(seen).toEqual([{ session_id: 's1', cwd, hook_event_name: 'Notification', message: 'ClikCode needs your permission to use Bash', notification_type: 'permission_prompt' }]);
  });

  it('counts a config with only these events as declaring hooks', async () => {
    const { cwd, home } = await workspaceWith({ hooks: { Notification: [{ hooks: [{ command: 'true' }] }] } });
    expect(toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }))?.notification).toBeDefined();
  });
});

describe('workspace trust', () => {
  const projectHook = { hooks: { UserPromptSubmit: [{ hooks: [{ command: 'touch ran.txt' }] }] } };

  it('never reads a project\'s hooks unless asked to', async () => {
    const { cwd, home } = await workspaceWith(projectHook);
    expect(toolHooksFrom(await readClaudeHooks(cwd, home))).toBeUndefined();
  });

  it('refuses an untrusted workspace\'s hooks with a notice when no one can be asked', async () => {
    const { cwd, home } = await workspaceWith(projectHook);
    const stateDir = await mkdtemp(path.join(tmpdir(), 'cc-state-'));
    const notices: string[] = [];
    const config = await hooksForWorkspace({ cwd, home, stateDir, notice: (message) => notices.push(message) });
    expect(toolHooksFrom(config)).toBeUndefined();
    expect(notices[0]).toMatch(/not trusted/);
    expect(await isWorkspaceTrusted(stateDir, cwd)).toBe(false);
  });

  it('asks once, remembers a yes, and then runs them without asking', async () => {
    const { cwd, home } = await workspaceWith(projectHook);
    const stateDir = await mkdtemp(path.join(tmpdir(), 'cc-state-'));
    const asked: string[] = [];
    const ask = async (_title: string, detail: string) => { asked.push(detail); return true; };
    const first = await hooksForWorkspace({ cwd, home, stateDir, ask, notice: () => undefined });
    expect(asked[0]).toContain('touch ran.txt');
    expect(toolHooksFrom(first)?.userPromptSubmit).toBeDefined();
    await hooksForWorkspace({ cwd, home, stateDir, ask, notice: () => undefined });
    expect(asked).toHaveLength(1);
  });

  it('does not ask again in the same process after a no', async () => {
    const { cwd, home } = await workspaceWith(projectHook);
    const stateDir = await mkdtemp(path.join(tmpdir(), 'cc-state-'));
    let asked = 0;
    const ask = async () => { asked += 1; return false; };
    expect(toolHooksFrom(await hooksForWorkspace({ cwd, home, stateDir, ask, notice: () => undefined }))).toBeUndefined();
    expect(toolHooksFrom(await hooksForWorkspace({ cwd, home, stateDir, ask, notice: () => undefined }))).toBeUndefined();
    expect(asked).toBe(1);
  });

  it('runs the user\'s own hooks once when the workspace is the home folder', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'cc-home-'));
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'true' }] }] } }));
    const stateDir = await mkdtemp(path.join(tmpdir(), 'cc-state-'));
    let asked = 0;
    const config = await hooksForWorkspace({ cwd: home, home, stateDir, ask: async () => { asked += 1; return true; }, notice: () => undefined });
    expect(asked).toBe(0);
    expect(config.Stop).toHaveLength(1);
  });
});

describe('hook processes', () => {
  it('scrubs credentials from the hook\'s environment, as the bash tool does', async () => {
    const { cwd, home } = await workspaceWith({ hooks: { UserPromptSubmit: [{ hooks: [{ command: 'echo "key=${OPENAI_API_KEY:-none} dir=${CLAUDE_PROJECT_DIR:+set}"' }] }] } });
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-should-not-leak';
    try {
      const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }))!;
      expect(await hooks.userPromptSubmit!('hi', info(cwd))).toEqual({ context: 'key=none dir=set' });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('kills the whole process group on timeout, not just the shell', async () => {
    const { cwd, home } = await workspaceWith({ hooks: { Stop: [{ hooks: [{ command: '(sleep 3; touch orphan.txt) & sleep 30', timeout: 1 }] }] } });
    const errors: string[] = [];
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }), (message) => errors.push(message))!;
    const started = Date.now();
    expect(await hooks.stop!({ ...info(cwd), stopHookActive: false })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(errors[0]).toContain('timed out');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await expect(readFile(path.join(cwd, 'orphan.txt'))).rejects.toThrow();
  }, 15_000);

  it('stops a running hook when the turn is cancelled', async () => {
    const { cwd, home } = await workspaceWith({ hooks: { Stop: [{ hooks: [{ command: 'sleep 30' }] }] } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home, { includeProject: true }), () => undefined)!;
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    await hooks.stop!({ ...info(cwd), signal: controller.signal, stopHookActive: false });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
