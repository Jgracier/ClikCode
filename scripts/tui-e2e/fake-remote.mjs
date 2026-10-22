#!/usr/bin/env node
/** Fake machines for ClikCode Remote's tests (vitest and the pty e2e).
 * Nothing here touches a real machine, the network, or a real vendor CLI.
 *
 *   world(root)            a fake ClikCode repository (bare, file://) whose
 *                          `install-local` installs a fake `clikcode`
 *                          (fake-remote-clikcode.mjs: --version, remote-info,
 *                          ide-bridge --stdio with fixture chats), a fake
 *                          nodejs.org mirror (latest-v24.x and latest-v22.x:
 *                          tarballs and SHASUMS256.txt), and a fake
 *                          packages.macports.org (macportsMirror, macportsPins):
 *                          nodejs22, zlib, icu and npm10 archives whose
 *                          "Mach-O" files are scripts naming their load
 *                          commands, checked by a fake dyld when node runs
 *   host(root, name, opts) a machine fake-ssh.mjs connects to: its HOME, a
 *                          PATH of chosen system tools (hide some to make git
 *                          or Node "missing"), a fake `npx` standing in for
 *                          pnpm, and how it behaves (users, offline, windows,
 *                          sw_vers, a node that does not run, Apple's otool /
 *                          install_name_tool / codesign as fakes that log)
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
export const FAKE_NODE22_VERSION = 'v22.99.0';
/** What MacPorts' fake nodejs22 says it is. */
export const MACPORTS_NODE_VERSION = 'v22.22.2';

const TOOLS = ['sh', 'bash', 'uname', 'readlink', 'mkdir', 'mktemp', 'rm', 'rmdir', 'mv', 'cp', 'ln', 'grep', 'head', 'tail', 'tar', 'gzip',
  'curl', 'sha256sum', 'shasum', 'sed', 'dirname', 'basename', 'cat', 'ls', 'chmod', 'env', 'printf', 'sleep', 'awk', 'tr', 'cut', 'bzip2',
  'git', 'node', 'id', 'touch', 'wc', 'sort', 'test', 'true', 'false', 'find', 'xargs', 'stat', 'script', 'stty', 'dd', 'mkfifo'];

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

  // nodejs.org: each line's tarballs for this machine's platform and both
  // macOS ones (a fake Mac is this machine underneath). Its node is the real
  // one behind a wrapper that says the line's version -- or, `brokenNode`,
  // fails as a build for a newer macOS does.
  const mirror = join(root, 'mirror');
  const platforms = [nodePlatform(), { os: 'darwin', arch: 'x64' }, { os: 'darwin', arch: 'arm64' }]
    .filter((item, at, all) => all.findIndex((other) => other.os === item.os && other.arch === item.arch) === at);
  for (const [lineName, version] of [['latest-v24.x', FAKE_NODE_VERSION], ['latest-v22.x', FAKE_NODE22_VERSION]]) {
    const line = join(mirror, lineName);
    mkdirSync(line, { recursive: true });
    const sums = [`${'0'.repeat(64)}  node-${version}-aix-ppc64.tar.gz`];
    for (const { os, arch } of platforms) {
      const name = `node-${version}-${os}-${arch}`;
      const staging = join(root, 'node-staging', lineName, name, 'bin');
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, 'node'), options.brokenNode
        ? `#!/bin/sh\necho "dyld: Symbol not found: __ZNSt3__122__libcpp_verbose_abortEPKcz" >&2\necho "  Expected in: /usr/lib/libc++.1.dylib (built for Mac OS X 13.5)" >&2\nexit 134\n`
        : `#!/bin/sh\nif [ "$1" = -v ]; then echo ${version}; exit 0; fi\nexec ${process.execPath} "$@"\n`);
      chmodSync(join(staging, 'node'), 0o755);
      execFileSync('tar', ['-czf', join(line, `${name}.tar.gz`), '-C', join(root, 'node-staging', lineName), name]);
      const digest = createHash('sha256').update(readFileSync(join(line, `${name}.tar.gz`))).digest('hex');
      sums.push(`${options.badChecksum ? digest.replace(/^./, (c) => (c === '0' ? '1' : '0')) : digest}  ${name}.tar.gz`);
    }
    writeFileSync(join(line, 'SHASUMS256.txt'), `${sums.join('\n')}\n`);
  }
  const macports = macportsWorld(root);
  return { repoUrl: `file://${bare}`, mirrorUrl: `file://${mirror}`, ...macports, commit: head, ...(first ? { first } : {}), bare, work };
}

/** A fake "Mach-O" file: a script whose comment lines are its load
 * commands (`# LC_ID_DYLIB path`, `# LC_LOAD_DYLIB path`) and its code
 * signature (`# CODESIG valid|invalid|adhoc`), which the fake otool,
 * install_name_tool and codesign read and edit. */
const machO = (body, id, loads) => [
  ...(body ? [body] : ['#!/bin/sh', 'exit 0']),
  ...(id ? [`# LC_ID_DYLIB ${id}`] : []),
  ...loads.map((path) => `# LC_LOAD_DYLIB ${path}`),
  '# CODESIG valid', '',
].join('\n');

/** The fake dyld, run by the fake node before anything else: every library
 * loaded, from node on, resolved (@loader_path is the loading file's
 * directory; /usr/lib and /System are the system's; /opt/local is not on
 * this machine) and every image's signature valid; else what dyld says. */
const FAKE_DYLD = `const { existsSync, readFileSync, realpathSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const seen = new Set();
const fail = (text) => { process.stderr.write(text + '\\n'); process.exit(134); };
const visit = (file, from) => {
  const real = realpathSync(file);
  if (seen.has(real)) return;
  seen.add(real);
  const text = readFileSync(real, 'utf8');
  if (/^# CODESIG invalid$/m.test(text)) fail('dyld: code signature invalid for ' + file);
  for (const [, path] of text.matchAll(/^# LC_LOAD_DYLIB (\\S+)$/gm)) {
    if (/^\\/(usr\\/lib|System)\\//.test(path)) continue;
    const at = path.startsWith('@loader_path/') ? resolve(dirname(file), path.slice(13)) : path;
    if (path.startsWith('/opt/local/') || !existsSync(at)) fail('dyld: Library not loaded: ' + path + '\\n  Referenced from: ' + file + '\\n  Reason: image not found');
    visit(at, file);
  }
};
visit(process.argv[1]);
`;

/** packages.macports.org, faked: `<root>/macports/<port>/<archive>.tbz2`.
 * Returns its URL and the pins (the table install.ts has, for these fakes). */
export function macportsWorld(root) {
  const mirror = join(root, 'macports');
  const pins = { node: undefined, libs: [], npm: undefined };
  const archive = (port, file, files) => {
    const staging = join(root, 'macports-staging', file);
    for (const [path, content, link] of files) {
      const at = join(staging, 'opt', 'local', path);
      mkdirSync(dirname(at), { recursive: true });
      if (link) symlinkSync(link, at);
      else { writeFileSync(at, content); chmodSync(at, 0o755); }
    }
    writeFileSync(join(staging, '+CONTENTS'), `@name ${file}\n`);
    mkdirSync(join(mirror, port), { recursive: true });
    execFileSync('tar', ['-cjf', join(mirror, port, file), '-C', staging, '.']);
    return { port, file, sha256: createHash('sha256').update(readFileSync(join(mirror, port, file))).digest('hex') };
  };
  const lib = '/opt/local/lib';
  const nodeBody = [
    '#!/bin/sh',
    `${process.execPath} -e "$(cat <<'DYLD'\n${FAKE_DYLD}DYLD\n)" "$0" || exit 134`,
    `if [ "$1" = -v ]; then echo ${MACPORTS_NODE_VERSION}; exit 0; fi`,
    `exec ${process.execPath} "$@"`,
  ].join('\n');
  pins.node = archive('nodejs22', 'nodejs22-22.22.2_0.darwin_19.x86_64.tbz2', [
    ['bin/node', machO(nodeBody, undefined, [`${lib}/libz.1.dylib`, `${lib}/libicui18n.78.dylib`, `${lib}/libicuuc.78.dylib`, '/usr/lib/libc++.1.dylib', '/usr/lib/libSystem.B.dylib'])],
  ]);
  pins.libs.push(archive('zlib', 'zlib-1.3.2_0.darwin_19.x86_64.tbz2', [
    ['lib/libz.1.3.2.dylib', machO('', `${lib}/libz.1.dylib`, ['/usr/lib/libSystem.B.dylib'])],
    ['lib/libz.1.dylib', '', 'libz.1.3.2.dylib'], ['lib/libz.dylib', '', 'libz.1.3.2.dylib'],
  ]));
  pins.libs.push(archive('icu', 'icu-78.3_1.darwin_19.x86_64.tbz2', [
    ['lib/libicudata.78.3.dylib', machO('', `${lib}/libicudata.78.dylib`, ['/usr/lib/libSystem.B.dylib'])],
    ['lib/libicuuc.78.3.dylib', machO('', `${lib}/libicuuc.78.dylib`, [`${lib}/libicudata.78.dylib`, '/usr/lib/libc++.1.dylib'])],
    ['lib/libicui18n.78.3.dylib', machO('', `${lib}/libicui18n.78.dylib`, [`${lib}/libicuuc.78.dylib`, `${lib}/libicudata.78.dylib`])],
    ['lib/libicuio.78.3.dylib', machO('', `${lib}/libicuio.78.dylib`, [`${lib}/libicuuc.78.dylib`])],
    ...['icudata', 'icuuc', 'icui18n', 'icuio'].map((name) => [`lib/lib${name}.78.dylib`, '', `lib${name}.78.3.dylib`]),
  ]));
  // npm, as MacPorts ships it: #! lines naming /opt/local/bin/node. Its npx
  // hands pnpm to the machine's fake npx (host()), saying it was used.
  const npmCli = `#!/opt/local/bin/node\nif (process.argv[2] === '-v' || process.argv[2] === '--version') { console.log('10.9.8'); process.exit(0); }\nconsole.error('fake MacPorts npm: only -v'); process.exit(2);\n`;
  const npxCli = `#!/opt/local/bin/node\nconst { appendFileSync } = require('node:fs');\nconst { spawnSync } = require('node:child_process');\nappendFileSync(process.env.HOME + '/.fake-remote/macports-npx.log', process.execPath + ' ' + process.argv.slice(2).join(' ') + '\\n');\nconst run = spawnSync(process.env.FAKE_MACHINE + '/bin/npx', process.argv.slice(2), { stdio: 'inherit' });\nprocess.exit(run.status ?? 1);\n`;
  pins.npm = archive('npm10', 'npm10-10.9.8_0.any_any.noarch.tbz2', [
    ['lib/node_modules/npm/bin/npm-cli.js', npmCli], ['lib/node_modules/npm/bin/npx-cli.js', npxCli],
    ['bin/npm', '', '../lib/node_modules/npm/bin/npm-cli.js'], ['bin/npx', '', '../lib/node_modules/npm/bin/npx-cli.js'],
  ]);
  return { macportsMirror: `file://${mirror}`, macportsPins: { 19: { version: MACPORTS_NODE_VERSION, ...pins } } };
}

/** Apple's tools on a fake Mac, over the fake Mach-O files: each call logged
 * to ~/.fake-remote/tools.log. */
const FAKE_APPLE_TOOLS = {
  otool: `const [flag, file] = process.argv.slice(2);
if (flag !== '-L') { console.error('fake otool: only -L'); process.exit(1); }
const text = require('node:fs').readFileSync(file, 'utf8');
const lines = [...text.matchAll(/^# LC_(?:ID|LOAD)_DYLIB (\\S+)$/gm)].map((m) => '\\t' + m[1] + ' (compatibility version 1.0.0, current version 1.0.0)');
if (!/^# CODESIG/m.test(text)) { console.error('fake otool: ' + file + ': is not an object file'); process.exit(1); }
console.log(file + ':\\n' + lines.join('\\n'));`,
  install_name_tool: `const args = process.argv.slice(2);
const file = args.at(-1);
let text = require('node:fs').readFileSync(file, 'utf8');
if (args[0] === '-change') text = text.split('# LC_LOAD_DYLIB ' + args[1] + '\\n').join('# LC_LOAD_DYLIB ' + args[2] + '\\n');
else if (args[0] === '-id') text = text.replace(/^# LC_ID_DYLIB \\S+$/m, '# LC_ID_DYLIB ' + args[1]);
else { console.error('fake install_name_tool: only -change and -id'); process.exit(1); }
require('node:fs').writeFileSync(file, text.replace(/^# CODESIG \\w+$/m, '# CODESIG invalid'));`,
  codesign: `const args = process.argv.slice(2);
if (args.join(' ') !== '-f -s - ' + args.at(-1)) { console.error('fake codesign: only -f -s - FILE'); process.exit(1); }
const fs = require('node:fs');
fs.writeFileSync(args.at(-1), fs.readFileSync(args.at(-1), 'utf8').replace(/^# CODESIG \\w+$/m, '# CODESIG adhoc'));`,
};

/** One fake machine. `hide`: tools left off its PATH ('git', 'node').
 * `oldNode`: its `node` says this version. `brokenNode`: its `node` fails
 * with this message, as a build for a newer macOS does (`ownBrokenNode`:
 * so does ClikCode's own, left by an earlier install). `swVers`: what
 * `sw_vers -productVersion` says (with `uname` for a Mac). `appleTools`:
 * fake otool, install_name_tool and codesign. `chats`: its ClikCode's
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
    if (tool === 'node' && options.brokenNode) {
      writeFileSync(join(bin, 'node'), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(options.brokenNode)} >&2\nexit 134\n`);
      chmodSync(join(bin, 'node'), 0o755);
      continue;
    }
    if (tool === 'node' && options.oldNode) {
      writeFileSync(join(bin, 'node'), `#!/bin/sh\nif [ "$1" = -v ]; then echo ${options.oldNode}; exit 0; fi\necho "node ${options.oldNode} is too old" >&2\nexit 1\n`);
      chmodSync(join(bin, 'node'), 0o755);
      continue;
    }
    const found = tool === 'node' ? process.execPath : which(tool);
    if (found) symlinkSync(found, join(bin, tool));
  }
  if (options.swVers) {
    writeFileSync(join(bin, 'sw_vers'), `#!/bin/sh\n[ "$1" = -productVersion ] && echo ${options.swVers}\n`);
    chmodSync(join(bin, 'sw_vers'), 0o755);
  }
  if (options.appleTools) {
    for (const [name, code] of Object.entries(FAKE_APPLE_TOOLS)) {
      writeFileSync(join(bin, name), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.HOME + '/.fake-remote/tools.log', ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n${code}\n`);
      chmodSync(join(bin, name), 0o755);
    }
  }
  if (options.ownBrokenNode) {
    const own = join(home, '.local', 'share', 'clikcode', 'node', 'bin');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'node'), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(options.ownBrokenNode)} >&2\nexit 134\n`);
    chmodSync(join(own, 'node'), 0o755);
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
