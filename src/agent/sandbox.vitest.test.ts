import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bwrapInvocation, parseSandboxMode, sandboxDenialHint, sandboxExecInvocation, sandboxWritableDirs, seatbeltProfile, wrapForSandbox,
} from './sandbox.js';
import { bashTool } from './tools/bash.js';
import { disposeSessionState, sessionState } from './session-state.js';
import type { ToolContext } from './tool-contract.js';
import { runGatewayHarnessTurn } from './run-turn.js';
import { ScriptedModelClient } from './testing.js';
import type { AiHarnessPermissionMode } from '../harness/definition.js';

const shell = { file: '/bin/bash', args: ['-c', 'echo hi'] };
const writable = ['/work', '/tmp', '/home/u/.cache'];

describe('sandbox argv', () => {
  it('bwrap: root read-only, writable dirs bound back, private /dev and /proc, the command last', () => {
    const { file, args } = bwrapInvocation(shell, writable, '/work');
    expect(file).toBe('bwrap');
    expect(args).toEqual([
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      '--bind-try', '/work', '/work', '--bind-try', '/tmp', '/tmp', '--bind-try', '/home/u/.cache', '/home/u/.cache',
      '--die-with-parent', '--chdir', '/work', '--', '/bin/bash', '-c', 'echo hi',
    ]);
    // Network stays on, and the command stays in its process group.
    expect(args).not.toContain('--unshare-net');
    expect(args).not.toContain('--new-session');
    expect(args).not.toContain('--unshare-pid');
  });

  it('sandbox-exec: writes denied except /dev and each dir, passed as parameters', () => {
    const { file, args } = sandboxExecInvocation(shell, writable);
    expect(file).toBe('/usr/bin/sandbox-exec');
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe(seatbeltProfile(3));
    expect(args[1]).toContain('(deny file-write*)');
    expect(args[1]).toContain('(subpath (param "W2"))');
    expect(args[1]).not.toContain('network');
    expect(args.slice(2)).toEqual(['-D', 'W0=/work', '-D', 'W1=/tmp', '-D', 'W2=/home/u/.cache', '/bin/bash', '-c', 'echo hi']);
  });

  it('writable dirs: workspace, added dirs, temp, caches, and cache variables', () => {
    const dirs = sandboxWritableDirs({ cwd: '/work', addDirs: ['/other'], homeDir: '/home/u', tmpDir: '/var/tmp/x', env: { CARGO_HOME: '/opt/cargo', GOPATH: 'relative' } });
    expect(dirs.slice(0, 4)).toEqual(['/work', '/other', '/var/tmp/x', '/tmp']);
    for (const dir of ['/home/u/.cache', '/home/u/.npm', '/home/u/.pnpm-store', '/home/u/.cargo', '/home/u/.local/share/pnpm', '/home/u/go', '/opt/cargo']) expect(dirs).toContain(dir);
    expect(dirs).not.toContain('relative');
    expect(dirs).not.toContain('/home/u');
  });

  it('off passes the command through; a missing tool runs it unsandboxed and names the tool', () => {
    const base = { command: shell, writable, cwd: '/work', available: () => true };
    expect(wrapForSandbox({ ...base, mode: 'off', platform: 'linux' })).toEqual({ sandboxed: false, invocation: shell });
    expect(wrapForSandbox({ ...base, mode: 'workspace', platform: 'linux' }).invocation.file).toBe('bwrap');
    expect(wrapForSandbox({ ...base, mode: 'workspace', platform: 'darwin' }).invocation.file).toBe('/usr/bin/sandbox-exec');
    expect(wrapForSandbox({ ...base, mode: 'workspace', platform: 'linux', available: () => false })).toEqual({ sandboxed: false, invocation: shell, missing: 'bubblewrap (bwrap)' });
    expect(wrapForSandbox({ ...base, mode: 'workspace', platform: 'win32' })).toMatchObject({ sandboxed: false, invocation: shell });
  });

  it('parses on, workspace and off', () => {
    expect(parseSandboxMode('on')).toBe('workspace');
    expect(parseSandboxMode('Workspace')).toBe('workspace');
    expect(parseSandboxMode('off')).toBe('off');
    expect(parseSandboxMode('maybe')).toBeUndefined();
  });
});

describe('the denial hint', () => {
  it('names a refused write outside the writable dirs', () => {
    expect(sandboxDenialHint("touch: cannot touch '/home/u/x': Read-only file system\n\n[exit code 1]", writable)).toMatch(/^\[sandbox: /);
    expect(sandboxDenialHint("OSError: [Errno 30] Read-only file system: '/etc/x'", writable)).toBeDefined();
    expect(sandboxDenialHint('mkdir: Read-only file system', writable)).toBeDefined();
    expect(sandboxDenialHint('Operation not permitted', writable)).toBeDefined();
  });

  it('stays quiet for other failures and for a denial inside the workspace', () => {
    expect(sandboxDenialHint('error TS2304: Cannot find name x\n[exit code 2]', writable)).toBeUndefined();
    expect(sandboxDenialHint("chmod: changing permissions of '/work/a': Operation not permitted", writable)).toBeUndefined();
  });
});

function contextFor(dir: string, extra: Partial<ToolContext> = {}): ToolContext {
  const sessionId = `sandbox-${Math.random()}`;
  return {
    cwd: dir, addDirs: [], sessionId, turnId: 't', stateDir: dir, homeDir: homedir(),
    checkpoints: {} as ToolContext['checkpoints'], session: sessionState(dir, sessionId), sandbox: 'workspace', ...extra,
  } as ToolContext;
}

describe.skipIf(process.platform !== 'linux')('a missing sandbox tool', () => {
  let dir: string;
  const path = process.env.PATH;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-sandbox-missing-')); process.env.PATH = '/nonexistent-clikcode-path'; });
  afterEach(async () => { process.env.PATH = path; await rm(dir, { recursive: true, force: true }); });

  it('runs the command unsandboxed and says so once a session', async () => {
    const ctx = contextFor(dir);
    const first = await bashTool.run({ command: 'echo one' }, ctx);
    expect(first.isError).toBeFalsy();
    expect(first.output).toBe('[sandbox: bubblewrap (bwrap) is not installed, so commands in this session run unsandboxed]\none');
    expect((await bashTool.run({ command: 'echo two' }, ctx)).output).toBe('two');
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
  });
});

const hasBwrap = process.platform === 'linux' && (() => { try { execFileSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }); return true; } catch { return false; } })();
// The tests' HOME is a temp dir, which the sandbox lets commands write; the
// checkout is somewhere it does not (unless it sits in the temp dir too).
const outsideRoot = process.cwd();
const outsideIsWritable = outsideRoot.startsWith(tmpdir()) || outsideRoot.startsWith('/tmp');

describe.skipIf(!hasBwrap || outsideIsWritable)('bwrap, for real', () => {
  let dir: string;
  let outside: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-sandbox-real-'));
    outside = join(outsideRoot, `.clikcode-sandbox-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); await rm(outside, { force: true }); });

  it('writes inside the workspace, refuses a write outside it with the hint, and runs plain commands', async () => {
    const ctx = contextFor(dir);
    const inside = await bashTool.run({ command: 'echo hello && echo data > inside.txt && cat inside.txt' }, ctx);
    expect(inside).toMatchObject({ isError: false, output: 'hello\ndata' });
    const refused = await bashTool.run({ command: `touch ${outside}` }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.output).toMatch(/Read-only file system/);
    expect(refused.output).toMatch(/\n\[sandbox: this looks like the workspace sandbox refusing a write/);
    expect(existsSync(outside)).toBe(false);
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
  });

  it('runs a refused command again outside the sandbox once the user approves', async () => {
    const asked: string[] = [];
    const ctx = contextFor(dir, { approveUnsandboxed: async (command) => { asked.push(command); return true; } });
    const result = await bashTool.run({ command: `touch ${outside}` }, ctx);
    expect(asked).toEqual([`touch ${outside}`]);
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/^\[sandbox: refused inside the sandbox; run again outside it/);
    expect(existsSync(outside)).toBe(true);
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
  });

  it('a background shell is sandboxed too', async () => {
    const ctx = contextFor(dir);
    await bashTool.run({ command: `touch ${outside}; echo done > bg.txt`, run_in_background: true }, ctx);
    for (let i = 0; i < 50 && !existsSync(join(dir, 'bg.txt')); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(join(dir, 'bg.txt'))).toBe(true);
    expect(existsSync(outside)).toBe(false);
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
  });
});

describe.skipIf(!hasBwrap || outsideIsWritable)('the sandbox in a turn', () => {
  let dir: string;
  let outside: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-sandbox-turn-'));
    outside = join(outsideRoot, `.clikcode-sandbox-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); await rm(outside, { force: true }); });

  const turn = async (permissionMode: AiHarnessPermissionMode) => {
    const asked: string[] = [];
    const client = new ScriptedModelClient([{ toolCalls: [{ id: 'b', name: 'bash', args: { command: `touch ${outside}` } }] }, { text: 'ok' }]);
    await runGatewayHarnessTurn({
      sessionId: `sandbox-turn-${Math.random()}`, cwd: dir, stateDir: dir, homeDir: dir, userConfigDir: dir, prompt: 'go',
      permissionMode, modelClient: client, sandbox: 'workspace',
      onApproval: async (title) => { asked.push(title); return true; },
    });
    const sent = client.requests[1]!.items.at(-1)!;
    return { asked, result: sent.type === 'tool_result' ? sent.output : '' };
  };

  it('in ask mode, offers to run the refused command outside the sandbox', async () => {
    const { asked, result } = await turn('ask');
    expect(asked).toEqual(['Approve command', 'Run outside the sandbox?']);
    expect(result).toMatch(/^\[sandbox: refused inside the sandbox; run again outside it/);
    expect(existsSync(outside)).toBe(true);
  });

  it('in bypass mode, asks nothing and gives the model the hint', async () => {
    const { asked, result } = await turn('bypass');
    expect(asked).toEqual([]);
    expect(result).toMatch(/Read-only file system[\s\S]*\[sandbox: this looks like the workspace sandbox/);
    expect(existsSync(outside)).toBe(false);
  });
});
