import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bwrapInvocation, parseSandboxMode, SANDBOX_DENIAL_HINT, sandboxCommand, sandboxDenialHint, sandboxExecInvocation, sandboxWritableDirs, seatbeltProfile, sessionSandboxMode, wrapForSandbox,
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
    // Binaries and config stay read-only; buildx state does not.
    for (const dir of ['/home/u/.bun', '/home/u/.deno', '/home/u/.docker/buildx', '/home/u/.local/share/uv']) expect(dirs).toContain(dir);
    for (const dir of ['/home/u/.local/bin', '/home/u/.config', '/home/u/.docker', '/home/u/.ssh']) expect(dirs).not.toContain(dir);
  });

  it("adds the platform's own temp and cache dirs", () => {
    const dirs = sandboxWritableDirs({ cwd: '/work', addDirs: [], homeDir: '/Users/u', tmpDir: '/tmp', env: {}, platformDirs: ['/var/folders/ab/xy/T/', '/var/folders/ab/xy/C/'] });
    expect(dirs).toContain('/var/folders/ab/xy/T');
    expect(dirs).toContain('/var/folders/ab/xy/C');
  });

  it('resolves links, through the nearest existing ancestor for a cache not made yet, and keeps the named form for the hint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-sandbox-links-'));
    try {
      await mkdir(join(root, 'real home'));
      await symlink(join(root, 'real home'), join(root, 'home'));
      const real = realpathSync(join(root, 'real home'));
      const { writable } = sandboxCommand('workspace', shell, { cwd: join(root, 'home'), addDirs: [], homeDir: join(root, 'home') });
      expect(writable).toContain(real);
      expect(writable).toContain(join(real, '.npm'));
      expect(writable).toContain(join(root, 'home', '.npm'));
      expect(sandboxDenialHint(`chmod: ${join(root, 'home', 'a')}: Operation not permitted`, writable)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('off passes the command through; a missing tool runs it unsandboxed and names the tool', () => {
    const base = { command: shell, writable, cwd: '/work', available: () => true };
    expect(wrapForSandbox({ ...base, mode: 'off', platform: 'linux' })).toEqual({ sandboxed: false, invocation: shell });
    expect(wrapForSandbox({ ...base, mode: 'workspace', platform: 'linux' }).invocation.file).toBe('bwrap');
    expect(wrapForSandbox({ ...base, mode: 'workspace', platform: 'darwin' }).invocation.file).toBe('/usr/bin/sandbox-exec');
    expect(wrapForSandbox({ ...base, mode: 'workspace', platform: 'linux', available: () => false })).toEqual({ sandboxed: false, invocation: shell, missing: 'bubblewrap (bwrap)' });
    expect(wrapForSandbox({ ...base, mode: 'workspace', platform: 'win32' })).toMatchObject({ sandboxed: false, invocation: shell });
  });

  it('is on unless the session explicitly turned it off', () => {
    expect(sessionSandboxMode(undefined)).toBe('workspace');
    expect(sessionSandboxMode('workspace')).toBe('workspace');
    expect(sessionSandboxMode('off')).toBe('off');
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

  it('tells the model it can rerun with sandbox: false', () => {
    expect(sandboxDenialHint('Read-only file system', writable)).toBe(SANDBOX_DENIAL_HINT);
    expect(SANDBOX_DENIAL_HINT).toContain('run it again with sandbox: false');
    expect(SANDBOX_DENIAL_HINT).not.toMatch(/ask the user/);
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
    expect(first.output).toBe('[sandbox: bubblewrap (bwrap) is not installed or cannot run here, so commands in this session run unsandboxed]\none');
    expect((await bashTool.run({ command: 'echo two' }, ctx)).output).toBe('two');
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
  });
});

const onPath = (binary: string): boolean => { try { execFileSync('sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const hasSandbox = (process.platform === 'linux' && onPath('bwrap')) || (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'));
const hasDocker = onPath('docker');
// The tests' HOME is a temp dir, which the sandbox lets commands write; the
// checkout is somewhere it does not (unless it sits in a temp dir too, as a
// macOS checkout under /var/folders does: CLIKCODE_SANDBOX_TEST_OUTSIDE then
// names a dir outside the sandbox, such as one made under /var/tmp).
const outsideRoot = realpathSync(process.env.CLIKCODE_SANDBOX_TEST_OUTSIDE || process.cwd());
const outsideIsWritable = sandboxCommand('workspace', shell, { cwd: '/nonexistent-clikcode-workspace', addDirs: [], homeDir: homedir() }).writable
  .some((dir) => outsideRoot === dir || outsideRoot.startsWith(`${dir}/`));
/** bwrap's read-only bind and Seatbelt's deny say it differently. */
const REFUSED = process.platform === 'darwin' ? 'Operation not permitted' : 'Read-only file system';

describe.skipIf(!hasSandbox || outsideIsWritable)('the sandbox, for real', () => {
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
    expect(refused.output).toContain(REFUSED);
    expect(refused.output).toMatch(/\n\[sandbox: this looks like the workspace sandbox refusing a write/);
    expect(existsSync(outside)).toBe(false);
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
  });

  it('sandbox: false runs that one command outside it', async () => {
    const ctx = contextFor(dir);
    const result = await bashTool.run({ command: `touch ${outside}`, sandbox: false }, ctx);
    expect(result).toMatchObject({ isError: false, output: '(no output)' });
    expect(existsSync(outside)).toBe(true);
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
  });

  it('keeps /dev/null, git and the docker socket working', async () => {
    const ctx = contextFor(dir);
    const result = await bashTool.run({ command: 'echo x > /dev/null && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x && echo ok' }, ctx);
    expect(result).toMatchObject({ isError: false, output: 'ok' });
    if (hasDocker && existsSync('/var/run/docker.sock')) {
      // A unix-socket connect is not a file write: the read-only bind allows it.
      const probe = 'docker version --format "{{.Server.Version}}" >/dev/null 2>&1 && echo reached || echo unreachable';
      const docker = await bashTool.run({ command: probe }, ctx);
      expect(docker.output).toBe(execFileSync('sh', ['-c', probe]).toString().trim());
    }
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
  });

  it('reads the system and kills a background child', async () => {
    const ctx = contextFor(dir);
    const result = await bashTool.run({ command: 'head -c 1 /etc/hosts >/dev/null; sleep 30 & p=$!; kill $p; wait $p; echo killed=$?' }, ctx);
    expect(result).toMatchObject({ isError: false, output: expect.stringContaining('killed=143') });
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
  });

  it.skipIf(process.platform !== 'darwin')('macOS: the per-user temp and cache dirs, with or without TMPDIR, and a workspace named through /tmp', async () => {
    const ctx = contextFor(dir);
    const saved = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const probe = 'f=$(mktemp) && rm "$f" && c=$(getconf DARWIN_USER_CACHE_DIR)clikcode-sandbox-$$ && echo x > "$c" && rm "$c" && echo ok';
      expect(await bashTool.run({ command: probe }, ctx)).toMatchObject({ isError: false, output: 'ok' });
    } finally {
      process.env.TMPDIR = saved;
    }
    const viaTmp = await mkdtemp('/tmp/clikcode-sandbox-ws-');
    try {
      const tmpCtx = contextFor(viaTmp);
      expect(await bashTool.run({ command: 'echo hi > f && cat f && touch /tmp/clikcode-sandbox-$$ && rm /tmp/clikcode-sandbox-$$' }, tmpCtx)).toMatchObject({ isError: false, output: 'hi' });
      disposeSessionState(viaTmp, tmpCtx.session.sessionId, 'test over');
    } finally {
      await rm(viaTmp, { recursive: true, force: true });
    }
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

describe.skipIf(!hasSandbox || outsideIsWritable)('the sandbox in a turn', () => {
  let dir: string;
  let outside: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-sandbox-turn-'));
    outside = join(outsideRoot, `.clikcode-sandbox-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); await rm(outside, { force: true }); });

  const turn = async (permissionMode: AiHarnessPermissionMode, args: Record<string, unknown> = {}, extra: { planMode?: boolean } = {}) => {
    const asked: { title: string; detail?: string }[] = [];
    const client = new ScriptedModelClient([{ toolCalls: [{ id: 'b', name: 'bash', args: { command: `touch ${outside}`, ...args } }] }, { text: 'ok' }]);
    await runGatewayHarnessTurn({
      sessionId: `sandbox-turn-${Math.random()}`, cwd: dir, stateDir: dir, homeDir: dir, userConfigDir: dir, prompt: 'go',
      permissionMode, modelClient: client, sandbox: 'workspace', ...extra,
      onApproval: async (title, detail) => { asked.push({ title, ...(detail ? { detail } : {}) }); return true; },
    });
    const sent = client.requests[1]!.items.at(-1)!;
    return { asked, result: sent.type === 'tool_result' ? sent.output : '' };
  };

  it('a refused write gets the model the hint, in every mode, and no extra question', async () => {
    for (const mode of ['ask', 'auto', 'bypass'] as const) {
      const { asked, result } = await turn(mode);
      expect(asked.map((entry) => entry.title).filter((title) => title !== 'Approve command')).toEqual([]);
      expect(result).toContain(REFUSED);
      expect(result).toMatch(/\[sandbox: this looks like the workspace sandbox[\s\S]*sandbox: false/);
      expect(existsSync(outside)).toBe(false);
    }
  });

  it('ask: sandbox: false is the one ordinary approval, which says it runs outside', async () => {
    const { asked } = await turn('ask', { sandbox: false });
    expect(asked.map((entry) => entry.title)).toEqual(['Approve command']);
    expect(asked[0]!.detail).toMatch(/runs outside the sandbox/);
    expect(existsSync(outside)).toBe(true);
  });

  it('auto: sandbox: false asks nothing the same command would not already ask', async () => {
    const sandboxed = await turn('auto');
    const unsandboxed = await turn('auto', { sandbox: false });
    expect(unsandboxed.asked.map((entry) => entry.title)).toEqual(sandboxed.asked.map((entry) => entry.title));
    expect(existsSync(outside)).toBe(true);
  });

  it('bypass: sandbox: false runs outside without asking', async () => {
    const { asked, result } = await turn('bypass', { sandbox: false });
    expect(asked).toEqual([]);
    expect(result).not.toMatch(/\[sandbox:/);
    expect(existsSync(outside)).toBe(true);
  });

  it('plan: sandbox: false is refused, as every command is', async () => {
    const { asked, result } = await turn('bypass', { sandbox: false }, { planMode: true });
    expect(asked).toEqual([]);
    expect(result).toMatch(/plan mode is active/);
    expect(existsSync(outside)).toBe(false);
  });
});
