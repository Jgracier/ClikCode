/** The optional OS sandbox around the bash tool's commands, after Claude
 * Code (bubblewrap / Seatbelt) and Codex (workspace-write). `workspace`
 * lets a command READ everything and reach the network, and WRITE only the
 * workspace, the temp dir and the caches builds and installs use. Off by
 * default; a missing sandbox binary runs the command unsandboxed with one
 * notice a session, never a failure. The argv builders are pure. */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SandboxMode = 'off' | 'workspace';
export const SANDBOX_MODES: readonly SandboxMode[] = ['off', 'workspace'];

/** `on` is what /sandbox takes; `workspace` is the mode's name. */
export function parseSandboxMode(value: string): SandboxMode | undefined {
  const word = value.trim().toLowerCase();
  if (word === 'on' || word === 'workspace') return 'workspace';
  if (word === 'off') return 'off';
  return undefined;
}

/** One line for /sandbox and its confirmation. */
export function sandboxModeText(mode: SandboxMode): string {
  return mode === 'workspace'
    ? 'Sandbox on · shell commands write only the workspace, the temp dir and tool caches; they read everything and keep the network'
    : 'Sandbox off · shell commands run with your full permissions';
}

/** Under home: the package-manager and toolchain caches an install or a
 * build writes. Read-only caches would fail most real work. */
const HOME_CACHE_DIRS = [
  '.cache', '.npm', '.pnpm-store', '.local/share/pnpm', '.local/state', '.yarn', '.bun', '.deno',
  '.cargo', '.rustup', 'go', '.gradle', '.m2', '.nuget', '.dotnet', '.composer', '.gem', '.bundle', 'Library/Caches',
];
/** Variables that move those caches somewhere else. */
const CACHE_ENV_VARS = [
  'TMPDIR', 'XDG_CACHE_HOME', 'npm_config_cache', 'PNPM_HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'GOMODCACHE', 'GOCACHE',
  'GRADLE_USER_HOME', 'PIP_CACHE_DIR', 'YARN_CACHE_FOLDER', 'BUN_INSTALL', 'DENO_DIR',
];

interface WritableInput {
  cwd: string;
  addDirs: readonly string[];
  homeDir: string;
  tmpDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** Every directory a sandboxed command may write, absolute and deduplicated.
 * Pure: the caller resolves symlinks (Seatbelt matches real paths). */
export function sandboxWritableDirs(input: WritableInput): string[] {
  const dirs = [
    input.cwd, ...input.addDirs, input.tmpDir, '/tmp',
    ...HOME_CACHE_DIRS.map((dir) => path.join(input.homeDir, dir)),
    ...CACHE_ENV_VARS.flatMap((name) => { const value = input.env[name]; return value && path.isAbsolute(value) ? [value] : []; }),
  ];
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

interface Invocation { file: string; args: string[] }

/** bwrap: the whole filesystem read-only, the writable dirs bound back
 * read-write (`--bind-try`: a cache that does not exist is skipped, not an
 * error), a private /dev and /proc. No --new-session and no pid namespace:
 * the command stays in the process group a timeout or cancel signals. */
export function bwrapInvocation(command: Invocation, writable: readonly string[], cwd: string): Invocation {
  return {
    file: 'bwrap',
    args: [
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      ...writable.flatMap((dir) => ['--bind-try', dir, dir]),
      '--die-with-parent', '--chdir', cwd, '--', command.file, ...command.args,
    ],
  };
}

/** Seatbelt: everything allowed but file writes, which go only to the
 * writable dirs and /dev (null, tty, fds). Paths travel as -D parameters, so
 * none has to be quoted into the profile text. */
export function seatbeltProfile(writableCount: number): string {
  const allowed = Array.from({ length: writableCount }, (_, index) => ` (subpath (param "W${index}"))`).join('');
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "/dev")${allowed})\n`;
}

export function sandboxExecInvocation(command: Invocation, writable: readonly string[]): Invocation {
  return {
    file: '/usr/bin/sandbox-exec',
    args: ['-p', seatbeltProfile(writable.length), ...writable.flatMap((dir, index) => ['-D', `W${index}=${dir}`]), command.file, ...command.args],
  };
}

interface WrapRequest {
  mode: SandboxMode;
  platform: NodeJS.Platform;
  command: Invocation;
  writable: readonly string[];
  cwd: string;
  /** Whether a sandbox binary is installed (an injected lookup, for tests). */
  available(binary: string): boolean;
}

export type SandboxWrap =
  | { sandboxed: true; invocation: Invocation }
  | { sandboxed: false; invocation: Invocation; missing?: string };

/** The command as it should be spawned. `missing` names the sandbox tool
 * that was wanted and is not there: the caller says so once and runs the
 * command as it is. */
export function wrapForSandbox(request: WrapRequest): SandboxWrap {
  if (request.mode !== 'workspace') return { sandboxed: false, invocation: request.command };
  if (request.platform === 'linux') {
    return request.available('bwrap')
      ? { sandboxed: true, invocation: bwrapInvocation(request.command, request.writable, request.cwd) }
      : { sandboxed: false, invocation: request.command, missing: 'bubblewrap (bwrap)' };
  }
  if (request.platform === 'darwin') {
    return request.available('/usr/bin/sandbox-exec')
      ? { sandboxed: true, invocation: sandboxExecInvocation(request.command, request.writable) }
      : { sandboxed: false, invocation: request.command, missing: 'sandbox-exec' };
  }
  return { sandboxed: false, invocation: request.command, missing: `a sandbox for ${request.platform}` };
}

export function sandboxMissingNotice(missing: string): string {
  return `[sandbox: ${missing} is not installed or cannot run here, so commands in this session run unsandboxed]`;
}

const DENIAL = /Read-only file system|EROFS|Operation not permitted|EPERM/;
/** Absolute paths named on a line, quoted or not. */
const PATHS = /(?:^|[\s'"`‘’:(])(\/[^\s'"`‘’:)]+)/g;

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** A one-line hint when a sandboxed command's failure reads like the sandbox
 * refusing a write: a denial message that does not name a path the sandbox
 * lets it write. Undefined for anything else. */
export function sandboxDenialHint(output: string, writable: readonly string[]): string | undefined {
  const denied = output.split('\n').some((line) => {
    if (!DENIAL.test(line)) return false;
    const named = [...line.matchAll(PATHS)].map((match) => match[1]!);
    return !named.length || named.some((entry) => !writable.some((root) => inside(entry, root)));
  });
  return denied ? '[sandbox: this looks like the workspace sandbox refusing a write outside the workspace. It may write only the workspace, the temp dir and tool caches; ask the user to approve running it unsandboxed (or /sandbox off) rather than working around it.]' : undefined;
}

// ── impure helpers for the bash tool ─────────────────────────────────────────

function onPath(binary: string): boolean {
  const candidates = path.isAbsolute(binary) ? [binary] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, binary));
  return candidates.some((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
}

/** bwrap can be installed and still unable to run: no user namespaces in a
 * container, or a distro policy against them. Tried once a process, so such
 * a machine gets the notice instead of every command failing. */
let bwrapRuns: boolean | undefined;
function sandboxAvailable(binary: string): boolean {
  if (!onPath(binary)) return false;
  if (binary !== 'bwrap') return true;
  bwrapRuns ??= spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', '/bin/true'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  return bwrapRuns;
}

function realOrSame(dir: string): string {
  try { return realpathSync.native(dir); } catch { return dir; }
}

/** wrapForSandbox with this machine's facts filled in. */
export function sandboxCommand(mode: SandboxMode, command: Invocation, scope: { cwd: string; addDirs: readonly string[]; homeDir: string }): SandboxWrap & { writable: string[] } {
  const writable = sandboxWritableDirs({ ...scope, tmpDir: os.tmpdir(), env: process.env }).map(realOrSame);
  return { ...wrapForSandbox({ mode, platform: process.platform, command, writable: [...new Set(writable)], cwd: scope.cwd, available: sandboxAvailable }), writable };
}
