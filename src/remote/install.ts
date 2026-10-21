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
 *                or a fetch and reset of the one already there -- that
 *                directory is ClikCode's own, and one with local changes is
 *                left alone
 *   5. build     `pnpm install --frozen-lockfile`, then `pnpm run
 *                install-local` (scripts/install-local.mjs)
 *   6. verify    `~/.local/bin/clikcode --version` and its `remote-info`
 *
 * Every step is one SSH command; its script quotes every value it did not
 * write itself (shell.ts). */
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
  | { ok: true; info: RemoteInfo; probe: Probe }
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

/** Clone, or update the clone ClikCode made. Refuses a directory that is
 * not that clone, or one with local changes. */
export function sourceScript(url = repoUrl()): string {
  return [
    'set -eu',
    `src=${SHARE}/src`,
    `url=${shellQuote(url)}`,
    'if [ -d "$src/.git" ]; then',
    '  cd "$src"',
    '  origin="$(git remote get-url origin 2>/dev/null || true)"',
    '  [ "$origin" = "$url" ] || { echo "step-error=not-ours $origin"; exit 5; }',
    '  changes="$(git status --porcelain 2>/dev/null)"',
    '  if [ -n "$changes" ]; then echo "step-error=dirty"; printf "%s\\n" "$changes" | head -n 10 | sed "s/^/changed=/"; exit 6; fi',
    '  git fetch -q --depth 1 origin main',
    '  git reset -q --hard origin/main',
    '  echo action=updated',
    'elif [ -e "$src" ]; then',
    '  echo "step-error=not-a-checkout"; exit 7',
    'else',
    '  mkdir -p "$(dirname "$src")"',
    '  git clone -q --depth 1 --branch main "$url" "$src"',
    '  echo action=cloned',
    'fi',
    'echo "commit=$(git -C "$src" rev-parse HEAD)"',
  ].join('\n');
}

/** The PATH every later step runs with: ClikCode's own Node first, when it installed one. */
const withOwnNode = `PATH=${OWN_NODE_BIN}:"$PATH"; export PATH`;

/** pnpm through corepack where package.json pins it, else npx; then the
 * repository's own install-local. */
export function buildScript(): string {
  return [
    'set -eu',
    withOwnNode,
    `cd ${SHARE}/src`,
    `pm="$(node -e "const p=require('./package.json').packageManager||'';process.stdout.write(p.startsWith('pnpm@')?p.slice(5).split('+')[0]:'')" 2>/dev/null || true)"`,
    `if [ -n "$pm" ] && command -v corepack >/dev/null 2>&1; then pnpm() { COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@"; }; else pnpm() { npx --yes "pnpm@\${pm:-${PNPM_FALLBACK}}" "$@"; }; fi`,
    'pnpm install --frozen-lockfile',
    'pnpm run install-local',
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
}

/** Steps 1-6 (or 4-6 for an update), reporting each. Stops at the first
 * that fails, saying which and what to do. */
export async function installOnMachine(target: string, reporter: InstallReporter, options: InstallOptions = {}): Promise<InstallOutcome> {
  const steps: InstallStep[] = options.update
    ? ['Checking the machine', 'Getting ClikCode from GitHub', 'Building and installing', 'Checking the install']
    : [...INSTALL_STEPS];
  const total = steps.length;
  let index = 0;
  const begin = (step: InstallStep): void => { index += 1; reporter.start(step, index, total); };
  const fail = (step: InstallStep, message: string): InstallOutcome => ({ ok: false, step, message });

  begin('Checking the machine');
  const probed = await probeMachine(target);
  if (probed.failed) return probed.failed;
  const probe = probed.probe!;
  const platform = nodePlatform(probe);
  if (!platform) return fail('Checking the machine', `${target} is ${probe.os || 'an unknown OS'} on ${probe.arch || 'an unknown CPU'}; ClikCode Remote installs on Linux and macOS (x64, arm64).`);
  if (probe.clikcode === 'other') return fail('Checking the machine', `${target} already has a ~/.local/bin/clikcode that ClikCode Remote did not install. Move it away (or remove it) and choose the machine again.`);
  reporter.done('Checking the machine', `${probe.os === 'Darwin' ? 'macOS' : probe.os} ${probe.arch}`);

  if (!options.update) {
    begin('Node.js');
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

    begin('git');
    if (!probe.git) {
      const remedy = probe.os === 'Darwin' ? 'run `xcode-select --install` there' : "install it with the machine's package manager (for example `sudo apt install git`)";
      return fail('git', `${target} has no git. ClikCode never uses sudo: ${remedy}, then choose the machine again.`);
    }
    reporter.done('git', probe.git);
  }

  begin('Getting ClikCode from GitHub');
  const source = await runSsh(target, sourceScript(), { timeoutMs: STEP_TIMEOUT_MS });
  if (source.code !== 0) {
    const values = keyValues(source.stdout);
    const said = values.get('step-error') ?? '';
    if (said === 'dirty') {
      const changed = source.stdout.split('\n').filter((line) => line.startsWith('changed=')).map((line) => line.slice(8).trim()).slice(0, 3).join(', ');
      return fail('Getting ClikCode from GitHub', `~/.local/share/clikcode/src on ${target} has local changes (${changed}); ClikCode will not overwrite them. Commit, move or discard them there, then try again.`);
    }
    if (said.startsWith('not-ours')) return fail('Getting ClikCode from GitHub', `~/.local/share/clikcode/src on ${target} is a checkout of ${said.slice(9) || 'another repository'}, not ${repoUrl()}; ClikCode will not touch it. Move it away, then try again.`);
    if (said === 'not-a-checkout') return fail('Getting ClikCode from GitHub', `~/.local/share/clikcode/src on ${target} exists and is not a git checkout; ClikCode will not touch it. Move it away, then try again.`);
    return fail('Getting ClikCode from GitHub', `Getting ClikCode on ${target} failed: ${stepError(source)}. Check that it can reach github.com.`);
  }
  const fetched = keyValues(source.stdout);
  reporter.done('Getting ClikCode from GitHub', `${fetched.get('action') ?? 'done'} at ${(fetched.get('commit') ?? '').slice(0, 8)}`);

  begin('Building and installing');
  const build = await runSsh(target, buildScript(), { timeoutMs: BUILD_TIMEOUT_MS });
  if (build.code !== 0 || keyValues(build.stdout).get('build') !== 'ok') {
    return fail('Building and installing', `Building ClikCode on ${target} failed: ${stepError(build)}. Run \`cd ~/.local/share/clikcode/src && pnpm install --frozen-lockfile && pnpm run install-local\` there to see the whole error.`);
  }
  reporter.done('Building and installing', '~/.local/bin/clikcode');

  begin('Checking the install');
  const verify = await runSsh(target, verifyScript(), { timeoutMs: 60_000 });
  const values = keyValues(verify.stdout);
  const info = parseRemoteInfo(values.get('info'));
  if (verify.code !== 0 || !info) return fail('Checking the install', `ClikCode on ${target} did not start: ${stepError(verify)}.`);
  reporter.done('Checking the install', `ClikCode ${info.version}${info.commit ? ` (${info.commit.slice(0, 8)})` : ''}`);
  return { ok: true, info, probe };
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
