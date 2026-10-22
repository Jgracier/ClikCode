/** ClikCode Remote against FAKE machines: a fake `ssh` that runs the remote
 * command locally inside a temporary HOME (scripts/tui-e2e/fake-ssh.mjs), a
 * fake `tailscale` printing a fixture, a file:// repository standing in for
 * GitHub, and a file:// Node mirror. Nothing connects to a real machine. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error -- a plain .mjs fixture module
import { host, installAt, tailscaleFixture, world } from '../../scripts/tui-e2e/fake-remote.mjs';
import { shellQuote, validateSshTarget, withUser } from './shell.js';
import { defaultLoginUser, runSsh, sshArgv, sshFailure, sshFailureMessage } from './ssh.js';
import { discoverMachines, readTailscaleStatus, type TailscaleStatus } from './tailscale.js';
import { buildScript, installOnMachine, MACPORTS_NODE, nodeIsNewEnough, nodeSource, parseProbe, probeScript, sourceScript, uninstallFromMachine, type InstallStep, type Probe } from './install.js';
import { closeWindowMachines, holdWindowMachines, needsUpdate, RemoteLink, RemoteMachines, type MachineView } from './connection.js';
import { machinesPath, newMachineRecord, readMachines, updateMachines, type RemoteMachine } from './machines.js';
import { isRemoteRowValue, localMachineName, updateText } from './board-rows.js';
import { autoUpdateDecision, AutoUpdates } from './updates.js';
import { outdatedNotice } from './terminal-chat.js';
import { localMoveEnd, moveTerminalChat } from './move-terminal.js';
import { notYetAdded } from '../tui/pickers/remote.js';
import type { IdeConversation } from '../ide/protocol.js';
import type { HarnessPrompter, PickerOption, PickerSettings } from '../harness/prompter.js';

const REPO = resolve(__dirname, '..', '..');
const FAKES = join(REPO, 'scripts', 'tui-e2e');
let root: string;
let fakeWorld: { repoUrl: string; mirrorUrl: string; macportsMirror: string; macportsPins: Record<number, { node: { sha256: string } }>; commit: string; bare: string; work: string };
const savedEnv = { ...process.env };

const steps = () => {
  const seen: Array<{ step: InstallStep; detail: string }> = [];
  return { seen, reporter: { start: () => undefined, done: (step: InstallStep, detail: string) => { seen.push({ step, detail }); } } };
};
const homeOf = (name: string) => join(root, 'hosts', name, 'home');
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

beforeAll(() => {
  // The client (this process) and the fake machines are apart, as two machines are: the
  // suite's temporary directories are inside its HOME (vitest.setup.ts), so the client gets
  // a HOME of its own beside them, which fake-ssh.mjs requires.
  const clientHome = join(savedEnv.HOME!, 'client-home');
  mkdirSync(clientHome, { recursive: true });
  process.env.HOME = clientHome;
  root = mkdtempSync(join(tmpdir(), 'cc-remote-'));
  const bin = join(root, 'local-bin');
  mkdirSync(bin);
  symlinkSync(join(FAKES, 'fake-ssh.mjs'), join(bin, 'ssh'));
  symlinkSync(join(FAKES, 'fake-tailscale.mjs'), join(bin, 'tailscale'));
  fakeWorld = world(root);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_SSH_ROOT = root;
  process.env.CLIKCODE_REMOTE_REPO_URL = fakeWorld.repoUrl;
  process.env.CLIKCODE_REMOTE_NODE_MIRROR = fakeWorld.mirrorUrl;
  process.env.CLIKCODE_REMOTE_MACPORTS_MIRROR = fakeWorld.macportsMirror;
  process.env.CLIKCODE_REMOTE_MACPORTS_PINS = JSON.stringify(fakeWorld.macportsPins);
  const status = join(root, 'tailscale.json');
  writeFileSync(status, JSON.stringify(tailscaleFixture()));
  process.env.FAKE_TAILSCALE_STATUS = status;
});

afterAll(() => {
  for (const key of ['FAKE_SSH_ROOT', 'CLIKCODE_REMOTE_REPO_URL', 'CLIKCODE_REMOTE_NODE_MIRROR', 'CLIKCODE_REMOTE_MACPORTS_MIRROR', 'CLIKCODE_REMOTE_MACPORTS_PINS', 'FAKE_TAILSCALE_STATUS']) delete process.env[key];
  process.env.PATH = savedEnv.PATH;
  process.env.HOME = savedEnv.HOME;
});

describe('Tailscale discovery', () => {
  it('offers only the same login’s desktop machines seen in the last 30 days, one per machine', () => {
    const found = discoverMachines(tailscaleFixture() as TailscaleStatus);
    expect(found.map((machine) => machine.name).sort()).toEqual(['devbox', 'imac', 'macbook', 'winbox']);
    // The online node of the iMac is kept; its old offline node is not.
    expect(found.find((machine) => machine.name === 'imac')).toMatchObject({ nodeId: 'nNewMac', online: true, dnsName: 'imac.tail-fake.ts.net' });
    // Shared in from another user, another user's own, a phone, and one not seen for 50 days: none.
    for (const id of ['nShared', 'nFriend', 'nPhone', 'nStale', 'nOldMac']) expect(found.some((machine) => machine.nodeId === id)).toBe(false);
  });

  it('keeps two online machines with one name, and hides only an older offline one', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const status: TailscaleStatus = {
      Self: { ID: 's', UserID: 1 },
      Peer: {
        a: { ID: 'a', HostName: 'ubuntu', DNSName: 'ubuntu.t.ts.net.', OS: 'linux', UserID: 1, Online: true },
        b: { ID: 'b', HostName: 'ubuntu', DNSName: 'ubuntu-1.t.ts.net.', OS: 'linux', UserID: 1, Online: true },
        c: { ID: 'c', HostName: 'Ubuntu', DNSName: 'ubuntu-2.t.ts.net.', OS: 'linux', UserID: 1, Online: false, LastSeen: '2026-10-19T00:00:00Z' },
      },
    };
    expect(discoverMachines(status, now).map((machine) => machine.nodeId).sort()).toEqual(['a', 'b']);
  });

  it('reads `tailscale status --json`, and says why when it cannot', async () => {
    const read = await readTailscaleStatus();
    expect(read.error).toBeUndefined();
    expect(discoverMachines(read.status!).length).toBe(4);
    const fixture = process.env.FAKE_TAILSCALE_STATUS;
    delete process.env.FAKE_TAILSCALE_STATUS;
    try {
      expect((await readTailscaleStatus()).error).toMatch(/tailscaled/);
    } finally { process.env.FAKE_TAILSCALE_STATUS = fixture; }
  });

  it('does not offer a machine already added', () => {
    const found = discoverMachines(tailscaleFixture() as TailscaleStatus);
    const added = [newMachineRecord({ name: 'devbox', sshTarget: 'me@devbox.tail-fake.ts.net' }), newMachineRecord({ name: 'mac', sshTarget: 'x', tailscale: { nodeId: 'nMac' } })];
    expect(notYetAdded(found, added).map((machine) => machine.name).sort()).toEqual(['imac', 'winbox']);
  });
});

describe('quoting and targets', () => {
  it('single-quotes any value so sh reads it back unchanged', () => {
    for (const nasty of [`it's`, `$(touch ${root}/pwned)`, '`id`', 'a b; rm -rf ~', `'"'"'`, '\\n$HOME*', 'émoji ✓']) {
      const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(nasty)}`], { encoding: 'utf8' });
      expect(out).toBe(nasty);
    }
    expect(existsSync(join(root, 'pwned'))).toBe(false);
    expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`);
  });

  it('refuses targets that ssh would read as an option, or that are not one word', () => {
    for (const bad of ['-oProxyCommand=touch /tmp/x', '-p', 'bob@-host', '-@host', 'a b', 'x;id', '$(id)', '`id`', "o'neil@h", 'h\nx', '', '@host', 'bob@']) {
      expect(() => validateSshTarget(bad), bad).toThrow();
    }
    for (const good of ['devbox', 'bob@devbox', 'imac.tail-fake.ts.net', 'me@10.0.0.2', 'my-alias']) expect(validateSshTarget(good)).toBe(good);
    expect(() => withUser('devbox', '-oProxyCommand=x')).toThrow();
    expect(withUser('alice@devbox', 'carol')).toBe('carol@devbox');
  });

  it('ends ssh options before the target, and sends the script as one quoted sh -c word', () => {
    const argv = sshArgv('bob@devbox', `echo 'hi'`);
    expect(argv.slice(0, 4)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']);
    const dash = argv.indexOf('--');
    expect(argv[dash + 1]).toBe('bob@devbox');
    expect(argv[dash + 2]).toBe(`sh -c 'echo '\\''hi'\\'''`);
    expect(argv.length).toBe(dash + 3);
    expect(() => sshArgv('-oProxyCommand=x', 'true')).toThrow();
  });

  it('quotes a repository URL that is not to be trusted', async () => {
    host(root, 'quoting');
    const evil = `file:///nowhere'; touch "$HOME/pwned"; echo '`;
    const result = await runSsh('quoting', sourceScript(evil));
    expect(result.code).not.toBe(0);
    expect(existsSync(join(homeOf('quoting'), 'pwned'))).toBe(false);
  });
});

describe('installing on a machine', () => {
  it('installs from the repository: probe, Node already there, git, clone, pnpm and install-local, verify', async () => {
    host(root, 'devbox');
    const { seen, reporter } = steps();
    const outcome = await installOnMachine('devbox', reporter);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(seen.map((item) => item.step)).toEqual(['Checking the machine', 'Node.js', 'git', 'Getting ClikCode from GitHub', 'Building and installing', 'Checking the install']);
    expect(seen[1]!.detail).toMatch(/already installed/);
    expect(seen[3]!.detail).toMatch(/^cloned at /);
    expect(outcome.info).toMatchObject({ version: '1.0.0', commit: fakeWorld.commit });
    expect(outcome.info.installationId).toMatch(/^[0-9a-f-]{36}$/);
    const home = homeOf('devbox');
    expect(readlinkSync(join(home, '.local', 'bin', 'clikcode'))).toBe(join(home, '.local', 'share', 'clikcode', 'release', 'dist', 'index.js'));
    // pnpm ran through npx (no packageManager pin), then the repository's own install-local.
    const npx = readFileSync(join(home, '.fake-remote', 'npx.log'), 'utf8');
    expect(npx).toContain('npx --yes pnpm@10 install --frozen-lockfile');
    expect(npx).toContain('npx --yes pnpm@10 run install-local');
    // Every ssh call was BatchMode, with `--` before the target.
    const calls = readFileSync(join(root, 'ssh.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]).filter((argv) => argv.includes('devbox'));
    for (const argv of calls) {
      expect(argv).toContain('BatchMode=yes');
      expect(argv[argv.indexOf('devbox') - 1]).toBe('--');
    }
  });

  it('updates the clone it made: fetch and reset to the new main', async () => {
    writeFileSync(join(fakeWorld.work, 'NEWS'), 'second\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fakeWorld.work, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@x.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@x.invalid' } }).trim();
    git('add', '-A');
    git('commit', '-q', '-m', 'second');
    git('push', '-q', fakeWorld.bare, 'main');
    const commit = git('rev-parse', 'HEAD');
    const { seen, reporter } = steps();
    const outcome = await installOnMachine('devbox', reporter, { update: true });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(seen.map((item) => item.step)).toEqual(['Checking the machine', 'Getting ClikCode from GitHub', 'Building and installing', 'Checking the install']);
    expect(seen[1]!.detail).toBe(`updated at ${commit.slice(0, 8)}`);
    if (outcome.ok) expect(outcome.info.commit).toBe(commit);
    fakeWorld.commit = commit;
  });

  it('resets the clone it owns to the target, local changes and all', async () => {
    const source = join(homeOf('devbox'), '.local', 'share', 'clikcode', 'src');
    writeFileSync(join(source, 'package.json'), '{"edited": true}\n');
    writeFileSync(join(source, 'stray.txt'), 'left behind\n');
    const outcome = await installOnMachine('devbox', steps().reporter, { update: true });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(readFileSync(join(source, 'package.json'), 'utf8')).not.toContain('edited');
    expect(existsSync(join(source, 'stray.txt'))).toBe(false);
    if (outcome.ok) expect(outcome.from).toBe(fakeWorld.commit);
  });

  it('updates to a chosen commit, fetched by sha, and builds it as it is', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fakeWorld.work, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@x.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@x.invalid' } }).trim();
    const older = git('rev-parse', 'HEAD~1');
    const { seen, reporter } = steps();
    const outcome = await installOnMachine('devbox', reporter, { update: true, commit: older });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(seen[1]!.detail).toBe(`updated at ${older.slice(0, 8)}`);
    if (outcome.ok) expect(outcome.info.commit).toBe(older);
    const npx = readFileSync(join(homeOf('devbox'), '.fake-remote', 'npx.log'), 'utf8');
    expect(npx).toContain('run build');
    expect(npx).toContain('run install-local --force');
    // A commit the repository does not have: the step says so.
    const missing = await installOnMachine('devbox', steps().reporter, { update: true, commit: 'e'.repeat(40) });
    expect(missing).toMatchObject({ ok: false, step: 'Getting ClikCode from GitHub' });
    if (!missing.ok) expect(missing.message).toMatch(/has no commit e{40}/);
    // Back to main for the tests after this one.
    expect((await installOnMachine('devbox', steps().reporter, { update: true })).ok).toBe(true);
  });

  it('builds the update script once, for a commit or for main', () => {
    expect(sourceScript('file:///r.git', 'a'.repeat(40))).toContain(`want='${'a'.repeat(40)}'`);
    expect(sourceScript('file:///r.git')).toContain("want=''");
    expect(buildScript(true)).toContain('pnpm run install-local --force --even-if-behind');
    expect(buildScript(false)).not.toContain('--force');
  });

  it('installs a user-local Node, checksum verified, when there is none', async () => {
    host(root, 'nonode', { hide: ['node'] });
    const { seen, reporter } = steps();
    const outcome = await installOnMachine('nonode', reporter);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(seen[1]).toEqual({ step: 'Node.js', detail: 'v24.99.0 from nodejs.org latest-v24.x into ~/.local/share/clikcode/node (SHA-256 checked, runs)' });
    expect(existsSync(join(homeOf('nonode'), '.local', 'share', 'clikcode', 'node', 'bin', 'node'))).toBe(true);
    // The next time, its own Node is found.
    const again = steps();
    expect((await installOnMachine('nonode', again.reporter)).ok).toBe(true);
    expect(again.seen[1]!.detail).toMatch(/^ClikCode's own v/);
  });

  it('installs Node when the one there is older than 22.12', async () => {
    host(root, 'oldnode', { oldNode: 'v18.19.0' });
    const { seen, reporter } = steps();
    expect((await installOnMachine('oldnode', reporter)).ok).toBe(true);
    expect(seen[1]!.detail).toMatch(/SHA-256 checked/);
    expect(nodeIsNewEnough('v22.11.0')).toBe(false);
    expect(nodeIsNewEnough('v22.12.0')).toBe(true);
    expect(nodeIsNewEnough('v24.1.0')).toBe(true);
  });

  it('stops when the downloaded Node does not match its published checksum', async () => {
    const other = mkdtempSync(join(tmpdir(), 'cc-remote-bad-'));
    const bad = world(other, { badChecksum: true });
    host(root, 'badsum', { hide: ['node'] });
    process.env.CLIKCODE_REMOTE_NODE_MIRROR = bad.mirrorUrl;
    try {
      const outcome = await installOnMachine('badsum', steps().reporter);
      expect(outcome).toMatchObject({ ok: false, step: 'Node.js' });
      if (!outcome.ok) expect(outcome.message).toMatch(/checksum mismatch/);
      expect(existsSync(join(homeOf('badsum'), '.local', 'share', 'clikcode', 'node'))).toBe(false);
    } finally { process.env.CLIKCODE_REMOTE_NODE_MIRROR = fakeWorld.mirrorUrl; }
  });

  it('chooses where Node comes from by the OS: what runs there', () => {
    const probe = (os: string, arch: string, macos?: string): Probe => ({ os, arch, home: '/h', ...(macos ? { macos } : {}) });
    expect(nodeSource(probe('Linux', 'x86_64'), 'box')).toMatchObject({ kind: 'nodejs', line: 'latest-v24.x', os: 'linux', arch: 'x64' });
    expect(nodeSource(probe('Linux', 'aarch64'), 'box')).toMatchObject({ kind: 'nodejs', line: 'latest-v24.x', arch: 'arm64' });
    expect(nodeSource(probe('Darwin', 'arm64', '15.1'), 'mac')).toMatchObject({ kind: 'nodejs', line: 'latest-v24.x', os: 'darwin' });
    expect(nodeSource(probe('Darwin', 'x86_64', '13.5'), 'mac')).toMatchObject({ kind: 'nodejs', line: 'latest-v24.x' });
    expect(nodeSource(probe('Darwin', 'x86_64', '13.4.1'), 'mac')).toMatchObject({ kind: 'nodejs', line: 'latest-v22.x' });
    expect(nodeSource(probe('Darwin', 'x86_64', '12.7'), 'mac')).toMatchObject({ kind: 'nodejs', line: 'latest-v22.x', os: 'darwin', arch: 'x64' });
    expect(nodeSource(probe('Darwin', 'x86_64', '11.0'), 'mac')).toMatchObject({ kind: 'nodejs', line: 'latest-v22.x' });
    // The real table, not the fakes': MacPorts' nodejs22 for 10.15, pinned.
    const imac = nodeSource(probe('Darwin', 'x86_64', '10.15.8'), 'imac', MACPORTS_NODE);
    expect(imac).toMatchObject({ kind: 'macports', darwin: 19, pinned: { version: 'v22.22.2', node: { port: 'nodejs22', file: 'nodejs22-22.22.2_0.darwin_19.x86_64.tbz2' } } });
    if (imac.kind === 'macports') {
      expect([imac.pinned.node, ...imac.pinned.libs, imac.pinned.npm].map((pin) => pin.file)).toEqual([
        'nodejs22-22.22.2_0.darwin_19.x86_64.tbz2', 'zlib-1.3.2_0.darwin_19.x86_64.tbz2', 'icu-78.3_1.darwin_19.x86_64.tbz2', 'npm10-10.9.8_0.any_any.noarch.tbz2']);
      for (const pin of [imac.pinned.node, ...imac.pinned.libs, imac.pinned.npm]) expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const tooOld = 'macOS 10.12.6 is too old for ClikCode: it needs Node.js 22.12 or newer, which needs macOS 10.15 or newer. Update macOS on imac, or install Node.js 22.12+ there yourself and add it again.';
    expect(nodeSource(probe('Darwin', 'x86_64', '10.12.6'), 'imac', MACPORTS_NODE)).toEqual({ kind: 'refused', message: tooOld });
    // MacPorts builds no nodejs22 for 10.13 or 10.14.
    expect(nodeSource(probe('Darwin', 'x86_64', '10.14.6'), 'imac', MACPORTS_NODE)).toMatchObject({ kind: 'refused', message: expect.stringMatching(/^macOS 10\.14\.6 is too old/) });
    expect(nodeSource(probe('Darwin', 'x86_64'), 'imac')).toMatchObject({ kind: 'refused', message: expect.stringMatching(/did not say which macOS/) });
    expect(nodeSource(probe('FreeBSD', 'amd64'), 'bsd')).toMatchObject({ kind: 'refused', message: expect.stringMatching(/installs on Linux and macOS/) });
  });

  it('probes the macOS version, and counts a node only when it runs', () => {
    const probe = parseProbe('os=Darwin\narch=x86_64\nhome=/Users/j\nmacos=10.15.8\nnode=/usr/local/bin/node\nnodeError=dyld: Symbol not found\nownNodeError=dyld: Symbol not found\nprobe=ok\n');
    expect(probe).toEqual({ os: 'Darwin', arch: 'x86_64', home: '/Users/j', macos: '10.15.8', node: '/usr/local/bin/node', nodeError: 'dyld: Symbol not found', ownNodeError: 'dyld: Symbol not found' });
    expect(probeScript()).toContain('sw_vers -productVersion');
  });

  it('refuses a macOS too old for any Node it can run, before downloading anything', async () => {
    host(root, 'oldmac', { hide: ['node'], uname: { s: 'Darwin', m: 'x86_64' }, swVers: '10.12.6' });
    const before = readFileSync(join(root, 'ssh.log'), 'utf8').split('\n').length;
    const outcome = await installOnMachine('oldmac', steps().reporter);
    expect(outcome).toEqual({ ok: false, step: 'Checking the machine', message: 'macOS 10.12.6 is too old for ClikCode: it needs Node.js 22.12 or newer, which needs macOS 10.15 or newer. Update macOS on oldmac, or install Node.js 22.12+ there yourself and add it again.' });
    // The probe only: no download, no clone.
    expect(readFileSync(join(root, 'ssh.log'), 'utf8').split('\n').length - before).toBe(1);
    expect(existsSync(join(homeOf('oldmac'), '.local', 'share', 'clikcode'))).toBe(false);
  });

  it('installs nodejs.org’s Node 22 line on macOS 11 to 13.4', async () => {
    host(root, 'montereymac', { hide: ['node'], uname: { s: 'Darwin', m: 'x86_64' }, swVers: '12.7.6' });
    const { seen, reporter } = steps();
    const outcome = await installOnMachine('montereymac', reporter);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(seen[0]).toEqual({ step: 'Checking the machine', detail: 'macOS 12.7.6 x86_64' });
    expect(seen[1]!.detail).toBe('v22.99.0 from nodejs.org latest-v22.x into ~/.local/share/clikcode/node (SHA-256 checked, runs)');
  });

  it('does not count a node that is there but does not run', async () => {
    host(root, 'brokennode', { brokenNode: 'dyld: Symbol not found: __ZNSt3__122__libcpp_verbose_abortEPKcz' });
    const { seen, reporter } = steps();
    expect((await installOnMachine('brokennode', reporter)).ok).toBe(true);
    expect(seen[1]!.detail).toMatch(/^v24\.99\.0 from nodejs\.org latest-v24\.x .*; the node at \/.*\/bin\/node does not run, so it is not used$/);
  });

  it('runs the Node it installed, and stops at the Node step with what it said when it does not run', async () => {
    const other = mkdtempSync(join(tmpdir(), 'cc-remote-broken-'));
    const broken = world(other, { brokenNode: true });
    host(root, 'newer-build', { hide: ['node'] });
    process.env.CLIKCODE_REMOTE_NODE_MIRROR = broken.mirrorUrl;
    try {
      const outcome = await installOnMachine('newer-build', steps().reporter);
      expect(outcome).toMatchObject({ ok: false, step: 'Node.js' });
      if (!outcome.ok) expect(outcome.message).toBe('Node.js from nodejs.org latest-v24.x was installed on newer-build but does not run: dyld: Symbol not found: __ZNSt3__122__libcpp_verbose_abortEPKcz   Expected in: /usr/lib/libc++.1.dylib (built for Mac OS X 13.5). Install Node.js 22.12 or newer there yourself, then choose the machine again.');
      expect(existsSync(join(homeOf('newer-build'), '.local', 'share', 'clikcode', 'node'))).toBe(false);
      expect(existsSync(join(homeOf('newer-build'), '.local', 'share', 'clikcode', 'node.new'))).toBe(false);
    } finally { process.env.CLIKCODE_REMOTE_NODE_MIRROR = fakeWorld.mirrorUrl; }
  });

  it('on macOS 10.15 installs MacPorts’ Node into its own directory: pinned, relinked, re-signed, run -- replacing its own Node that no longer ran', async () => {
    const dyld = 'dyld: Symbol not found: __ZNSt3__122__libcpp_verbose_abortEPKcz (built for Mac OS X 13.5)';
    host(root, 'catalina', { uname: { s: 'Darwin', m: 'x86_64' }, swVers: '10.15.8', brokenNode: dyld, ownBrokenNode: dyld, appleTools: true });
    const { seen, reporter } = steps();
    const outcome = await installOnMachine('catalina', reporter);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(seen[0]!.detail).toBe('macOS 10.15.8 x86_64');
    expect(seen[1]!.detail).toMatch(/^v22\.22\.2 from MacPorts nodejs22 v22\.22\.2 into ~\/\.local\/share\/clikcode\/node \(SHA-256 pinned, runs\); the node at \/\S+ does not run, so it is not used; it replaces ClikCode's own Node, which no longer ran$/);
    const own = join(homeOf('catalina'), '.local', 'share', 'clikcode', 'node');
    // node and exactly the libraries it loads, followed through libicuuc to libicudata; not libicuio.
    expect(execFileSync('ls', [join(own, 'lib')], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()).toEqual(['libicudata.78.dylib', 'libicui18n.78.dylib', 'libicuuc.78.dylib', 'libz.1.dylib', 'node_modules']);
    const node = readFileSync(join(own, 'bin', 'node'), 'utf8');
    expect(node).not.toMatch(/^# LC_\w+ \/opt\/local/m);
    expect(node).toContain('# LC_LOAD_DYLIB @loader_path/../lib/libz.1.dylib');
    expect(node).toContain('# CODESIG adhoc');
    expect(readFileSync(join(own, 'lib', 'libicuuc.78.dylib'), 'utf8')).toMatch(/# LC_ID_DYLIB @loader_path\/\.\.\/lib\/libicuuc\.78\.dylib\n# LC_LOAD_DYLIB @loader_path\/\.\.\/lib\/libicudata\.78\.dylib/);
    const tools = readFileSync(join(homeOf('catalina'), '.fake-remote', 'tools.log'), 'utf8');
    expect(tools).toContain(`install_name_tool -change /opt/local/lib/libicuuc.78.dylib @loader_path/../lib/libicuuc.78.dylib ${join(own, '..', 'node.new', 'bin', 'node')}`);
    for (const file of ['bin/node', 'lib/libz.1.dylib', 'lib/libicui18n.78.dylib', 'lib/libicuuc.78.dylib', 'lib/libicudata.78.dylib']) expect(tools).toContain(`codesign -f -s - ${join(own, '..', 'node.new', file)}`);
    // npm from MacPorts' npm10 beside it, run by this node, got pnpm for the build.
    expect(execFileSync(join(own, 'bin', 'npm'), ['-v'], { encoding: 'utf8' }).trim()).toBe('10.9.8');
    expect(readFileSync(join(homeOf('catalina'), '.fake-remote', 'macports-npx.log'), 'utf8')).toMatch(/--yes pnpm@10 install --frozen-lockfile\n.*--yes pnpm@10 run install-local/);
  }, 120_000);

  it('refuses MacPorts archives whose SHA-256 is not the pinned one', async () => {
    host(root, 'catalina-bad', { hide: ['node'], uname: { s: 'Darwin', m: 'x86_64' }, swVers: '10.15.7', appleTools: true });
    const pins = JSON.parse(JSON.stringify(fakeWorld.macportsPins)) as typeof fakeWorld.macportsPins;
    pins[19]!.node.sha256 = 'f'.repeat(64);
    process.env.CLIKCODE_REMOTE_MACPORTS_PINS = JSON.stringify(pins);
    try {
      const outcome = await installOnMachine('catalina-bad', steps().reporter);
      expect(outcome).toMatchObject({ ok: false, step: 'Node.js' });
      if (!outcome.ok) expect(outcome.message).toMatch(/^Installing Node\.js from MacPorts nodejs22 v22\.22\.2 on catalina-bad failed: checksum mismatch for nodejs22-22\.22\.2_0\.darwin_19\.x86_64\.tbz2: expected f{64}, got [0-9a-f]{64}\./);
      expect(existsSync(join(homeOf('catalina-bad'), '.local', 'share', 'clikcode', 'node'))).toBe(false);
      // Nothing was unpacked or relinked.
      expect(existsSync(join(homeOf('catalina-bad'), '.fake-remote', 'tools.log'))).toBe(false);
    } finally { process.env.CLIKCODE_REMOTE_MACPORTS_PINS = JSON.stringify(fakeWorld.macportsPins); }
  });

  it('stops with the remedy when git is missing, and never uses sudo', async () => {
    host(root, 'nogit', { hide: ['git'] });
    const outcome = await installOnMachine('nogit', steps().reporter);
    expect(outcome).toMatchObject({ ok: false, step: 'git' });
    if (!outcome.ok) expect(outcome.message).toMatch(/has no git.*package manager/);
    host(root, 'nogit-mac', { hide: ['git'], uname: { s: 'Darwin', m: 'arm64' } });
    const mac = await installOnMachine('nogit-mac', steps().reporter);
    if (!mac.ok) expect(mac.message).toMatch(/xcode-select --install/);
    const scripts = readFileSync(join(root, 'ssh.log'), 'utf8');
    expect(scripts).not.toMatch(/\bsudo\b(?! apt install git)/);
  });

  it('says Windows is not supported yet, and an offline machine is unreachable', async () => {
    host(root, 'winbox', { windows: true });
    expect(await installOnMachine('winbox', steps().reporter)).toMatchObject({ ok: false, windows: true });
    host(root, 'gone', { offline: true });
    expect(await installOnMachine('gone', steps().reporter)).toMatchObject({ ok: false, unreachable: true, step: 'Checking the machine' });
  });

  it('reads a Tailscale SSH policy refusal as a refused login, and names its reason', () => {
    // Exactly what ssh printed against a tailnet whose policy allows only root (2026-10-21).
    const refused = { code: 255, stdout: '', stderr: 'tailscale: tailnet policy does not permit you to SSH as user "justin-gracier"\nConnection closed by 100.93.159.116 port 22\n' };
    expect(sshFailure(refused)).toBe('auth');
    expect(sshFailureMessage('box', refused)).toContain('tailnet policy does not permit you to SSH as user "justin-gracier"');
    expect(sshFailureMessage('box', refused)).not.toContain('Connection closed');
  });

  it('reports a refused login as auth, and defaults the user to ~/.ssh/config’s', async () => {
    host(root, 'locked', { users: ['carol'] });
    const refused = await runSsh('locked', 'true');
    expect(sshFailure(refused)).toBe('auth');
    expect(await installOnMachine('locked', steps().reporter)).toMatchObject({ ok: false, auth: true });
    writeFileSync(join(root, 'ssh_config.json'), JSON.stringify({ locked: 'carol' }));
    expect(await defaultLoginUser('locked')).toBe('carol');
    expect(await defaultLoginUser('dave@locked')).toBe('dave');
  });

  it('uninstalls what it installed, and the data only when asked', async () => {
    host(root, 'leaving');
    expect((await installOnMachine('leaving', steps().reporter)).ok).toBe(true);
    const home = homeOf('leaving');
    expect(existsSync(join(home, '.clikcode'))).toBe(true);
    expect(await uninstallFromMachine('leaving', false)).toEqual({ ok: true });
    for (const gone of ['.local/share/clikcode/src', '.local/share/clikcode/release', '.local/bin/clikcode']) expect(existsSync(join(home, gone)), gone).toBe(false);
    expect(lstatSync(join(home, '.local', 'bin', 'clikcode'), { throwIfNoEntry: false })).toBeUndefined();
    expect(existsSync(join(home, '.clikcode'))).toBe(true);
    expect(await uninstallFromMachine('leaving', true)).toEqual({ ok: true });
    expect(existsSync(join(home, '.clikcode'))).toBe(false);
  });

  it('leaves a ~/.local/bin/clikcode it did not install alone', async () => {
    const { home } = host(root, 'theirs');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'clikcode'), '#!/bin/sh\necho mine\n');
    const outcome = await installOnMachine('theirs', steps().reporter);
    expect(outcome).toMatchObject({ ok: false, step: 'Checking the machine' });
    expect(readFileSync(join(home, '.local', 'bin', 'clikcode'), 'utf8')).toContain('mine');
  });
});

const chat = (id: string, title: string, extra: Partial<IdeConversation> = {}): IdeConversation => ({
  id, title, updatedAt: new Date(Date.now() - 60_000).toISOString(), messages: 2, section: 'active', current: false, ...extra,
});

const until = async (check: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('the board’s connections', () => {
  it('lists a machine’s chats over its own bridge, follows changes, and only reads', async () => {
    const { home } = host(root, 'watched', { chats: [chat('c1', 'Fix the login page')] });
    expect((await installOnMachine('watched', steps().reporter)).ok).toBe(true);
    const machine = newMachineRecord({ name: 'watched', sshTarget: 'watched', ready: true });
    const link = new RemoteLink(machine, () => undefined, { localCommit: fakeWorld.commit });
    link.start();
    try {
      await until(() => link.view.chats.length === 1 && link.view.state === 'connected');
      expect(link.view.needsUpdate).toBe(false);
      writeFileSync(join(home, '.fake-remote', 'chats.json'), JSON.stringify([chat('c1', 'Fix the login page', { needsYou: true }), chat('c2', 'Write the tests')]));
      await until(() => link.view.chats.length === 2);
      expect(link.view.chats[0]!.needsYou).toBe(true);
    } finally { await link.stop(); }
    const requests = readFileSync(join(home, '.fake-remote', 'bridge.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; request?: { type: string } });
    expect(new Set(requests.map((request) => request.request?.type ?? request.type))).toEqual(new Set(['chat-attach', 'watch-conversations', 'query']));
  });

  it('marks a machine on another commit as needing an update', async () => {
    host(root, 'behind', { commit: 'f'.repeat(40) });
    expect((await installOnMachine('behind', steps().reporter)).ok).toBe(true);
    const link = new RemoteLink(newMachineRecord({ name: 'behind', sshTarget: 'behind', ready: true }), () => undefined, { localCommit: fakeWorld.commit, autoUpdate: false });
    link.start();
    try {
      await until(() => link.view.state === 'connected');
      expect(link.view.needsUpdate).toBe(true);
    } finally { await link.stop(); }
    expect(needsUpdate({ commit: 'a', protocol: 1 }, 'a')).toBe(false);
    expect(needsUpdate({ commit: 'a', protocol: 1 }, 'b')).toBe(true);
    expect(needsUpdate({ commit: 'a', protocol: 99 }, 'a')).toBe(true);
    expect(needsUpdate({ protocol: 1 }, 'b')).toBe(false);
  });

  it('shows an offline machine with the chats it had last time, and keeps trying', async () => {
    host(root, 'sleeping', { offline: true });
    const cached = [chat('old1', 'Deploy notes')];
    await updateMachines(() => [newMachineRecord({ name: 'sleeping', sshTarget: 'sleeping', ready: true, chats: cached, lastSeen: new Date(Date.now() - 3_600_000).toISOString() })]);
    const machines = await new RemoteMachines({ backoffMs: [50] }).open();
    try {
      const [view] = machines.views();
      await until(() => view!.state === 'offline');
      expect(view!.chats.map((item) => item.title)).toEqual(['Deploy notes']);
      const tries = () => readFileSync(join(root, 'ssh.log'), 'utf8').split('\n').filter((line) => line.includes('"sleeping"')).length;
      const before = tries();
      await until(() => tries() > before + 1);
      expect(machines.views()[0]!.state).toBe('offline');
    } finally { await machines.close(); }
  });

  const sshTo = (name: string): number => (existsSync(join(root, 'ssh.log'))
    ? readFileSync(join(root, 'ssh.log'), 'utf8').split('\n').filter((line) => line.includes(`"${name}"`)).length : 0);

  it('keeps one connection per machine for the window: every list after the first reuses it', async () => {
    host(root, 'kept', { chats: [chat('k1', 'Kept open')] });
    expect((await installOnMachine('kept', steps().reporter)).ok).toBe(true);
    await updateMachines(() => [newMachineRecord({ name: 'kept', sshTarget: 'kept', ready: true })]);
    const before = sshTo('kept');
    try {
      // The board, then /machine, then /remote, then the board again.
      const board = await holdWindowMachines({ autoUpdate: true });
      await until(() => board.views()[0]?.state === 'connected' && board.views()[0]!.chats.length === 1);
      let changes = 0;
      board.onChange(() => { changes += 1; });
      board.release();
      for (const list of [{}, {}, { autoUpdate: true }]) {
        const held = await holdWindowMachines(list);
        expect(held.views()[0]).toMatchObject({ state: 'connected', chats: [expect.objectContaining({ title: 'Kept open' })] });
        held.release();
      }
      // A released list hears nothing more.
      const counted = changes;
      const again = await holdWindowMachines();
      again.release();
      expect(changes).toBe(counted);
      expect(sshTo('kept') - before).toBe(1);
    } finally { await closeWindowMachines(); }
    // Closed with the window: the next window connects anew.
    const next = await holdWindowMachines();
    try {
      await until(() => next.views()[0]?.state === 'connected');
      expect(sshTo('kept') - before).toBe(2);
    } finally { next.release(); await closeWindowMachines(); }
  }, 120_000);

  it('follows machines.json on each list: a machine added is connected to, one forgotten is let go', async () => {
    host(root, 'first', {});
    host(root, 'second', {});
    for (const name of ['first', 'second']) expect((await installOnMachine(name, steps().reporter)).ok).toBe(true);
    const first = newMachineRecord({ name: 'first', sshTarget: 'first', ready: true });
    const second = newMachineRecord({ name: 'second', sshTarget: 'second', ready: true });
    await updateMachines(() => [first]);
    const installed = sshTo('second');
    try {
      const one = await holdWindowMachines();
      expect(one.views().map((view) => view.machine.name)).toEqual(['first']);
      one.release();
      await updateMachines(() => [first, second]);
      const two = await holdWindowMachines();
      expect(two.views().map((view) => view.machine.name)).toEqual(['first', 'second']);
      await until(() => two.views().every((view) => view.state === 'connected'));
      two.release();
      await updateMachines(() => [second]);
      const three = await holdWindowMachines();
      expect(three.views().map((view) => view.machine.name)).toEqual(['second']);
      three.release();
      expect(sshTo('second') - installed).toBe(1);
    } finally { await closeWindowMachines(); }
  }, 120_000);

  it('tries an offline machine again only while a list shows it, and at once when the next one opens', async () => {
    host(root, 'napping', { offline: true });
    await updateMachines(() => [newMachineRecord({ name: 'napping', sshTarget: 'napping', ready: true })]);
    try {
      const list = await holdWindowMachines({}, { backoffMs: [50] });
      await until(() => list.views()[0]?.state === 'offline');
      const shown = sshTo('napping');
      await until(() => sshTo('napping') > shown);
      list.release();
      // Nothing shows it: no more tries.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const idle = sshTo('napping');
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(sshTo('napping')).toBe(idle);
      const next = await holdWindowMachines();
      expect(next.views()[0]!.state).toBe('connecting');
      await until(() => sshTo('napping') > idle);
      next.release();
    } finally { await closeWindowMachines(); }
  }, 60_000);

  it('writes machines.json private to the user', async () => {
    await updateMachines((list) => list);
    expect(statSync(machinesPath()).mode & 0o777).toBe(0o600);
  });
});

describe('/machine keeps the machines (what /remote was)', () => {
  // Its list holds the window's connections; each test is its own window.
  afterEach(() => closeWindowMachines());
  type Answer = unknown | { action: [string, string] };
  /** /machine's list (and its sub-lists) answered by title; `{ action }` is Tab on a row. Questions are answered in order; undefined is Esc. */
  const scripted = (choices: Record<string, (options: readonly PickerOption<unknown>[]) => Answer>, answers: Array<string | undefined>) => {
    const asked: string[] = [];
    const lines: string[] = [];
    const listed: Array<readonly PickerOption<unknown>[]> = [];
    const prompter = {
      question: async (label: string) => {
        asked.push(label.replace(/ › $/, ''));
        const answer = answers.shift();
        if (answer === undefined) throw Object.assign(new Error('cancelled'), { code: 'ERR_PROMPT_CANCELLED' });
        return answer;
      },
      // As the list would be once what it waits on (Tailscale, each machine's state) has landed.
      select: async <T>(title: string, options: readonly PickerOption<T>[], onAction?: (value: T, action: string) => Promise<void>, settings?: PickerSettings<T>) => {
        await Promise.race([Promise.all([settings?.refresh ?? []].flat()), new Promise((resolve) => setTimeout(resolve, 8000))]);
        const rows = (settings?.refreshedOptions?.() ?? options) as readonly PickerOption<unknown>[];
        if (title === 'Move this chat to') listed.push(rows);
        const answer = choices[title]?.(rows);
        if (answer && typeof answer === 'object' && 'action' in answer) {
          const [value, action] = (answer as { action: [string, string] }).action;
          await onAction?.(value as T, action);
          return undefined;
        }
        return answer as T | undefined;
      },
      activity: (text: string) => { lines.push(stripAnsi(text)); },
      close: () => undefined,
    } as unknown as HarnessPrompter;
    return { prompter, asked, lines, listed };
  };
  const machineOpen = (prompter: HarnessPrompter) => moveTerminalChat(prompter, { local: 'x' }, 'x', false, localMoveEnd());
  /** The first list, then Esc: what Tab did is seen in the next one. */
  const once = (answer: (options: readonly PickerOption<unknown>[]) => Answer) => {
    let first = true;
    return (options: readonly PickerOption<unknown>[]) => { if (!first) return undefined; first = false; return answer(options); };
  };

  it('adds a machine by address; a refused login asks once which user, and remembers it; the chat starts there', async () => {
    await updateMachines(() => []);
    host(root, 'guarded', { users: ['carol'] });
    writeFileSync(join(root, 'ssh_config.json'), '{}');
    const fallback = await defaultLoginUser('guarded');
    const { prompter, asked, lines } = scripted({
      'Move this chat to': (options) => options.find((option) => option.label.startsWith('Add by SSH address'))!.value,
    }, ['guarded', 'carol']);
    const next = await machineOpen(prompter);
    // Asked again, typed: nothing offered. The user it refused is said.
    expect(asked).toEqual(['SSH address (user@host, host, or a Host alias)', 'Log in to guarded as which user?']);
    expect(lines.some((line) => line.startsWith('! ') && /refused the login/.test(line) && line.includes(`(as ${fallback}, ssh's default)`))).toBe(true);
    expect(lines.filter((line) => line.startsWith('✓')).length).toBe(6);
    expect(lines.at(-1)).toMatch(/guarded is added/);
    const [machine] = await readMachines();
    expect(machine).toMatchObject({ name: 'guarded', sshTarget: 'carol@guarded', ready: true, installed: { version: '1.0.0' } });
    expect(machine!.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(next).toEqual({ remote: { machineId: machine!.id } });
  }, 120_000);

  it('asks only once: a second refusal stops with what to do; the machine is listed as not finished, Tab finishes it', async () => {
    await updateMachines(() => []);
    host(root, 'fortress', { users: ['nobody-you-know'] });
    const { prompter, asked, lines, listed } = scripted({
      'Move this chat to': (options) => options.find((option) => option.label.startsWith('Add by SSH address'))!.value,
    }, ['fortress', 'mallory']);
    expect(await machineOpen(prompter)).toBeUndefined();
    expect(asked.length).toBe(2);
    expect(lines.at(-1)).toMatch(/refused the login.*ssh-copy-id/);
    // The user given is remembered for the machine.
    const [kept] = await readMachines();
    expect(kept).toMatchObject({ sshTarget: 'mallory@fortress' });
    expect(kept!.ready).toBeFalsy();
    // Listed next time, as not finished, with Finish installing under Tab.
    const again = scripted({}, []);
    await machineOpen(again.prompter);
    const row = again.listed[0]!.find((option) => option.label === 'fortress')!;
    expect(stripAnsi(row.detail ?? '')).toContain('install not finished');
    expect(row.actions?.map((action) => action.label)).toEqual(['Finish installing', 'Updates: automatic · ask first instead', 'Remove…']);
    expect(listed.length).toBe(1);
  }, 120_000);

  it('asks which user before adding a tailnet machine, typed with nothing suggested, and installs as that user', async () => {
    await updateMachines(() => []);
    host(root, 'imac.tail-fake.ts.net', { users: ['root'] });
    const { prompter, asked, lines } = scripted({ 'Move this chat to': () => 'tailscale:nNewMac' }, ['', 'bad user', 'root']);
    const next = await machineOpen(prompter);
    // A plain question, up front; an empty or invalid name says why and is asked again.
    expect(asked).toEqual(Array(3).fill('Log in to imac as which user?'));
    expect(lines.slice(0, 2)).toEqual([
      '! Type a user name, or Esc to add nothing.',
      '! "bad user" is not a user name. Type another, or Esc to add nothing.',
    ]);
    expect(lines.some((line) => /refused/.test(line))).toBe(false);
    expect(lines[2]).toMatch(/^Installing ClikCode on imac \(root@imac\.tail-fake\.ts\.net\)/);
    expect(lines.at(-1)).toMatch(/imac is added/);
    const [machine] = await readMachines();
    expect(machine).toMatchObject({ name: 'imac', sshTarget: 'root@imac.tail-fake.ts.net', ready: true, tailscale: { nodeId: 'nNewMac', dnsName: 'imac.tail-fake.ts.net' } });
    expect(next).toEqual({ remote: { machineId: machine!.id } });
  }, 120_000);

  it('adds nothing when the user question is dismissed', async () => {
    await updateMachines(() => []);
    const { prompter, lines } = scripted({ 'Move this chat to': () => 'tailscale:nNewMac' }, [undefined]);
    expect(await machineOpen(prompter)).toBeUndefined();
    expect(lines).toEqual([]);
    expect(await readMachines()).toEqual([]);
  });

  it('lists this machine, the added ones with Tab options, the tailnet’s, then the address row', async () => {
    await updateMachines(() => [newMachineRecord({ name: 'devbox', sshTarget: 'devbox.tail-fake.ts.net', ready: true, tailscale: { nodeId: 'nBox' } })]);
    const { prompter, listed } = scripted({}, []);
    await machineOpen(prompter);
    expect(listed[0]!.map((option) => [option.group, option.label])).toEqual([
      [undefined, localMachineName()],
      [undefined, 'devbox'],
      ['On your tailnet', 'imac'],
      ['On your tailnet', 'winbox'],
      ['On your tailnet', 'macbook'],
      ['Somewhere else', 'Add by SSH address…'],
    ]);
    expect(listed[0]![1]!.actions?.map((action) => action.label)).toEqual(['Update ClikCode', 'Updates: automatic · ask first instead', 'Remove…']);
  });

  it('switches a machine between automatic updates and asking first (Tab), and opens the list again', async () => {
    const record: RemoteMachine = newMachineRecord({ name: 'prod', sshTarget: 'prod', ready: true });
    await updateMachines(() => [record]);
    const { prompter, lines, listed } = scripted({ 'Move this chat to': once(() => ({ action: [record.id, 'policy'] })) }, []);
    expect(await machineOpen(prompter)).toBeUndefined();
    expect(lines.at(-1)).toMatch(/^prod is updated only when you say so/);
    expect((await readMachines())[0]).toMatchObject({ updates: 'ask' });
    // The list came back, as it is now.
    expect(listed.length).toBe(2);
    expect(listed[1]!.find((option) => option.label === 'prod')!.actions![1]!.label).toBe('Updates: ask first · automatic instead');
    const back = scripted({ 'Move this chat to': once(() => ({ action: [record.id, 'policy'] })) }, []);
    await machineOpen(back.prompter);
    expect(back.lines.at(-1)).toMatch(/^prod is updated to this build by itself/);
    expect((await readMachines())[0]).toMatchObject({ updates: 'auto' });
  }, 60_000);

  it('removes a machine (Tab), and uninstalls there only when chosen', async () => {
    const { home } = host(root, 'retiring');
    expect((await installOnMachine('retiring', steps().reporter)).ok).toBe(true);
    const record: RemoteMachine = newMachineRecord({ name: 'retiring', sshTarget: 'retiring', ready: true });
    await updateMachines(() => [record]);
    const { prompter, lines, listed } = scripted({
      'Move this chat to': once(() => ({ action: [record.id, 'remove'] })),
      'Remove retiring': () => 'uninstall',
    }, []);
    expect(await machineOpen(prompter)).toBeUndefined();
    expect(lines.at(-1)).toMatch(/removed, and ClikCode is uninstalled there\.$/);
    expect(await readMachines()).toEqual([]);
    expect(listed[1]!.some((option) => option.label === 'retiring')).toBe(false);
    expect(existsSync(join(home, '.local', 'share', 'clikcode', 'src'))).toBe(false);
    expect(existsSync(join(home, '.clikcode'))).toBe(true);
  }, 120_000);
});

describe('/machine and the tailnet', () => {
  afterEach(() => closeWindowMachines());
  /** /machine's list, as it is once Tailscale has answered: `choose` answers it by title. */
  const picker = (choose: Record<string, (options: readonly PickerOption<unknown>[]) => unknown>, seen: { rows: readonly PickerOption<unknown>[]; lines: string[]; asked?: string[] }, answers: string[] = []) => ({
    question: async (label: string) => { seen.asked?.push(label); return answers.shift() ?? ''; },
    select: async <T>(title: string, options: readonly PickerOption<T>[], _onAction: unknown, settings?: PickerSettings<T>) => {
      await Promise.all([settings?.refresh ?? []].flat());
      const rows = (settings?.refreshedOptions?.() ?? options) as readonly PickerOption<unknown>[];
      if (title === 'Move this chat to') seen.rows = rows;
      return choose[title]?.(rows) as T | undefined;
    },
    activity: (line: string) => { seen.lines.push(stripAnsi(line)); },
    close: () => undefined,
  }) as unknown as HarnessPrompter;

  it('lists the machines Tailscale knows and that are not added, under this one and the added ones', async () => {
    await updateMachines(() => []);
    const seen = { rows: [] as readonly PickerOption<unknown>[], lines: [] as string[] };
    expect(await moveTerminalChat(picker({}, seen), { local: 'x' }, 'x', false, localMoveEnd())).toBeUndefined();
    expect(seen.rows.map((row) => [row.group, row.label, row.detail])).toEqual([
      [undefined, localMachineName(), '· this chat is here'],
      ['On your tailnet', 'devbox', '· linux · add: install ClikCode'],
      ['On your tailnet', 'imac', '· macOS · add: install ClikCode'],
      ['On your tailnet', 'winbox', '· windows · not supported yet'],
      ['On your tailnet', 'macbook', '· macOS · offline'],
      ['Somewhere else', 'Add by SSH address…', '· user@host or a Host alias from ~/.ssh/config'],
    ]);
  });

  it('adds one chosen there -- which user, then the install -- and the chat starts on it', async () => {
    await updateMachines(() => []);
    host(root, 'devbox.tail-fake.ts.net', { users: ['dev'] });
    const seen = { rows: [] as readonly PickerOption<unknown>[], lines: [] as string[], asked: [] as string[] };
    const next = await moveTerminalChat(picker({ 'Move this chat to': () => 'tailscale:nBox' }, seen, ['dev']), { local: 'x' }, 'x', false, localMoveEnd());
    expect(seen.asked).toEqual(['Log in to devbox as which user? › ']);
    const [machine] = await readMachines();
    expect(machine).toMatchObject({ name: 'devbox', sshTarget: 'dev@devbox.tail-fake.ts.net', ready: true });
    expect(next).toEqual({ remote: { machineId: machine!.id } });
    expect(seen.lines.filter((line) => line.startsWith('✓')).length).toBe(6);
    expect(seen.lines.at(-1)).toMatch(/^devbox is added/);
  }, 120_000);

  it('moves nothing to an offline or Windows machine', async () => {
    await updateMachines(() => []);
    const seen = { rows: [] as readonly PickerOption<unknown>[], lines: [] as string[] };
    await expect(moveTerminalChat(picker({ 'Move this chat to': () => 'tailscale:nWin' }, seen), { local: 'x' }, 'x', false, localMoveEnd()))
      .rejects.toThrow(/winbox is Windows, not supported yet/);
    await expect(moveTerminalChat(picker({ 'Move this chat to': () => 'tailscale:nMac' }, seen), { local: 'x' }, 'x', false, localMoveEnd()))
      .rejects.toThrow(/macbook is offline/);
    expect(await readMachines()).toEqual([]);
  });
});

describe('keeping machines at this build', () => {
  const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  it('decides: only an outdated machine, only by policy auto, only with a commit to match, once per commit', () => {
    const auto = { id: 'm', updates: 'auto' as const };
    const none = new Set<string>();
    expect(autoUpdateDecision(auto, false, 'c1', none)).toEqual({ update: false, reason: 'current' });
    expect(autoUpdateDecision(auto, true, 'c1', none)).toEqual({ update: true, commit: 'c1' });
    // A record from before the field is automatic.
    expect(autoUpdateDecision({ id: 'm' }, true, 'c1', none)).toEqual({ update: true, commit: 'c1' });
    expect(autoUpdateDecision({ id: 'm', updates: 'ask' }, true, 'c1', none)).toEqual({ update: false, reason: 'ask' });
    // A packed build has no commit: nothing to match it to.
    expect(autoUpdateDecision(auto, true, undefined, none)).toEqual({ update: false, reason: 'no-commit' });
    expect(autoUpdateDecision(auto, true, 'c1', new Set(['m\0c1']))).toEqual({ update: false, reason: 'attempted' });
    expect(autoUpdateDecision(auto, true, 'c2', new Set(['m\0c1']))).toEqual({ update: true, commit: 'c2' });
    expect(newMachineRecord({ name: 'n', sshTarget: 'n' }).updates).toBe('auto');
  });

  it('tries each machine once per commit, one update at a time, failed or not', async () => {
    await updateMachines(() => []);
    const runs: string[] = [];
    let finish: (ok: boolean) => void = () => undefined;
    const updates = new AutoUpdates((machine, commit) => {
      runs.push(`${machine.name}@${commit}`);
      return new Promise((resolve) => { finish = (ok) => resolve(ok ? { ok: true, info: { version: '1', commit }, probe: { os: 'Linux', arch: 'x86_64', home: '/h' } } : { ok: false, step: 'Building and installing', message: 'boom' }); });
    });
    const machine = newMachineRecord({ name: 'box', sshTarget: 'box', ready: true });
    const first = await updates.consider(machine, 'c1');
    const second = await updates.consider(machine, 'c1');
    expect(first && second && first.done === second.done).toBe(true);
    finish(false);
    expect(await first!.done).toMatchObject({ ok: false });
    expect(await updates.consider(machine, 'c1')).toBeUndefined();
    expect(await updates.consider({ ...machine, updates: 'ask' }, 'c2')).toBeUndefined();
    const next = await updates.consider(machine, 'c2');
    finish(true);
    expect(await next!.done).toMatchObject({ ok: true });
    expect(runs).toEqual(['box@c1', 'box@c2']);
  });

  it('updates an outdated machine to this build’s commit by itself, then connects to the new build', async () => {
    const older = gitIn(fakeWorld.work, 'rev-parse', 'HEAD~1');
    const { home } = host(root, 'lagging');
    installAt(root, 'lagging', fakeWorld.repoUrl, older);
    const machine = newMachineRecord({ name: 'lagging', sshTarget: 'lagging', ready: true });
    await updateMachines(() => [machine]);
    const seen: string[] = [];
    const link = new RemoteLink(machine, () => { seen.push(stripAnsi(updateText(link.view))); }, { localCommit: fakeWorld.commit, autoUpdates: new AutoUpdates() });
    link.start();
    try {
      await until(() => seen.includes(' · updating ClikCode…'), 30_000);
      await until(() => link.view.state === 'connected' && !link.view.updating && !link.view.needsUpdate, 60_000);
    } finally { await link.stop(); }
    expect(seen).toContain(' · needs update (/machine)');
    expect(seen.at(-1)).toBe('');
    expect(gitIn(join(home, '.local', 'share', 'clikcode', 'src'), 'rev-parse', 'HEAD')).toBe(fakeWorld.commit);
    const [record] = await readMachines();
    expect(record).toMatchObject({ needsUpdate: false, installed: { commit: fakeWorld.commit } });
    expect(record!.updateError).toBeUndefined();
  }, 120_000);

  it('leaves a machine set to ask alone, saying it needs an update', async () => {
    const older = gitIn(fakeWorld.work, 'rev-parse', 'HEAD~1');
    const { home } = host(root, 'careful');
    installAt(root, 'careful', fakeWorld.repoUrl, older);
    const machine = newMachineRecord({ name: 'careful', sshTarget: 'careful', ready: true, updates: 'ask' });
    await updateMachines(() => [machine]);
    const link = new RemoteLink(machine, () => undefined, { localCommit: fakeWorld.commit, autoUpdates: new AutoUpdates() });
    link.start();
    try {
      await until(() => link.view.state === 'connected');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(link.view).toMatchObject({ needsUpdate: true });
      expect(link.view.updating).toBeFalsy();
    } finally { await link.stop(); }
    expect(gitIn(join(home, '.local', 'share', 'clikcode', 'src'), 'rev-parse', 'HEAD')).toBe(older);
    expect(outdatedNotice(machine, false)).toBe('careful runs another ClikCode build than this one. Type /update to update it, or Tab on it in /machine.');
  }, 60_000);

  it('records a failed update and does not try that commit again', async () => {
    const older = gitIn(fakeWorld.work, 'rev-parse', 'HEAD~1');
    host(root, 'stuck');
    installAt(root, 'stuck', fakeWorld.repoUrl, older);
    const machine = newMachineRecord({ name: 'stuck', sshTarget: 'stuck', ready: true });
    await updateMachines(() => [machine]);
    const updates = new AutoUpdates();
    const link = new RemoteLink(machine, () => undefined, { localCommit: 'd'.repeat(40), autoUpdates: updates, backoffMs: [50] });
    link.start();
    try {
      await until(() => Boolean(link.view.updateError), 60_000);
      expect(link.view).toMatchObject({ needsUpdate: true, updating: false });
      expect(stripAnsi(updateText(link.view))).toBe(' · update failed (/machine)');
    } finally { await link.stop(); }
    const [record] = await readMachines();
    expect(record!.updateError).toMatch(/^Getting ClikCode from GitHub: .*has no commit d{40}/);
    expect(await updates.consider(record!, 'd'.repeat(40))).toBeUndefined();
    expect(outdatedNotice(record!, false)).toMatch(/^stuck runs another ClikCode build than this one, and updating it failed \(Getting ClikCode/);
  }, 60_000);
});

describe('ide-bridge --stdio (the built CLI)', () => {
  const entry = join(REPO, 'dist', 'index.js');
  const built = existsSync(entry) && readFileSync(join(REPO, 'dist', 'cli.js'), 'utf8').includes('bridge-stdio');
  it.skipIf(!built)('relays the multiplexed bridge as JSON lines, and exits when stdin closes', async () => {
    const { spawn } = await import('node:child_process');
    const { createInterface } = await import('node:readline');
    const child = spawn(process.execPath, [entry, 'ide-bridge', '--stdio'], { env: { ...process.env, CLIKCODE_IDE_MULTIPLEX: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const events: Array<{ type: string; chat?: string; event?: { type: string; data?: unknown } }> = [];
    const nonJson: string[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { nonJson.push(line); return; }
      events.push(event);
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      if (event.type === 'host-ready') send({ type: 'chat-attach', chat: 'b' });
      if (event.type === 'chat' && event.event.type === 'ready') send({ type: 'chat', chat: 'b', request: { type: 'query', requestId: 'q', query: 'conversations' } });
      if (event.type === 'chat' && event.event.type === 'result') child.stdin.end();
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(nonJson).toEqual([]);
    expect(code).toBe(0);
    expect(events[0]).toMatchObject({ type: 'host-ready', protocol: 1, installationId: expect.any(String) });
    expect(events.at(-1)).toMatchObject({ type: 'chat', chat: 'b', event: { type: 'result', ok: true, data: [] } });
  }, 30_000);
});

/** Two machines, as they really are: the one that owns a chat has its own HOME, user and
 * folders, and a folder of the editor's machine is not there. Driven through the fake ssh
 * against this build's real bridge on the other side. Before 47aec532 the owner started the
 * vendor in the editor's folder, which Node reported as `spawn claude-agent-acp ENOENT`. */
describe('a chat on the machine that owns it', () => {
  const entry = join(REPO, 'dist', 'index.js');
  const built = existsSync(entry) && readFileSync(join(REPO, 'dist', 'cli.js'), 'utf8').includes('bridge-stdio');
  // The editor machine's home: a path of the client's, which the owner does not have.
  const editorHome = join(mkdtempSync(join(tmpdir(), 'cc-editor-machine-')), 'home', 'editor');
  let owner: { home: string };

  beforeAll(() => {
    owner = host(root, 'owner', {});
    const bin = join(owner.home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'clikcode'), `#!/bin/sh\nexec ${process.execPath} ${entry} "$@"\n`, { mode: 0o755 });
  });

  it('has its own HOME, user and working folder, and not the editor machine\'s folders', async () => {
    const seen = await runSsh('someone@owner', 'echo "$HOME|$USER|$PWD|$(pwd)"; test -d ' + shellQuote(editorHome) + ' && echo editor-home-here || echo editor-home-absent');
    expect(seen.code).toBe(0);
    const [identity, editor] = seen.stdout.trim().split('\n');
    expect(identity).toBe(`${owner.home}|someone|${owner.home}|${owner.home}`);
    expect(editor).toBe('editor-home-absent');
    expect(owner.home.startsWith(process.env.HOME ?? '\0')).toBe(false);
  });

  it.skipIf(!built)('opens a new chat in its own home, and resumes one saved in a foreign folder there, saying so', async () => {
    // A chat saved with the editor's folder, as VS Code once made one.
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = join(owner.home, '.clikcode');
    try {
      const { writeState } = await import('../session/state/write.js');
      await writeState({
        sessions: [{ id: 'stale', conversationId: 'stale', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high',
          permissionMode: 'ask', nativeHarness: 'claude', messages: [{ role: 'user', content: 'hi' }], workspace: editorHome,
          createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', status: 'active' }],
        accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' },
      } as never);
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
    }
    const { spawnSsh } = await import('./ssh.js');
    const { bridgeScript } = await import('./install.js');
    const { createInterface } = await import('node:readline');
    const child = spawnSsh('owner', bridgeScript());
    const events: Array<{ type: string; message?: string; level?: string; requestId?: string; ok?: boolean; error?: string; session?: { id: string; workspace?: string } }> = [];
    const send = (request: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ type: 'chat', chat: 'a', request })}\n`);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'host-ready') { child.stdin.write(`${JSON.stringify({ type: 'chat-attach', chat: 'a' })}\n`); return; }
      if (message.type !== 'chat' || message.chat !== 'a') return;
      const event = message.event;
      events.push(event);
      if (event.type === 'ready') send({ type: 'open', requestId: 'new', mode: 'new', workspace: editorHome });
      if (event.type === 'result' && event.requestId === 'new') send({ type: 'open', requestId: 'resume', mode: 'resume', sessionId: 'stale', workspace: '' });
      if (event.type === 'result' && event.requestId === 'resume') child.stdin.end();
    });
    await new Promise((resolve) => child.once('exit', resolve));
    const results = events.filter((event) => event.type === 'result');
    expect(results, stderr).toMatchObject([{ requestId: 'new', ok: true }, { requestId: 'resume', ok: true }]);
    const sessions = events.filter((event) => event.type === 'session').map((event) => event.session!);
    const fresh = sessions.find((session) => session.id !== 'stale');
    expect(fresh?.workspace).toBe(owner.home);
    expect(sessions.filter((session) => session.id === 'stale').map((session) => session.workspace)).toContain(owner.home);
    const notices = events.filter((event) => event.type === 'notice');
    expect(notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warning', message: expect.stringMatching(new RegExp(`^The folder ${editorHome} does not exist on .+; this chat opens in ${owner.home}\\.$`)) }),
      expect.objectContaining({ level: 'warning', message: expect.stringMatching(new RegExp(`^The folder ${editorHome} does not exist on .+; this chat continues in ${owner.home}\\.$`)) }),
    ]));
    expect(JSON.stringify(events)).not.toMatch(/ENOENT/);
  }, 60_000);
});

/** The machine's ClikCode is updated while a chat there is open and quiet: the bridge serving
 * it -- this build's real one, over the fake ssh -- leaves for the new build, and the chat
 * connects again and resumes with nothing said (ide/bridge-retire.ts). The "release" is a
 * one-line entry importing this build, so rewriting it is a new build there. */
describe('a chat whose machine is updated under it', () => {
  const entry = join(REPO, 'dist', 'index.js');
  const built = existsSync(entry) && readFileSync(join(REPO, 'dist', 'cli.js'), 'utf8').includes('bridge-retire');
  it.skipIf(!built)('reconnects onto the new build and goes on, with no error', async () => {
    const machineHome = join(root, 'hosts', 'renewed', 'home');
    const release = join(machineHome, 'release', 'index.mjs');
    host(root, 'renewed', { env: { CLIKCODE_WORKER_BUILD_WATCH_MS: '100', CLIKCODE_WORKER_RETIRE_QUIET_MS: '300' } });
    mkdirSync(join(machineHome, 'release'), { recursive: true });
    mkdirSync(join(machineHome, '.local', 'bin'), { recursive: true });
    writeFileSync(release, `import ${JSON.stringify(entry)};\n`);
    writeFileSync(join(machineHome, '.local', 'bin', 'clikcode'), `#!/bin/sh\nexec ${process.execPath} ${release} "$@"\n`, { mode: 0o755 });
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = join(machineHome, '.clikcode');
    try {
      const { writeState } = await import('../session/state/write.js');
      await writeState({
        sessions: [{ id: 'kept', conversationId: 'kept', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high',
          permissionMode: 'ask', nativeHarness: 'claude', messages: [{ role: 'user', content: 'hi' }], workspace: machineHome,
          createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', status: 'active' }],
        accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' },
      } as never);
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
    }
    const machine = newMachineRecord({ name: 'renewed', sshTarget: 'renewed', ready: true });
    await updateMachines(() => [machine]);
    const said: string[] = [];
    const prompts: Array<(line: string) => void> = [];
    const terminal = new Proxy({}, {
      get: (_target, key) => {
        if (key === 'question') {
          return (_prompt: string, _items: unknown, options: { signal?: AbortSignal }) => new Promise<string>((resolve, reject) => {
            const interrupted = () => reject(Object.assign(new Error('interrupted'), { code: 'ERR_PROMPT_INTERRUPTED' }));
            if (options.signal?.aborted) { interrupted(); return; }
            options.signal?.addEventListener('abort', interrupted, { once: true });
            prompts.push(resolve);
          });
        }
        if (key === 'activity') return (line: string) => said.push(line);
        if (key === 'then') return undefined;
        return () => undefined;
      },
      set: () => true,
    }) as never;
    const { runRemoteChat } = await import('./terminal-chat.js');
    const bridges = () => (existsSync(join(root, 'ssh.log')) ? readFileSync(join(root, 'ssh.log'), 'utf8') : '').split('\n').filter((line) => line.includes('"renewed"') && line.includes('ide-bridge')).length;
    const before = bridges();
    const outcome = runRemoteChat(terminal, 'local-1', { machineId: machine.id, chatId: 'kept' }).then(() => 'returned', (error: Error) => error.message);
    await until(() => prompts.length === 1, 30_000);
    expect(bridges() - before).toBe(1);
    // The update: a new entry where the old one was.
    writeFileSync(release, `import ${JSON.stringify(entry)};\n// a newer build\n`);
    await until(() => prompts.length === 2, 30_000);
    expect(bridges() - before).toBe(2);
    const log = readFileSync(join(machineHome, '.clikcode', 'logs', 'lifecycle.log'), 'utf8');
    expect(log).toContain('bridge.retire');
    expect(log).toContain('replaced by a newer ClikCode build');
    // Still the same chat, and it answers: a setting changed on the new bridge.
    prompts[1]!('/effort low');
    await until(() => prompts.length === 3, 30_000);
    expect(said.filter((line) => /error|closed|lost|failed/i.test(line))).toEqual([]);
    // Done: a connection that ends for good still ends the chat.
    const { spawnSync } = await import('node:child_process');
    // Only this test's processes: the path is in its own temporary directory.
    spawnSync('pkill', ['-f', release]);
    expect(await outcome).toBe('interrupted');
  }, 120_000);
});

describe('/update in a chat on another machine', () => {
  it('goes to the editor\'s build when no commit is named, so automatic updates do not undo it', async () => {
    const { pinnedUpdateLine } = await import('./updates.js');
    expect(pinnedUpdateLine('/update', 'abc1234')).toBe('/update abc1234');
    expect(pinnedUpdateLine('  /update  ', 'abc1234')).toBe('/update abc1234');
    expect(pinnedUpdateLine('/update def5678', 'abc1234')).toBe('/update def5678');
    expect(pinnedUpdateLine('/update', undefined)).toBe('/update');
    expect(pinnedUpdateLine('update the docs', 'abc1234')).toBe('update the docs');
  });
});
