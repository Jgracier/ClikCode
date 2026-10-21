/** Installing ClikCode on another machine, over SSH, from GitHub main.
 *
 * Nothing is copied from this machine -- no credentials, accounts or
 * settings. The other machine gets a fresh ClikCode of its own, built from
 * the public repository, and signs in from scratch in its own chats. This
 * machine needs nothing new; the other one needs only git (and gets a
 * user-local Node if it has none new enough). Nothing runs with sudo.
 *
 *   1. probe     what the machine is: OS, git, Node, $HOME
 *   2. Node      a user-local Node.js from nodejs.org when there is none
 *                >= 22.12, its SHA-256 checked against SHASUMS256.txt
 *   3. git       required; missing, the install stops with how to get it
 *   4. source    a shallow clone of main into ~/.local/share/clikcode/src,
 *                or a fetch and hard reset of the one already there to main
 *                or a chosen commit -- that directory is ClikCode's own
 *   5. build     `pnpm install --frozen-lockfile`, then `pnpm run
 *                install-local` (scripts/install-local.mjs)
 *   6. verify    `~/.local/bin/clikcode --version` and its `remote-info`
 *
 * Steps 4-6 are also the whole of an update, and the same scripts run on
 * this machine for /update of a Remote-installed ClikCode (runManagedUpdate
 * with localRunner; remote/self-update.ts). Every step is one command; its
 * script quotes every value it did not write itself (shell.ts). */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { runSsh, sshFailure, sshFailureMessage, type SshResult } from './ssh.js';
import { shellQuote } from './shell.js';

export const REMOTE_REPO_URL = 'https://github.com/Jgracier/ClikCode.git';
export const NODE_MIRROR = 'https://nodejs.org/dist';
/** The Node line installed when a machine has none new enough. */
export const NODE_LINE = 'latest-v24.x';
/** package.json `engines.node`. */
export const MIN_NODE: readonly [number, number] = [22, 12];
/** pnpm, when package.json names no `packageManager`. */
export const PNPM_FALLBACK = '10';

/** Where everything ClikCode Remote installs lives on the other machine,
 * relative to its $HOME (shell expressions, never user input). */
const SHARE = '"$HOME/.local/share/clikcode"';
const BIN_LINK = '"$HOME/.local/bin/clikcode"';
const OWN_NODE_BIN = '"$HOME/.local/share/clikcode/node/bin"';

/** Tests point these at fixtures (a file:// repository, a local mirror). */
function repoUrl(): string { return process.env.CLIKCODE_REMOTE_REPO_URL?.trim() || REMOTE_REPO_URL; }
function nodeMirror(): string { return (process.env.CLIKCODE_REMOTE_NODE_MIRROR?.trim() || NODE_MIRROR).replace(/\/+$/, ''); }

export const INSTALL_STEPS = ['Checking the machine', 'Node.js', 'git', 'Getting ClikCode from GitHub', 'Building and installing', 'Checking the install'] as const;
export type InstallStep = typeof INSTALL_STEPS[number];

export interface InstallReporter {
  /** A step starts (1-based `index` of `total`). */
  start(step: InstallStep, index: number, total: number): void;
  /** It finished, with a few words of what it found or did. */
  done(step: InstallStep, detail: string): void;
}

export interface Probe {
  os: string;
  arch: string;
  home: string;
  git?: string;
  node?: string;
  nodeVersion?: string;
  ownNodeVersion?: string;
  /** What ~/.local/bin/clikcode is: absent, ClikCode Remote's own link, or something else. */
  clikcode?: 'ours' | 'other';
}

export interface RemoteInfo { version: string; commit?: string; installationId?: string }

export type InstallOutcome =
  /** `from`: the commit the clone was at before (an update). */
  | { ok: true; info: RemoteInfo; probe: Probe; from?: string }
  /** `auth`: the login was refused -- the caller may ask for a user and try
   * again. `windows`: not supported yet. */
  | { ok: false; step: InstallStep; message: string; auth?: boolean; windows?: boolean; unreachable?: boolean };

/** `vX.Y.Z` is at least 22.12. */
export function nodeIsNewEnough(version: string | undefined): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version?.trim() ?? '');
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

// ---- the scripts --------------------------------------------------------

export function probeScript(): string {
  return [
    `printf 'os=%s\\n' "$(uname -s 2>/dev/null)"`,
    `printf 'arch=%s\\n' "$(uname -m 2>/dev/null)"`,
    `printf 'home=%s\\n' "$HOME"`,
    `printf 'git=%s\\n' "$(command -v git 2>/dev/null)"`,
    `n="$(command -v node 2>/dev/null)"; printf 'node=%s\\n' "$n"`,
    `if [ -n "$n" ]; then printf 'nodeVersion=%s\\n' "$("$n" -v 2>/dev/null)"; fi`,
    `own=${SHARE}/node/bin/node; if [ -x "$own" ]; then printf 'ownNodeVersion=%s\\n' "$("$own" -v 2>/dev/null)"; fi`,
    `link=${BIN_LINK}; if [ -L "$link" ]; then case "$(readlink "$link")" in ${SHARE}/*) echo clikcode=ours;; *) echo clikcode=other;; esac; elif [ -e "$link" ]; then echo clikcode=other; fi`,
    `echo probe=ok`,
  ].join('\n');
}

const keyValues = (text: string): Map<string, string> => {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return values;
};

/** The probe's answer; undefined when it never ran (not a POSIX shell). */
export function parseProbe(stdout: string): Probe | undefined {
  const values = keyValues(stdout);
  if (values.get('probe') !== 'ok') return undefined;
  const value = (key: string): string | undefined => values.get(key) || undefined;
  const clikcode = value('clikcode');
  return {
    os: value('os') ?? '', arch: value('arch') ?? '', home: value('home') ?? '',
    ...(value('git') ? { git: value('git') } : {}),
    ...(value('node') ? { node: value('node') } : {}),
    ...(value('nodeVersion') ? { nodeVersion: value('nodeVersion') } : {}),
    ...(value('ownNodeVersion') ? { ownNodeVersion: value('ownNodeVersion') } : {}),
    ...(clikcode === 'ours' || clikcode === 'other' ? { clikcode } : {}),
  };
}

/** What a machine whose shell is cmd.exe or PowerShell prints for `sh -c`. */
export function looksLikeWindows(result: SshResult, probe?: Probe): boolean {
  if (probe) return /^(MINGW|MSYS|CYGWIN|Windows)/i.test(probe.os);
  return /is not recognized as an internal or external command|The term 'sh' is not recognized|CommandNotFoundException|Windows/i.test(`${result.stdout}\n${result.stderr}`);
}

/** nodejs.org's names for an OS and a CPU. */
export function nodePlatform(probe: Probe): { os: string; arch: string } | undefined {
  const os = probe.os === 'Linux' ? 'linux' : probe.os === 'Darwin' ? 'darwin' : undefined;
  const arch = ({ x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' } as Record<string, string>)[probe.arch];
  return os && arch ? { os, arch } : undefined;
}

/** Downloads Node's tarball for this OS and CPU from the mirror's
 * `NODE_LINE`, checks its SHA-256 against the SHASUMS256.txt published
 * beside it, and unpacks it into ~/.local/share/clikcode/node. */
export function nodeInstallScript(platform: { os: string; arch: string }, mirror = nodeMirror()): string {
  const base = `${mirror}/${NODE_LINE}`;
  return [
    'set -eu',
    `base=${shellQuote(base)}`,
    `os=${shellQuote(platform.os)}; arch=${shellQuote(platform.arch)}`,
    `dir=${SHARE}`,
    'mkdir -p "$dir"',
    'tmp="$(mktemp -d "${TMPDIR:-/tmp}/clikcode-node.XXXXXX")"',
    `trap 'rm -rf "$tmp"' EXIT`,
    'fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"; else echo "step-error=neither curl nor wget is installed"; exit 3; fi; }',
    'fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || { echo "step-error=could not download $base/SHASUMS256.txt"; exit 3; }',
    'line="$(grep -E "  node-v[0-9.]+-$os-$arch\\.tar\\.gz\\$" "$tmp/SHASUMS256.txt" | head -n 1)"',
    '[ -n "$line" ] || { echo "step-error=nodejs.org has no Node build for $os-$arch"; exit 3; }',
    'expected="${line%% *}"; name="${line##* }"',
    'fetch "$base/$name" "$tmp/$name" || { echo "step-error=could not download $base/$name"; exit 3; }',
    'if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$name")"; else actual="$(shasum -a 256 "$tmp/$name")"; fi',
    'actual="${actual%% *}"',
    '[ "$actual" = "$expected" ] || { echo "step-error=checksum mismatch for $name: expected $expected, got $actual"; exit 4; }',
    'mkdir "$tmp/unpacked"',
    'tar -xzf "$tmp/$name" -C "$tmp/unpacked"',
    'rm -rf "$dir/node.new"',
    'mv "$tmp/unpacked/${name%.tar.gz}" "$dir/node.new"',
    'rm -rf "$dir/node"',
    'mv "$dir/node.new" "$dir/node"',
    'echo "sha256=$actual"',
    'echo "nodeVersion=$("$dir/node/bin/node" -v)"',
  ].join('\n');
}

/** Clone, or bring the clone ClikCode made to `commit` (by default the
 * tip of GitHub main). That directory is ClikCode's own: whatever it holds
 * is reset to the target, local changes included. Refuses a directory that
 * is not that clone. Prints `before=` (its commit until now), `action=` and
 * `commit=` (the target it is at now). */
export function sourceScript(url = repoUrl(), commit?: string): string {
  return [
    'set -eu',
    `src=${SHARE}/src`,
    `url=${shellQuote(url)}`,
    `want=${shellQuote(commit ?? '')}`,
    'if [ -d "$src/.git" ]; then',
    '  cd "$src"',
    '  origin="$(git remote get-url origin 2>/dev/null || true)"',
    '  [ "$origin" = "$url" ] || { echo "step-error=not-ours $origin"; exit 5; }',
    '  echo "before=$(git rev-parse HEAD 2>/dev/null || true)"',
    '  action=updated',
    'elif [ -e "$src" ]; then',
    '  echo "step-error=not-a-checkout"; exit 7',
    'else',
    '  mkdir -p "$(dirname "$src")"',
    '  git clone -q --depth 1 --branch main "$url" "$src" || { echo "step-error=fetch main"; exit 9; }',
    '  cd "$src"',
    '  action=cloned',
    'fi',
    'if [ -n "$want" ]; then',
    // A full sha is fetched by itself; a short one needs main's history to be found in.
    '  git fetch -q --depth 1 origin "$want" 2>/dev/null || git fetch -q --unshallow origin main 2>/dev/null || git fetch -q origin main || { echo "step-error=fetch $want"; exit 9; }',
    '  target="$(git rev-parse -q --verify "$want^{commit}" 2>/dev/null || true)"',
    '  [ -n "$target" ] || { echo "step-error=unknown-commit $want"; exit 10; }',
    'else',
    '  if [ "$action" = updated ]; then git fetch -q --depth 1 origin main || { echo "step-error=fetch main"; exit 9; }; fi',
    '  target="$(git rev-parse origin/main)"',
    'fi',
    'git reset -q --hard "$target"',
    'git clean -fdq',
    'echo "action=$action"',
    'echo "commit=$(git rev-parse HEAD)"',
  ].join('\n');
}

/** The PATH every later step runs with: ClikCode's own Node first, when it installed one. */
const withOwnNode = `PATH=${OWN_NODE_BIN}:"$PATH"; export PATH`;

/** pnpm through corepack where package.json pins it, else npx; then the
 * repository's own install-local. `pinned`: the clone is at a chosen commit
 * rather than the tip of main, which install-local refuses to build from --
 * so it is built first and installed as it is (`--force`). */
export function buildScript(pinned = false): string {
  return [
    'set -eu',
    withOwnNode,
    `cd ${SHARE}/src`,
    `pm="$(node -e "const p=require('./package.json').packageManager||'';process.stdout.write(p.startsWith('pnpm@')?p.slice(5).split('+')[0]:'')" 2>/dev/null || true)"`,
    `if [ -n "$pm" ] && command -v corepack >/dev/null 2>&1; then pnpm() { COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@"; }; else pnpm() { npx --yes "pnpm@\${pm:-${PNPM_FALLBACK}}" "$@"; }; fi`,
    'pnpm install --frozen-lockfile',
    ...(pinned ? ['pnpm run build', 'pnpm run install-local --force'] : ['pnpm run install-local']),
    'echo build=ok',
  ].join('\n');
}

export function verifyScript(): string {
  return [
    'set -eu',
    withOwnNode,
    `bin=${BIN_LINK}`,
    '[ -e "$bin" ] || { echo "step-error=~/.local/bin/clikcode is missing"; exit 8; }',
    'echo "version=$("$bin" --version)"',
    'echo "info=$("$bin" remote-info)"',
  ].join('\n');
}

/** What starts the board's connection on the other machine: its own
 * bridge, multiplexed, over this SSH session's stdin/stdout. */
export function bridgeScript(): string {
  return [withOwnNode, `CLIKCODE_IDE_MULTIPLEX=1 exec ${BIN_LINK} ide-bridge --stdio`].join('\n');
}

/** Run a vendor's interactive sign-in on the machine that owns the chat. */
export function remoteTerminalScript(spec: string): string {
  return [withOwnNode, `exec ${BIN_LINK} ide-terminal ${shellQuote(spec)}`].join('\n');
}

/** Takes off what ClikCode Remote put there: the source, the release, its
 * Node, and the ~/.local/bin/clikcode link when it points into them. The
 * machine's own ClikCode data (~/.clikcode: its chats, accounts) only when
 * `data` -- the user ticked that too. */
export function uninstallScript(data: boolean): string {
  return [
    `d=${SHARE}`,
    'rm -rf "$d/src" "$d/release" "$d/node"',
    `link=${BIN_LINK}`,
    'if [ -L "$link" ]; then case "$(readlink "$link")" in "$d"/*) rm -f "$link";; esac; fi',
    ...(data ? ['rm -rf "$HOME/.clikcode"'] : []),
    'rmdir "$d" 2>/dev/null || true',
    'echo uninstall=ok',
  ].join('\n');
}

// ---- running them -------------------------------------------------------

const STEP_TIMEOUT_MS = 5 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;

const lastLines = (text: string, count = 3): string => text.trim().split('\n').filter(Boolean).slice(-count).join(' / ');

/** What a step's script said went wrong, or its last words. */
function stepError(result: SshResult): string {
  const said = keyValues(result.stdout).get('step-error');
  return said ?? (lastLines(result.stderr) || lastLines(result.stdout) || `exit ${result.code}`);
}

export async function probeMachine(target: string): Promise<{ probe?: Probe; failed?: Extract<InstallOutcome, { ok: false }> }> {
  const step: InstallStep = 'Checking the machine';
  const result = await runSsh(target, probeScript(), { timeoutMs: 60_000 });
  const failure = sshFailure(result);
  if (failure) {
    return { failed: { ok: false, step, message: sshFailureMessage(target, result), ...(failure === 'auth' ? { auth: true } : {}), ...(failure === 'unreachable' ? { unreachable: true } : {}) } };
  }
  const probe = parseProbe(result.stdout);
  if (!probe || looksLikeWindows(result, probe)) {
    if (looksLikeWindows(result, probe)) return { failed: { ok: false, step, windows: true, message: `${target} runs Windows. ClikCode Remote does not support Windows machines yet.` } };
    return { failed: { ok: false, step, message: `${target} did not run the check (${stepError(result)}). ClikCode Remote needs a POSIX shell (sh) there.` } };
  }
  return { probe };
}

export interface InstallOptions {
  /** Update: the source, build and check only (steps 4-6). */
  update?: boolean;
  /** The commit to install (fetched by sha); the tip of GitHub main when absent. */
  commit?: string;
}

/** Steps 1-6 (or 4-6 for an update), reporting each. Stops at the first
 * that fails, saying which and what to do. */
export async function installOnMachine(target: string, reporter: InstallReporter, options: InstallOptions = {}): Promise<InstallOutcome> {
  const steps: InstallStep[] = options.update
    ? ['Checking the machine', ...UPDATE_STEPS]
    : [...INSTALL_STEPS];
  const progress = stepper(reporter, steps.length);
  const fail = (step: InstallStep, message: string): InstallOutcome => ({ ok: false, step, message });

  progress.begin('Checking the machine');
  const probed = await probeMachine(target);
  if (probed.failed) return probed.failed;
  const probe = probed.probe!;
  const platform = nodePlatform(probe);
  if (!platform) return fail('Checking the machine', `${target} is ${probe.os || 'an unknown OS'} on ${probe.arch || 'an unknown CPU'}; ClikCode Remote installs on Linux and macOS (x64, arm64).`);
  if (probe.clikcode === 'other') return fail('Checking the machine', `${target} already has a ~/.local/bin/clikcode that ClikCode Remote did not install. Move it away (or remove it) and choose the machine again.`);
  reporter.done('Checking the machine', `${probe.os === 'Darwin' ? 'macOS' : probe.os} ${probe.arch}`);

  if (!options.update) {
    progress.begin('Node.js');
    if (nodeIsNewEnough(probe.ownNodeVersion)) reporter.done('Node.js', `ClikCode's own ${probe.ownNodeVersion}`);
    else if (nodeIsNewEnough(probe.nodeVersion)) reporter.done('Node.js', `${probe.nodeVersion} (already installed)`);
    else {
      const node = await runSsh(target, nodeInstallScript(platform), { timeoutMs: STEP_TIMEOUT_MS });
      if (node.code !== 0) {
        return fail('Node.js', `Installing Node.js on ${target} failed: ${stepError(node)}. Install Node.js ${MIN_NODE.join('.')} or newer there yourself, then choose the machine again.`);
      }
      const values = keyValues(node.stdout);
      reporter.done('Node.js', `${values.get('nodeVersion') ?? 'installed'} into ~/.local/share/clikcode/node (SHA-256 checked)`);
    }

    progress.begin('git');
    if (!probe.git) {
      const remedy = probe.os === 'Darwin' ? 'run `xcode-select --install` there' : "install it with the machine's package manager (for example `sudo apt install git`)";
      return fail('git', `${target} has no git. ClikCode never uses sudo: ${remedy}, then choose the machine again.`);
    }
    reporter.done('git', probe.git);
  }

  const updated = await runManagedUpdate(sshRunner(target), target, progress, options.commit ? { commit: options.commit } : {});
  return updated.ok ? { ok: true, info: updated.info, probe, ...(updated.from ? { from: updated.from } : {}) } : updated;
}

// ---- the managed clone's update: one implementation, run over SSH or here --

/** Runs a script on the machine being updated: over SSH for Remote, in a
 * local `sh` for /update on this machine. Never throws: `code` says. */
export type ScriptRunner = (script: string, options: { timeoutMs: number }) => Promise<SshResult>;

export const sshRunner = (target: string): ScriptRunner => (script, options) => runSsh(target, script, options);

/** `script` in this machine's `sh`, in $HOME, without blocking. */
export const localRunner: ScriptRunner = (script, options) => new Promise((resolve) => {
  let child;
  try {
    child = spawn('/bin/sh', ['-c', script], { cwd: homedir(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    resolve({ code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
    return;
  }
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-20_000); });
  const timer = setTimeout(() => { stderr += '\ntimed out'; child.kill('SIGTERM'); }, options.timeoutMs);
  timer.unref();
  child.once('error', (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: error.message }); });
  child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
});

/** The steps of updating the managed clone, wherever it is. */
export const UPDATE_STEPS = ['Getting ClikCode from GitHub', 'Building and installing', 'Checking the install'] as const satisfies readonly InstallStep[];

export interface Progress {
  begin(step: InstallStep): void;
  done(step: InstallStep, detail: string): void;
}

/** Numbers each step as it starts, out of `total`. */
export function stepper(reporter: InstallReporter, total: number): Progress {
  let index = 0;
  return {
    begin: (step) => { index += 1; reporter.start(step, index, total); },
    done: (step, detail) => reporter.done(step, detail),
  };
}

export type ManagedUpdateOutcome =
  | { ok: true; info: RemoteInfo; from?: string; to: string; upToDate?: false }
  /** The clone was already at the target and so is the running build:
   * nothing was built. */
  | { ok: true; upToDate: true; from: string; to: string }
  | Extract<InstallOutcome, { ok: false }>;

/** Steps 4-6 of an install, and the whole of an update: the managed clone
 * reset to `commit` (or main), built, installed, and checked. `where` names
 * the machine in messages. `running`: the commit of the ClikCode asking,
 * when it updates itself -- a clone already at the target with that build
 * running is up to date, and nothing is rebuilt. */
export async function runManagedUpdate(
  run: ScriptRunner, where: string, progress: Progress, options: { commit?: string; running?: string } = {},
): Promise<ManagedUpdateOutcome> {
  const fail = (step: InstallStep, message: string): Extract<InstallOutcome, { ok: false }> => ({ ok: false, step, message });
  const source = 'Getting ClikCode from GitHub';
  progress.begin(source);
  const fetched = await run(sourceScript(repoUrl(), options.commit), { timeoutMs: STEP_TIMEOUT_MS });
  const values = keyValues(fetched.stdout);
  if (fetched.code !== 0) {
    if (sshFailure(fetched)) return fail(source, sshFailureMessage(where, fetched));
    const said = values.get('step-error') ?? '';
    if (said.startsWith('not-ours')) return fail(source, `~/.local/share/clikcode/src on ${where} is a checkout of ${said.slice(9) || 'another repository'}, not ${repoUrl()}; ClikCode will not touch it. Move it away, then try again.`);
    if (said === 'not-a-checkout') return fail(source, `~/.local/share/clikcode/src on ${where} exists and is not a git checkout; ClikCode will not touch it. Move it away, then try again.`);
    if (said.startsWith('unknown-commit') || (options.commit && said.startsWith('fetch'))) return fail(source, `${repoUrl()} has no commit ${options.commit} that ${where} could fetch. Push it to main, or name another commit.`);
    return fail(source, `Getting ClikCode on ${where} failed: ${stepError(fetched)}. Check that it can reach github.com.`);
  }
  const to = values.get('commit') ?? '';
  const from = values.get('before') || undefined;
  progress.done(source, `${values.get('action') ?? 'done'} at ${to.slice(0, 8)}`);
  if (options.running !== undefined && from === to && (options.running || to) === to) return { ok: true, upToDate: true, from: to, to };

  const build = 'Building and installing';
  progress.begin(build);
  const pinned = Boolean(options.commit);
  const built = await run(buildScript(pinned), { timeoutMs: BUILD_TIMEOUT_MS });
  if (built.code !== 0 || keyValues(built.stdout).get('build') !== 'ok') {
    const rerun = pinned ? 'pnpm install --frozen-lockfile && pnpm run build && pnpm run install-local --force' : 'pnpm install --frozen-lockfile && pnpm run install-local';
    return fail(build, `Building ClikCode on ${where} failed: ${stepError(built)}. Run \`cd ~/.local/share/clikcode/src && ${rerun}\` there to see the whole error.`);
  }
  progress.done(build, '~/.local/bin/clikcode');

  const check = 'Checking the install';
  progress.begin(check);
  const verify = await run(verifyScript(), { timeoutMs: 60_000 });
  const info = parseRemoteInfo(keyValues(verify.stdout).get('info'));
  if (verify.code !== 0 || !info) return fail(check, `ClikCode on ${where} did not start: ${stepError(verify)}.`);
  progress.done(check, `ClikCode ${info.version}${info.commit ? ` (${info.commit.slice(0, 8)})` : ''}`);
  return { ok: true, info, to: info.commit ?? to, ...(from ? { from } : {}) };
}

export function parseRemoteInfo(text: string | undefined): RemoteInfo | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<RemoteInfo>;
    if (typeof parsed.version !== 'string') return undefined;
    return {
      version: parsed.version,
      ...(typeof parsed.commit === 'string' && parsed.commit ? { commit: parsed.commit } : {}),
      ...(typeof parsed.installationId === 'string' && parsed.installationId ? { installationId: parsed.installationId } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function uninstallFromMachine(target: string, data: boolean): Promise<{ ok: boolean; message?: string }> {
  const result = await runSsh(target, uninstallScript(data), { timeoutMs: 120_000 });
  if (result.code === 0 && keyValues(result.stdout).get('uninstall') === 'ok') return { ok: true };
  return { ok: false, message: sshFailure(result) ? sshFailureMessage(target, result) : stepError(result) };
}
