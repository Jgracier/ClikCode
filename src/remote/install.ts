/** Installing ClikCode on another machine, over SSH, from GitHub main.
 *
 * Nothing is copied from this machine -- no credentials, accounts or
 * settings. The other machine gets a fresh ClikCode of its own, built from
 * the public repository, and signs in from scratch in its own chats. This
 * machine needs nothing new; the other one needs only git (and gets a
 * user-local Node if it has none new enough). Nothing runs with sudo.
 *
 *   1. probe     what the machine is: OS (and macOS version), git, Node,
 *                $HOME; a macOS too old for any Node ClikCode can run on
 *                is refused here, before anything is downloaded
 *   2. Node      a user-local Node.js when there is none >= 22.12 that
 *                runs, from the source that runs on that OS (nodeSource):
 *                nodejs.org, its SHA-256 checked against SHASUMS256.txt, or
 *                on macOS 10.15 MacPorts' build, its archives pinned by
 *                SHA-256 (MACPORTS_NODE); then run, or the step stops with
 *                what it said
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
export const MACPORTS_MIRROR = 'https://packages.macports.org';
/** package.json `engines.node`. */
export const MIN_NODE: readonly [number, number] = [22, 12];

/** One MacPorts binary archive, pinned: `<mirror>/<port>/<file>` must have this SHA-256. */
export interface MacPortsArchive { port: string; file: string; sha256: string }
export interface MacPortsNode { version: string; node: MacPortsArchive; libs: readonly MacPortsArchive[]; npm: MacPortsArchive }

/** MacPorts' prebuilt Node for the macOS versions nodejs.org's builds no
 * longer run on, by Darwin major (19 = macOS 10.15). MacPorts builds
 * nodejs22 for 10.15 and newer only (none for darwin_17/18, checked
 * 2026-10-21). `node` loads /opt/local/lib's libz.1, libicui18n.78 and
 * libicuuc.78 (which loads libicudata.78): zlib and icu. nodejs22 has no
 * npm; npm10 is MacPorts' noarch npm. The SHA-256s are of the archives
 * fetched from packages.macports.org on 2026-10-21. */
export const MACPORTS_NODE: Readonly<Record<number, MacPortsNode>> = {
  19: {
    version: 'v22.22.2',
    node: { port: 'nodejs22', file: 'nodejs22-22.22.2_0.darwin_19.x86_64.tbz2', sha256: '7db89a4738f5745c54f68090e9f8272ae37e436943ba33fcbabefd300ab2214c' },
    libs: [
      { port: 'zlib', file: 'zlib-1.3.2_0.darwin_19.x86_64.tbz2', sha256: 'cca691a7f4b224c749bb29ca89987211f011df055bda32c59098b7e9d0ec927e' },
      { port: 'icu', file: 'icu-78.3_1.darwin_19.x86_64.tbz2', sha256: 'aee9d8730bd2e1c5e1476b1d781e40c17311b81038a348e0295f530019bd2538' },
    ],
    npm: { port: 'npm10', file: 'npm10-10.9.8_0.any_any.noarch.tbz2', sha256: '17d50e577d7ab0d6e2c34b2847a6befcd83f6e2b59d5064e40e0f7f6266c5ff0' },
  },
};

/** Where Node comes from for a machine (nodeSource). */
export type NodeSource =
  | { kind: 'nodejs'; line: 'latest-v24.x' | 'latest-v22.x'; os: string; arch: string }
  | { kind: 'macports'; darwin: number; pinned: MacPortsNode }
  | { kind: 'refused'; message: string };
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
function macportsMirror(): string { return (process.env.CLIKCODE_REMOTE_MACPORTS_MIRROR?.trim() || MACPORTS_MIRROR).replace(/\/+$/, ''); }
/** The pinned table; tests replace it (with the mirror) by JSON, as their archives are fakes. */
function macportsPins(): Readonly<Record<number, MacPortsNode>> {
  const json = process.env.CLIKCODE_REMOTE_MACPORTS_PINS?.trim();
  return json ? JSON.parse(json) as Record<number, MacPortsNode> : MACPORTS_NODE;
}

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
  /** `sw_vers -productVersion`, on macOS. */
  macos?: string;
  git?: string;
  node?: string;
  /** What `node -v` said; absent when it failed (nodeError). */
  nodeVersion?: string;
  /** The `node` on PATH is there but does not run: what it said. */
  nodeError?: string;
  ownNodeVersion?: string;
  /** ClikCode's own Node (an earlier install's) is there but does not run: what it said. */
  ownNodeError?: string;
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
    `if [ "$(uname -s 2>/dev/null)" = Darwin ]; then printf 'macos=%s\\n' "$(sw_vers -productVersion 2>/dev/null)"; fi`,
    `printf 'git=%s\\n' "$(command -v git 2>/dev/null)"`,
    // A Node counts only when it runs: `node -v` failing (a build for a newer
    // macOS, a missing library) is what it said, on one line.
    `oneline() { printf '%s' "$1" | tr '\\n\\r' '  ' | cut -c1-400; }`,
    `n="$(command -v node 2>/dev/null)"; printf 'node=%s\\n' "$n"`,
    `if [ -n "$n" ]; then if v="$("$n" -v 2>/dev/null)"; then printf 'nodeVersion=%s\\n' "$v"; else printf 'nodeError=%s\\n' "$(oneline "$("$n" -v 2>&1)")"; fi; fi`,
    `own=${SHARE}/node/bin/node; if [ -e "$own" ]; then if v="$("$own" -v 2>/dev/null)"; then printf 'ownNodeVersion=%s\\n' "$v"; else printf 'ownNodeError=%s\\n' "$(oneline "$("$own" -v 2>&1)")"; fi; fi`,
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
    ...Object.fromEntries((['macos', 'git', 'node', 'nodeVersion', 'nodeError', 'ownNodeVersion', 'ownNodeError'] as const)
      .flatMap((key) => (value(key) ? [[key, value(key)]] : []))),
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

/** `10.15.8` -> [10, 15, 8]; undefined when it is not a version. */
function macosVersion(text: string | undefined): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(text?.trim() ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}
const atLeast = (version: readonly number[], floor: readonly number[]): boolean => {
  for (let at = 0; at < floor.length; at += 1) if ((version[at] ?? 0) !== floor[at]) return (version[at] ?? 0) > floor[at]!;
  return true;
};

/** Where a machine's Node comes from, by its OS: what runs there.
 *   Linux                 nodejs.org latest-v24.x
 *   macOS >= 13.5         nodejs.org latest-v24.x (its darwin builds need 13.5)
 *   macOS 11.0 - 13.4     nodejs.org latest-v22.x (its darwin builds need 11.0)
 *   macOS 10.15 (x86_64)  MacPorts' nodejs22 (MACPORTS_NODE)
 *   older                 refused: nothing ClikCode can run, runs there. */
export function nodeSource(probe: Probe, machine: string, pins: Readonly<Record<number, MacPortsNode>> = macportsPins()): NodeSource {
  const platform = nodePlatform(probe);
  if (!platform) return { kind: 'refused', message: `${machine} is ${probe.os || 'an unknown OS'} on ${probe.arch || 'an unknown CPU'}; ClikCode Remote installs on Linux and macOS (x64, arm64).` };
  if (platform.os === 'linux') return { kind: 'nodejs', line: 'latest-v24.x', ...platform };
  const version = macosVersion(probe.macos);
  if (!version) return { kind: 'refused', message: `${machine} did not say which macOS it runs (sw_vers -productVersion), so ClikCode cannot tell which Node.js runs there. Install Node.js ${MIN_NODE.join('.')} or newer there yourself and add it again.` };
  if (atLeast(version, [13, 5])) return { kind: 'nodejs', line: 'latest-v24.x', ...platform };
  if (atLeast(version, [11, 0])) return { kind: 'nodejs', line: 'latest-v22.x', ...platform };
  // macOS 10.x is Darwin 10.x + 4 (10.15 = darwin_19); MacPorts builds for x86_64.
  const darwin = version[1] + 4;
  const pinned = version[0] === 10 ? pins[darwin] : undefined;
  if (pinned && platform.arch === 'x64') return { kind: 'macports', darwin, pinned };
  const floor = Math.min(...Object.keys(pins).map(Number));
  return { kind: 'refused', message: `macOS ${probe.macos} is too old for ClikCode: it needs Node.js ${MIN_NODE.join('.')} or newer, which needs macOS 10.${floor - 4} or newer. Update macOS on ${machine}, or install Node.js ${MIN_NODE.join('.')}+ there yourself and add it again.` };
}

/** What a source is called in the step's line. */
export function nodeSourceText(source: Exclude<NodeSource, { kind: 'refused' }>): string {
  return source.kind === 'nodejs' ? `nodejs.org ${source.line}` : `MacPorts ${source.pinned.node.port} ${source.pinned.version}`;
}

/** The lines every Node install script starts with: a temporary directory,
 * `fetch URL FILE`, and `sha256 FILE`. */
const NODE_SCRIPT_START = [
  'set -eu',
  `dir=${SHARE}`,
  'mkdir -p "$dir"',
  'tmp="$(mktemp -d "${TMPDIR:-/tmp}/clikcode-node.XXXXXX")"',
  `trap 'rm -rf "$tmp"' EXIT`,
  'fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"; else echo "step-error=neither curl nor wget is installed"; exit 3; fi; }',
  'sha256() { if command -v sha256sum >/dev/null 2>&1; then s="$(sha256sum "$1")"; else s="$(shasum -a 256 "$1")"; fi; printf %s "${s%% *}"; }',
  `oneline() { printf '%s' "$1" | tr '\\n\\r' '  ' | cut -c1-600; }`,
  'rm -rf "$dir/node.new"',
];

/** The lines every Node install script ends with: the Node in node.new is
 * run -- failing, the step stops with what it said, and nothing replaces
 * the Node there was -- then it takes the place of ~/.local/share/clikcode/node. */
const NODE_SCRIPT_END = [
  'if ! v="$("$dir/node.new/bin/node" -v 2>/dev/null)"; then echo "step-error=node-fails $(oneline "$("$dir/node.new/bin/node" -v 2>&1)")"; rm -rf "$dir/node.new"; exit 6; fi',
  'rm -rf "$dir/node"',
  'mv "$dir/node.new" "$dir/node"',
  'echo "nodeVersion=$v"',
];

/** Downloads Node's tarball for this OS and CPU from nodejs.org's `line`,
 * checks its SHA-256 against the SHASUMS256.txt published beside it, and
 * unpacks it into ~/.local/share/clikcode/node. */
export function nodeInstallScript(source: Extract<NodeSource, { kind: 'nodejs' }>, mirror = nodeMirror()): string {
  return [
    ...NODE_SCRIPT_START,
    `base=${shellQuote(`${mirror}/${source.line}`)}`,
    `os=${shellQuote(source.os)}; arch=${shellQuote(source.arch)}`,
    'fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || { echo "step-error=could not download $base/SHASUMS256.txt"; exit 3; }',
    'line="$(grep -E "  node-v[0-9.]+-$os-$arch\\.tar\\.gz\\$" "$tmp/SHASUMS256.txt" | head -n 1)"',
    '[ -n "$line" ] || { echo "step-error=nodejs.org has no Node build for $os-$arch"; exit 3; }',
    'expected="${line%% *}"; name="${line##* }"',
    'fetch "$base/$name" "$tmp/$name" || { echo "step-error=could not download $base/$name"; exit 3; }',
    'actual="$(sha256 "$tmp/$name")"',
    '[ "$actual" = "$expected" ] || { echo "step-error=checksum mismatch for $name: expected $expected, got $actual"; exit 4; }',
    'mkdir "$tmp/unpacked"',
    'tar -xzf "$tmp/$name" -C "$tmp/unpacked"',
    'mv "$tmp/unpacked/${name%.tar.gz}" "$dir/node.new"',
    ...NODE_SCRIPT_END,
  ].join('\n');
}

/** MacPorts' Node, made to live in ClikCode's own directory: each pinned
 * archive downloaded and its SHA-256 checked before anything is unpacked;
 * bin/node and every /opt/local/lib library it loads, followed library by
 * library with `otool -L`, copied into lib/; each such reference (and each
 * library's own id) rewritten to @loader_path/../lib/ with install_name_tool;
 * every file changed ad-hoc signed again (`codesign -f -s -`); npm beside it
 * as bin/npm and bin/npx. Nothing goes in /opt/local, nothing needs sudo.
 * The tools are Apple's command line tools, which a Mac with Apple's git has. */
export function macportsInstallScript(source: Extract<NodeSource, { kind: 'macports' }>, mirror = macportsMirror()): string {
  const { node, libs, npm } = source.pinned;
  return [
    ...NODE_SCRIPT_START,
    'for tool in otool install_name_tool codesign; do command -v "$tool" >/dev/null 2>&1 || { echo "step-error=$tool is missing: it is one of the Xcode command line tools (xcode-select --install)"; exit 3; }; done',
    `base=${shellQuote(mirror)}`,
    'mkdir "$tmp/x"',
    // Every archive is checked before any is unpacked.
    'get() { fetch "$base/$1/$2" "$tmp/$2" || { echo "step-error=could not download $base/$1/$2"; exit 3; }; actual="$(sha256 "$tmp/$2")"; [ "$actual" = "$3" ] || { echo "step-error=checksum mismatch for $2: expected $3, got $actual"; exit 4; }; }',
    ...[node, ...libs, npm].map((archive) => `get ${shellQuote(archive.port)} ${shellQuote(archive.file)} ${shellQuote(archive.sha256)}`),
    ...[node, ...libs, npm].map((archive) => `tar -xjf "$tmp/"${shellQuote(archive.file)} -C "$tmp/x" || { echo ${shellQuote(`step-error=could not unpack ${archive.file}`)}; exit 6; }`),
    'from="$tmp/x/opt/local"',
    'new="$dir/node.new"',
    'mkdir -p "$new/bin" "$new/lib/node_modules"',
    'cp "$from/bin/node" "$new/bin/node"',
    'chmod 755 "$new/bin/node"',
    // `run FILE COMMAND...`: a failure says which tool, on which file, and what it said.
    'run() { on="${1##*/}"; shift; out="$("$@" 2>&1)" || { echo "step-error=$1 failed on $on: $(oneline "$out")"; exit 6; }; }',
    // Until a pass copies nothing: each file's /opt/local/lib references,
    // the library copied in when it is not yet, the reference rewritten.
    'more=1',
    'while [ "$more" = 1 ]; do',
    '  more=0',
    '  for f in "$new/bin/node" "$new"/lib/*.dylib; do',
    '    [ -f "$f" ] || continue',
    '    listed="$(otool -L "$f")" || { echo "step-error=otool -L ${f##*/} failed: $(oneline "$listed")"; exit 6; }',
    `    for d in $(printf '%s\\n' "$listed" | tail -n +2 | awk '{print $1}' | grep '^/opt/local/lib/' || true); do`,
    '      b="${d##*/}"',
    '      if [ ! -e "$new/lib/$b" ]; then',
    '        [ -e "$from/lib/$b" ] || { echo "step-error=${f##*/} needs $d, which no MacPorts archive ClikCode fetched has"; exit 6; }',
    '        cp "$from/lib/$b" "$new/lib/$b"; chmod 755 "$new/lib/$b"; more=1',
    '      fi',
    '      [ "${f##*/}" = "$b" ] || run "$f" install_name_tool -change "$d" "@loader_path/../lib/$b" "$f"',
    '    done',
    '  done',
    'done',
    'for f in "$new"/lib/*.dylib; do [ -f "$f" ] || continue; run "$f" install_name_tool -id "@loader_path/../lib/${f##*/}" "$f"; done',
    'for f in "$new/bin/node" "$new"/lib/*.dylib; do [ -f "$f" ] || continue; run "$f" codesign -f -s - "$f"; done',
    // npm, run by this node whatever its scripts' #! lines say (/opt/local/bin/node).
    'cp -R "$from/lib/node_modules/npm" "$new/lib/node_modules/npm"',
    `for t in npm npx; do printf '#!/bin/sh\\nd="$(cd "$(dirname "$0")" && pwd)"\\nexec "$d/node" "$d/../lib/node_modules/npm/bin/%s-cli.js" "$@"\\n' "$t" > "$new/bin/$t"; chmod 755 "$new/bin/$t"; done`,
    // A node that does not run is said by the run below, in its own words.
    'if "$new/bin/node" -v >/dev/null 2>&1 && ! out="$("$new/bin/npm" -v 2>&1)"; then echo "step-error=npm does not run: $(oneline "$out")"; exit 6; fi',
    `echo ${shellQuote(`sha256=${node.sha256}`)}`,
    ...NODE_SCRIPT_END,
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
 * rather than the tip of main -- the editor's own build, which main may have
 * moved past -- which install-local refuses to build from: so it is built
 * first and installed as it is (`--force`, and `--even-if-behind`: here being
 * behind main is the point, not a stale checkout). */
export function buildScript(pinned = false): string {
  return [
    'set -eu',
    withOwnNode,
    `cd ${SHARE}/src`,
    `pm="$(node -e "const p=require('./package.json').packageManager||'';process.stdout.write(p.startsWith('pnpm@')?p.slice(5).split('+')[0]:'')" 2>/dev/null || true)"`,
    `if [ -n "$pm" ] && command -v corepack >/dev/null 2>&1; then pnpm() { COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@"; }; else pnpm() { npx --yes "pnpm@\${pm:-${PNPM_FALLBACK}}" "$@"; }; fi`,
    'pnpm install --frozen-lockfile',
    ...(pinned ? ['pnpm run build', 'pnpm run install-local --force --even-if-behind'] : ['pnpm run install-local']),
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
  if (!nodePlatform(probe)) return fail('Checking the machine', `${target} is ${probe.os || 'an unknown OS'} on ${probe.arch || 'an unknown CPU'}; ClikCode Remote installs on Linux and macOS (x64, arm64).`);
  if (probe.clikcode === 'other') return fail('Checking the machine', `${target} already has a ~/.local/bin/clikcode that ClikCode Remote did not install. Move it away (or remove it) and choose the machine again.`);
  // A Node counts only when it runs (the probe ran `node -v`) and is new
  // enough. Without one, where Node would come from is decided here, and a
  // machine nothing runs on is refused before anything is downloaded.
  const ownUsable = nodeIsNewEnough(probe.ownNodeVersion);
  const systemUsable = nodeIsNewEnough(probe.nodeVersion);
  const source = options.update || ownUsable || systemUsable ? undefined : nodeSource(probe, target);
  if (source?.kind === 'refused') return fail('Checking the machine', source.message);
  reporter.done('Checking the machine', probe.os === 'Darwin' ? `macOS${probe.macos ? ` ${probe.macos}` : ''} ${probe.arch}` : `${probe.os} ${probe.arch}`);

  if (!options.update) {
    progress.begin('Node.js');
    const node = await nodeStep(target, probe, source);
    if (!node.ok) return fail('Node.js', node.message);
    reporter.done('Node.js', node.detail);

    progress.begin('git');
    if (!probe.git) {
      const remedy = probe.os === 'Darwin' ? 'run `xcode-select --install` there' : "install it with the machine's package manager (for example `sudo apt install git`)";
      return fail('git', `${target} has no git. ClikCode never uses sudo: ${remedy}, then choose the machine again.`);
    }
    reporter.done('git', probe.git);
  }

  // No `running` commit: over SSH every update is built and checked.
  const updated = await runManagedUpdate(sshRunner(target), target, progress, options.commit ? { commit: options.commit } : {});
  if (!updated.ok) return updated;
  if (updated.upToDate) return fail('Checking the install', `ClikCode on ${target} was not checked.`);
  return { ok: true, info: updated.info, probe, ...(updated.from ? { from: updated.from } : {}) };
}

/** Step 2: the Node the machine has, or one installed from `source` and
 * run. ClikCode's own Node from an earlier install that no longer runs (or
 * is too old) is never reused: it is replaced, or -- with a usable node on
 * PATH -- removed, as every later step puts it first on PATH. */
async function nodeStep(target: string, probe: Probe, source: NodeSource | undefined): Promise<{ ok: true; detail: string } | { ok: false; message: string }> {
  const yourself = `Install Node.js ${MIN_NODE.join('.')} or newer there yourself, then choose the machine again.`;
  const ownThere = Boolean(probe.ownNodeVersion || probe.ownNodeError);
  const ownWas = probe.ownNodeError ? 'no longer ran' : 'was too old';
  if (nodeIsNewEnough(probe.ownNodeVersion)) return { ok: true, detail: `ClikCode's own ${probe.ownNodeVersion}` };
  if (!source) {
    if (ownThere) {
      const removed = await runSsh(target, `rm -rf ${SHARE}/node && echo removed=ok`, { timeoutMs: 60_000 });
      if (keyValues(removed.stdout).get('removed') !== 'ok') return { ok: false, message: `Removing ClikCode's own Node on ${target}, which ${ownWas}, failed: ${sshFailure(removed) ? sshFailureMessage(target, removed) : stepError(removed)}.` };
    }
    return { ok: true, detail: `${probe.nodeVersion} (already installed)${ownThere ? `; ClikCode's own Node, which ${ownWas}, removed` : ''}` };
  }
  if (source.kind === 'refused') return { ok: false, message: source.message };
  const from = nodeSourceText(source);
  const result = await runSsh(target, source.kind === 'nodejs' ? nodeInstallScript(source) : macportsInstallScript(source), { timeoutMs: STEP_TIMEOUT_MS });
  if (result.code !== 0) {
    if (sshFailure(result)) return { ok: false, message: sshFailureMessage(target, result) };
    const said = stepError(result);
    if (said.startsWith('node-fails')) return { ok: false, message: `Node.js from ${from} was installed on ${target} but does not run: ${said.slice(10).trim() || `exit ${result.code}`}. ${yourself}` };
    return { ok: false, message: `Installing Node.js from ${from} on ${target} failed: ${said}. ${yourself}` };
  }
  const version = keyValues(result.stdout).get('nodeVersion');
  if (!nodeIsNewEnough(version)) return { ok: false, message: `Node.js from ${from} on ${target} runs but says it is ${version || 'no version'}; ClikCode needs ${MIN_NODE.join('.')} or newer. ${yourself}` };
  const notes = [
    ...(probe.nodeError ? [`the node at ${probe.node} does not run, so it is not used`] : []),
    ...(ownThere ? [`it replaces ClikCode's own Node, which ${ownWas}`] : []),
  ];
  return { ok: true, detail: `${version} from ${from} into ~/.local/share/clikcode/node (${source.kind === 'nodejs' ? 'SHA-256 checked' : 'SHA-256 pinned'}, runs)${notes.length ? `; ${notes.join('; ')}` : ''}` };
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
    const rerun = pinned ? 'pnpm install --frozen-lockfile && pnpm run build && pnpm run install-local --force --even-if-behind' : 'pnpm install --frozen-lockfile && pnpm run install-local';
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
