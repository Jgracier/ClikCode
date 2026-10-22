#!/usr/bin/env node
/** Fake machines for ClikCode Remote's tests (vitest and the pty e2e).
 * Nothing here touches a real machine, the network, or a real vendor CLI.
 *
 *   world(root)            a fake ClikCode repository (bare, file://) whose
 *                          `install-local` installs a fake `clikcode`
 *                          (fake-remote-clikcode.mjs: --version, remote-info,
 *                          ide-bridge --stdio with fixture chats), and a fake
 *                          nodejs.org mirror with a tarball and SHASUMS256.txt
 *   host(root, name, opts) a machine fake-ssh.mjs connects to: its HOME, a
 *                          PATH of chosen system tools (hide some to make git
 *                          or Node "missing"), a fake `npx` standing in for
 *                          pnpm, and how it behaves (users, offline, windows)
 *
 *   installAt(...)         that machine with ClikCode already installed at
 *                          a given commit
 *
 * CLI, for run.py:  node fake-remote.mjs world <root> ['{"second":true}']
 *                   node fake-remote.mjs host <root> <name> '<json opts>'
 *                   node fake-remote.mjs install <root> <name> '{"repoUrl","commit"}' */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_NODE_VERSION = 'v24.99.0';

const TOOLS = ['sh', 'bash', 'uname', 'readlink', 'mkdir', 'mktemp', 'rm', 'rmdir', 'mv', 'cp', 'ln', 'grep', 'head', 'tail', 'tar', 'gzip',
  'curl', 'sha256sum', 'shasum', 'sed', 'dirname', 'basename', 'cat', 'ls', 'chmod', 'env', 'printf', 'sleep', 'awk', 'tr', 'cut',
  'git', 'node', 'id', 'touch', 'wc', 'sort', 'test', 'true', 'false', 'find', 'xargs', 'stat'];

const which = (tool) => {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8', env: { PATH: process.env.PATH } }).stdout.trim();
  return found.startsWith('/') ? found : undefined;
};

export function nodePlatform() {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return { os, arch };
}

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'fake', GIT_AUTHOR_EMAIL: 'fake@example.invalid', GIT_COMMITTER_NAME: 'fake', GIT_COMMITTER_EMAIL: 'fake@example.invalid', GIT_CONFIG_NOSYSTEM: '1', HOME: cwd },
}).trim();

/** The fake repository and Node mirror. Returns their URLs and the commit. */
export function world(root, options = {}) {
  mkdirSync(join(root, 'hosts'), { recursive: true });
  const work = join(root, 'repo-work');
  mkdirSync(join(work, 'scripts'), { recursive: true });
  writeFileSync(join(work, 'package.json'), `${JSON.stringify({ name: 'clikcode', version: '1.0.0', type: 'module', scripts: { build: 'node scripts/build.mjs', 'install-local': 'node scripts/install-local.mjs' } }, null, 2)}\n`);
  writeFileSync(join(work, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  copyFileSync(join(HERE, 'fake-remote-clikcode.mjs'), join(work, 'scripts', 'clikcode.mjs'));
  writeFileSync(join(work, 'scripts', 'install-local.mjs'), INSTALL_LOCAL);
  writeFileSync(join(work, 'scripts', 'build.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('built', 'yes');\nconsole.log('built');\n");
  writeFileSync(join(work, '.gitignore'), 'node_modules\nbuilt\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'fake ClikCode');
  const bare = join(root, 'repo.git');
  git(root, 'clone', '-q', '--bare', work, bare);
  const commit = git(work, 'rev-parse', 'HEAD');
  // A newer commit on main, the older one kept as `first`: a machine
  // installed at `first` is behind (installAt).
  let first;
  if (options.second) {
    first = commit;
    writeFileSync(join(work, 'NEWS'), 'second\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'second');
    git(work, 'push', '-q', bare, 'main');
  }
  const head = git(work, 'rev-parse', 'HEAD');

  const mirror = join(root, 'mirror');
  const line = join(mirror, 'latest-v24.x');
  const { os, arch } = nodePlatform();
  const name = `node-${FAKE_NODE_VERSION}-${os}-${arch}`;
  const staging = join(root, 'node-staging', name, 'bin');
  mkdirSync(staging, { recursive: true });
  mkdirSync(line, { recursive: true });
  // The "downloaded" Node is the real one behind a wrapper.
  writeFileSync(join(staging, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  chmodSync(join(staging, 'node'), 0o755);
  execFileSync('tar', ['-czf', join(line, `${name}.tar.gz`), '-C', join(root, 'node-staging'), name]);
  const digest = createHash('sha256').update(readFileSync(join(line, `${name}.tar.gz`))).digest('hex');
  const listed = options.badChecksum ? digest.replace(/^./, (c) => (c === '0' ? '1' : '0')) : digest;
  writeFileSync(join(line, 'SHASUMS256.txt'), `${'0'.repeat(64)}  node-${FAKE_NODE_VERSION}-aix-ppc64.tar.gz\n${listed}  ${name}.tar.gz\n`);
  return { repoUrl: `file://${bare}`, mirrorUrl: `file://${mirror}`, commit: head, ...(first ? { first } : {}), bare, work };
}

/** One fake machine. `hide`: tools left off its PATH ('git', 'node').
 * `oldNode`: its `node` says this version. `chats`: its ClikCode's
 * conversations (IdeConversation[]); `commit`: what its ClikCode reports. */
export function host(root, name, options = {}) {
  const machine = join(root, 'hosts', name);
  const bin = join(machine, 'bin');
  const home = join(machine, 'home');
  for (const dir of [bin, home, join(machine, 'tmp'), join(home, '.fake-remote')]) mkdirSync(dir, { recursive: true });
  const hidden = new Set([...(options.hide ?? []), ...(options.uname ? ['uname'] : [])]);
  // A machine of another OS: `uname -s` / `uname -m` say so.
  if (options.uname) {
    writeFileSync(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -m) echo ${options.uname.m ?? 'x86_64'};; *) echo ${options.uname.s ?? 'Linux'};; esac\n`);
    chmodSync(join(bin, 'uname'), 0o755);
  }
  for (const tool of TOOLS) {
    if (hidden.has(tool) || existsSync(join(bin, tool))) continue;
    if (tool === 'node' && options.oldNode) {
      writeFileSync(join(bin, 'node'), `#!/bin/sh\nif [ "$1" = -v ]; then echo ${options.oldNode}; exit 0; fi\necho "node ${options.oldNode} is too old" >&2\nexit 1\n`);
      chmodSync(join(bin, 'node'), 0o755);
      continue;
    }
    const found = tool === 'node' ? process.execPath : which(tool);
    if (found) symlinkSync(found, join(bin, tool));
  }
  // pnpm, through `npx --yes pnpm@N ...`: install makes node_modules, `run install-local` runs it.
  writeFileSync(join(bin, 'npx'), [
    '#!/bin/sh',
    'echo "npx $*" >> "$HOME/.fake-remote/npx.log"',
    '[ "$1" = --yes ] && shift',
    'case "$1" in pnpm@*) shift;; *) echo "fake npx: only pnpm" >&2; exit 2;; esac',
    'case "$1" in',
    '  install) [ -n "${FAKE_PNPM_DELAY:-}" ] && sleep "$FAKE_PNPM_DELAY"; mkdir -p node_modules/.fake; exit 0;;',
    '  run) [ -d node_modules ] || { echo "run pnpm install first" >&2; exit 1; }; shift; name="$1"; shift',
    '       cmd="$(node -e "process.stdout.write((require(\'./package.json\').scripts||{})[process.argv[1]]||\'\')" "$name")"',
    '       [ -n "$cmd" ] || { echo "fake npx: no script $name" >&2; exit 1; }',
    '       exec /bin/sh -c "$cmd \\"\\$@\\"" sh "$@";;',
    'esac',
    'echo "fake npx: unknown pnpm command $1" >&2; exit 2',
  ].join('\n'));
  chmodSync(join(bin, 'npx'), 0o755);
  writeFileSync(join(machine, 'config.json'), JSON.stringify({
    ...(options.users ? { users: options.users } : {}), ...(options.offline ? { offline: true } : {}), ...(options.windows ? { windows: true } : {}),
    ...(options.env ? { env: options.env } : {}), ...(options.latencyMs ? { latencyMs: options.latencyMs } : {}),
    ...(options.countBytes ? { countBytes: true } : {}),
  }));
  writeFileSync(join(home, '.fake-remote', 'chats.json'), JSON.stringify(options.chats ?? []));
  if (options.commit) writeFileSync(join(home, '.fake-remote', 'commit'), options.commit);
  if (options.later) writeFileSync(join(home, '.fake-remote', 'later.json'), JSON.stringify(options.later));
  return { machine, home, bin };
}

/** A machine (made by `host`) that already has ClikCode Remote's install
 * of `commit`, as an install of it would have left it: the clone at that
 * commit, built, installed with `install-local --force`. */
export function installAt(root, name, repoUrl, commit) {
  const machine = join(root, 'hosts', name);
  const home = join(machine, 'home');
  const src = join(home, '.local', 'share', 'clikcode', 'src');
  mkdirSync(dirname(src), { recursive: true });
  const env = { HOME: home, PATH: join(machine, 'bin'), GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
  const run = (file, args, cwd = src) => execFileSync(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  run('git', ['clone', '-q', repoUrl, src], home);
  run('git', ['reset', '-q', '--hard', commit]);
  mkdirSync(join(src, 'node_modules', '.fake'), { recursive: true });
  run('node', ['scripts/build.mjs']);
  run('node', ['scripts/install-local.mjs', '--force']);
  return { src };
}

/** `tailscale status --json`, shaped as a real one (2026-10), with machines
 * to filter: the user's own Linux and macOS machines online, one seen two
 * days ago, an old offline node of a machine that is online under its new
 * node (same base name), one not seen for 50 days, a phone, a Windows PC
 * shared in from another user, and another user's laptop. `hosts` renames
 * DNS names so they match fake ssh hosts. */
export function tailscaleFixture(now = Date.now()) {
  const ago = (days) => new Date(now - days * 86_400_000).toISOString();
  const ZERO = '0001-01-01T00:00:00Z';
  const me = 1001;
  const node = (id, HostName, label, OS, UserID, Online, LastSeen, extra = {}) => ({
    ID: id, PublicKey: `nodekey:${id}`, HostName, DNSName: `${label}.tail-fake.ts.net.`, OS, UserID,
    TailscaleIPs: [`100.64.0.${id.length}`], Online, LastSeen, Active: Online, ShareeNode: null, Tags: null, ...extra,
  });
  return {
    Version: '1.90.0', TUN: true, BackendState: 'Running', MagicDNSSuffix: 'tail-fake.ts.net',
    Self: node('nSelf', 'workstation', 'workstation', 'linux', me, true, ZERO),
    User: { [me]: { LoginName: 'me@example.invalid', DisplayName: 'Me' }, 2002: { LoginName: 'friend@example.invalid', DisplayName: 'Friend' } },
    Peer: {
      'nodekey:a': node('nBox', 'devbox', 'devbox', 'linux', me, true, ZERO),
      'nodekey:b': node('nMac', 'my-macbook', 'macbook', 'macOS', me, false, ago(2)),
      'nodekey:c': node('nOldMac', 'Studio’s-iMac', 'studios-imac', 'macOS', me, false, ago(20)),
      'nodekey:d': node('nNewMac', 'studios-imac', 'imac', 'macOS', me, true, ZERO),
      'nodekey:e': node('nStale', 'old-server', 'old-server', 'linux', me, false, ago(50)),
      'nodekey:f': node('nPhone', 'localhost', 'iphone', 'iOS', me, true, ago(0)),
      'nodekey:g': node('nShared', 'gaming-pc', 'gaming-pc', 'windows', 2002, true, ZERO, { ShareeNode: true }),
      'nodekey:h': node('nFriend', 'friends-laptop', 'friends-laptop', 'macOS', 2002, true, ZERO),
      'nodekey:i': node('nWin', 'my-windows', 'winbox', 'windows', me, true, ZERO),
    },
  };
}

/** What the fake `clikcode install-local` does: what the real one does, minus the build. */
const INSTALL_LOCAL = `import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const force = process.argv.includes('--force');
if (!force) {
  git('fetch', '-q', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) { console.error('not installing: HEAD is not origin/main'); process.exit(1); }
} else if (!existsSync('built')) { console.error('dist is missing: build first'); process.exit(1); }
if (!existsSync('node_modules')) { console.error('node_modules is missing'); process.exit(1); }
const release = join(homedir(), '.local', 'share', 'clikcode', 'release');
rmSync(release, { recursive: true, force: true });
mkdirSync(join(release, 'dist'), { recursive: true });
copyFileSync('scripts/clikcode.mjs', join(release, 'dist', 'index.js'));
chmodSync(join(release, 'dist', 'index.js'), 0o755);
writeFileSync(join(release, 'commit'), git('rev-parse', 'HEAD'));
const bin = join(homedir(), '.local', 'bin', 'clikcode');
mkdirSync(join(homedir(), '.local', 'bin'), { recursive: true });
if (lstatSync(bin, { throwIfNoEntry: false })) unlinkSync(bin);
symlinkSync(join(release, 'dist', 'index.js'), bin);
console.log('installed');
`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, root, name, json] = process.argv.slice(2);
  if (command === 'world') process.stdout.write(`${JSON.stringify(world(root, name ? JSON.parse(name) : {}))}\n`);
  else if (command === 'tailscale') process.stdout.write(`${JSON.stringify(tailscaleFixture(), null, 2)}\n`);
  else if (command === 'host') process.stdout.write(`${JSON.stringify(host(root, name, json ? JSON.parse(json) : {}))}\n`);
  else if (command === 'install') { const { repoUrl, commit } = JSON.parse(json); process.stdout.write(`${JSON.stringify(installAt(root, name, repoUrl, commit))}\n`); }
  else { process.stderr.write('usage: fake-remote.mjs world <root> | host <root> <name> [json]\n'); process.exit(2); }
}
