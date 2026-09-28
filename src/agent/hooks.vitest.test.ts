import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeToolName, hookMatches, readClaudeHooks, toolHooksFrom } from './hooks.js';

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
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home))!;
    const verdict = await hooks.preToolUse!({ id: 'c', name: 'bash', args: { command: 'rm -rf /' } }, info(cwd));
    expect(verdict).toEqual({ deny: 'no rm -rf here' });
    const seen = JSON.parse(await readFile(path.join(cwd, 'seen.json'), 'utf8'));
    expect(seen).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, session_id: 's1' });
    // A tool the matcher does not name runs no hook.
    expect(await hooks.preToolUse!({ id: 'd', name: 'read_file', args: { path: 'a' } }, info(cwd))).toBeUndefined();
  });

  it('blocks on a JSON deny decision, and passes a file tool\'s path as file_path', async () => {
    const { cwd, home } = await workspaceWith({}, { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ command: 'cat > seen.json; echo \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"protected file"}}\'' }] }] } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home))!;
    expect(await hooks.preToolUse!({ id: 'c', name: 'write_file', args: { path: '.env', content: 'x' } }, info(cwd))).toEqual({ deny: 'protected file' });
    expect(JSON.parse(await readFile(path.join(cwd, 'seen.json'), 'utf8')).tool_input).toEqual({ file_path: '.env', content: 'x' });
  });

  it('feeds a PostToolUse exit-2 message back to the model, and reports a failing hook without blocking', async () => {
    const errors: string[] = [];
    const { cwd, home } = await workspaceWith({ hooks: {
      PostToolUse: [{ matcher: 'Edit', hooks: [{ command: 'echo "lint: missing semicolon" >&2; exit 2' }] }],
      PreToolUse: [{ matcher: 'Read', hooks: [{ command: 'exit 1' }] }],
    } });
    const hooks = toolHooksFrom(await readClaudeHooks(cwd, home), (message) => errors.push(message))!;
    const after = await hooks.postToolUse!({ id: 'c', name: 'edit_file', args: { path: 'a.ts' } }, { output: 'edited' }, info(cwd));
    expect(after).toEqual({ output: 'edited\n\n[PostToolUse hook] lint: missing semicolon' });
    expect(await hooks.preToolUse!({ id: 'd', name: 'read_file', args: { path: 'a.ts' } }, info(cwd))).toBeUndefined();
    expect(errors[0]).toContain('exit 1');
  });

  it('declares nothing when no settings file has hooks', async () => {
    const { cwd, home } = await workspaceWith({ permissions: {} });
    expect(toolHooksFrom(await readClaudeHooks(cwd, home))).toBeUndefined();
  });
});
