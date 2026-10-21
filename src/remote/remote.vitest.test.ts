/** ClikCode Remote against FAKE machines: a fake `ssh` that runs the remote
 * command locally inside a temporary HOME (scripts/tui-e2e/fake-ssh.mjs), a
 * fake `tailscale` printing a fixture, a file:// repository standing in for
 * GitHub, and a file:// Node mirror. Nothing connects to a real machine. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error -- a plain .mjs fixture module
import { host, tailscaleFixture, world } from '../../scripts/tui-e2e/fake-remote.mjs';
import { shellQuote, validateSshTarget, withUser } from './shell.js';
import { defaultLoginUser, runSsh, sshArgv, sshFailure, sshFailureMessage } from './ssh.js';
import { discoverMachines, readTailscaleStatus, type TailscaleStatus } from './tailscale.js';
import { installOnMachine, nodeIsNewEnough, sourceScript, uninstallFromMachine, type InstallStep } from './install.js';
import { needsUpdate, RemoteLink, RemoteMachines, type MachineView } from './connection.js';
import { machinesPath, newMachineRecord, readMachines, updateMachines, type RemoteMachine } from './machines.js';
import { boardRowsWithMachines, isRemoteRowValue, NEEDS_YOU_GROUP } from './board-rows.js';
import { interactiveRemotePicker, notYetAdded, type RemoteHost } from '../tui/pickers/remote.js';
import type { IdeConversation } from '../ide/protocol.js';
import type { HarnessPrompter, PickerOption, PickerSettings } from '../harness/prompter.js';

const REPO = resolve(__dirname, '..', '..');
const FAKES = join(REPO, 'scripts', 'tui-e2e');
let root: string;
let fakeWorld: { repoUrl: string; mirrorUrl: string; commit: string; bare: string; work: string };
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
  const status = join(root, 'tailscale.json');
  writeFileSync(status, JSON.stringify(tailscaleFixture()));
  process.env.FAKE_TAILSCALE_STATUS = status;
});

afterAll(() => {
  for (const key of ['FAKE_SSH_ROOT', 'CLIKCODE_REMOTE_REPO_URL', 'CLIKCODE_REMOTE_NODE_MIRROR', 'FAKE_TAILSCALE_STATUS']) delete process.env[key];
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

  it('refuses to touch the clone when it has local changes', async () => {
    const source = join(homeOf('devbox'), '.local', 'share', 'clikcode', 'src');
    writeFileSync(join(source, 'package.json'), '{"edited": true}\n');
    const outcome = await installOnMachine('devbox', steps().reporter, { update: true });
    expect(outcome).toMatchObject({ ok: false, step: 'Getting ClikCode from GitHub' });
    if (!outcome.ok) expect(outcome.message).toMatch(/local changes \(M package.json\).*will not overwrite/);
    expect(readFileSync(join(source, 'package.json'), 'utf8')).toBe('{"edited": true}\n');
    execFileSync('git', ['checkout', '-q', '--', 'package.json'], { cwd: source });
  });

  it('installs a user-local Node, checksum verified, when there is none', async () => {
    host(root, 'nonode', { hide: ['node'] });
    const { seen, reporter } = steps();
    const outcome = await installOnMachine('nonode', reporter);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(seen[1]).toEqual({ step: 'Node.js', detail: expect.stringMatching(/^v\d+\.\d+\.\d+ into ~\/\.local\/share\/clikcode\/node \(SHA-256 checked\)$/) });
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
    const link = new RemoteLink(newMachineRecord({ name: 'behind', sshTarget: 'behind', ready: true }), () => undefined, { localCommit: fakeWorld.commit });
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
      const rows = boardRowsWithMachines([], machines.views());
      expect(stripAnsi(rows[0]!.group!)).toBe('sleeping · offline, last seen 1h ago');
      expect(stripAnsi(rows[0]!.label)).toBe('Deploy notes');
    } finally { await machines.close(); }
  });

  it('writes machines.json private to the user', async () => {
    await updateMachines((list) => list);
    expect(statSync(machinesPath()).mode & 0o777).toBe(0o600);
  });
});

describe('the board’s rows', () => {
  const view = (name: string, chats: IdeConversation[], state: MachineView['state'] = 'connected'): MachineView => ({
    machine: newMachineRecord({ name, sshTarget: name, ready: true }), state, needsUpdate: false, chats,
  });

  it('is unchanged with no machine added', () => {
    const local: PickerOption<string>[] = [{ label: 'Mine', value: 'a', group: 'Recent' }];
    expect(boardRowsWithMachines(local, [])).toEqual(local);
  });

  it('pins every machine’s Needs you on top, then this machine, named, then each machine in its sections', () => {
    const local: PickerOption<string>[] = [
      { label: 'Local waiting', value: 'l1', group: 'Recent', activity: 'needs-you', detail: '· needs you' },
      { label: 'Local recent', value: 'l2', group: 'Recent', detail: '· 5m ago' },
    ];
    const rows = boardRowsWithMachines(local, [view('imac', [
      chat('r1', 'Remote working', { section: 'working', activity: 'working', turn: { startedAt: new Date().toISOString(), activeAt: new Date().toISOString() } }),
      chat('r2', 'Remote waiting', { needsYou: true }),
      chat('r3', 'Remote old', { section: 'past', updatedAt: '2026-01-01T00:00:00Z' }),
    ])], Date.now(), 'workstation');
    expect(rows.map((row) => [stripAnsi(row.group!), stripAnsi(row.label)])).toEqual([
      [NEEDS_YOU_GROUP, 'Local waiting'],
      [NEEDS_YOU_GROUP, 'Remote waiting'],
      ['workstation · Recent', 'Local recent'],
      ['imac · Working', 'Remote working'],
      ['imac · Older', 'Remote old'],
    ]);
    expect(rows[1]!.detail).toMatch(/· imac$/);
    expect(rows[3]!.activity).toBe('working');
    expect(stripAnsi(rows[3]!.detail!)).toMatch(/^· working/);
    expect(isRemoteRowValue(rows[3]!.value)).toBe(true);
    expect(isRemoteRowValue(rows[2]!.value)).toBe(false);
  });

  it('does not move this machine’s rows when another machine’s list changes', () => {
    const local: PickerOption<string>[] = [{ label: 'Local recent', value: 'l2', group: 'Recent' }];
    const before = boardRowsWithMachines(local, [view('a', [chat('1', 'one')]), view('b', [chat('2', 'two')])], Date.now(), 'me');
    const after = boardRowsWithMachines(local, [view('a', [chat('1', 'one'), chat('3', 'three')]), view('b', [chat('2', 'two')])], Date.now(), 'me');
    expect(after[0]).toEqual(before[0]);
    expect(after.findIndex((row) => row.label === 'two')).toBe(before.findIndex((row) => row.label === 'two') + 1);
  });
});

describe('/remote', () => {
  /** A prompter that answers lists by title and questions in order. */
  const scripted = (choices: Record<string, (options: readonly PickerOption<unknown>[]) => unknown>, answers: Array<string | undefined>) => {
    const asked: string[] = [];
    const lines: string[] = [];
    const prompter = {
      question: async () => '',
      // As the list would be once what it waits on (Tailscale, each machine's state) has landed.
      select: async <T>(title: string, options: readonly PickerOption<T>[], _onAction: unknown, settings?: PickerSettings<T>) => {
        await Promise.race([Promise.all([settings?.refresh ?? []].flat()), new Promise((resolve) => setTimeout(resolve, 8000))]);
        return choices[title]?.((settings?.refreshedOptions?.() ?? options) as readonly PickerOption<unknown>[]) as T | undefined;
      },
      close: () => undefined,
    } as unknown as HarnessPrompter;
    const remoteHost: RemoteHost = {
      prompter,
      ask: async (label) => { asked.push(label); return answers.shift(); },
      withBusy: (_label, work) => work(),
      line: (text) => lines.push(stripAnsi(text)),
    };
    return { remoteHost, asked, lines };
  };

  it('adds a machine by address; a refused login asks once which user, and remembers it', async () => {
    await updateMachines(() => []);
    host(root, 'guarded', { users: ['carol'] });
    writeFileSync(join(root, 'ssh_config.json'), '{}');
    const fallback = await defaultLoginUser('guarded');
    const { remoteHost, asked, lines } = scripted({
      'ClikCode Remote': (options) => options.find((option) => option.label.startsWith('Add by SSH address'))!.value,
      // The user it refused is named in the list's title, not offered; root is.
      [`Log in to guarded as (not ${fallback})`]: (options) => {
        expect(options.map((option) => option.label)).toEqual(['root', 'Another user…']);
        return options[1]!.value;
      },
    }, ['guarded', 'carol']);
    const outcome = await interactiveRemotePicker(remoteHost);
    expect(asked).toEqual(['SSH address (user@host, host, or a Host alias)', 'User']);
    expect(lines.some((line) => line.startsWith('! ') && /refused the login/.test(line))).toBe(true);
    expect(outcome.notice).toMatch(/guarded is added/);
    expect(lines.filter((line) => line.startsWith('✓')).length).toBe(6);
    const [machine] = await readMachines();
    expect(machine).toMatchObject({ name: 'guarded', sshTarget: 'carol@guarded', ready: true, installed: { version: '1.0.0' } });
    expect(machine!.installationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('asks only once: a second refusal stops with what to do', async () => {
    await updateMachines(() => []);
    host(root, 'fortress', { users: ['nobody-you-know'] });
    const fallbackUser = await defaultLoginUser('fortress');
    const { remoteHost, asked, lines } = scripted({
      'ClikCode Remote': (options) => options.find((option) => option.label.startsWith('Add by SSH address'))!.value,
      [`Log in to fortress as (not ${fallbackUser})`]: () => '__other__',
    }, ['fortress', 'mallory']);
    expect(await interactiveRemotePicker(remoteHost)).toEqual({});
    expect(asked.length).toBe(2);
    expect(lines.at(-1)).toMatch(/refused the login.*ssh-copy-id/);
    // The user given is remembered for the machine.
    const [kept] = await readMachines();
    expect(kept).toMatchObject({ sshTarget: 'mallory@fortress' });
    expect(kept!.ready).toBeFalsy();
  });

  it('lists added machines first, then the tailnet’s, then the address row', async () => {
    await updateMachines(() => [newMachineRecord({ name: 'devbox', sshTarget: 'devbox.tail-fake.ts.net', ready: true, tailscale: { nodeId: 'nBox' } })]);
    let listed: readonly PickerOption<unknown>[] = [];
    const { remoteHost } = scripted({ 'ClikCode Remote': (options) => { listed = options; return undefined; } }, []);
    await interactiveRemotePicker(remoteHost);
    expect(listed.map((option) => [option.group, option.label, stripAnsi(option.detail ?? '').replace(/^· /, '').split(' · ')[0]])).toEqual([
      ['Added', 'devbox', 'offline'],
      ['On your tailnet', 'imac', 'macOS'],
      ['On your tailnet', 'winbox', 'windows'],
      ['On your tailnet', 'macbook', 'macOS'],
      ['Somewhere else', 'Add by SSH address…', 'user@host or a Host alias'],
    ]);
    expect(stripAnsi(listed[3]!.detail!)).toBe('· macOS · last seen 2d ago · install ClikCode');
  });

  it('forgets a machine, and uninstalls there only when chosen', async () => {
    const { home } = host(root, 'retiring');
    expect((await installOnMachine('retiring', steps().reporter)).ok).toBe(true);
    const record: RemoteMachine = newMachineRecord({ name: 'retiring', sshTarget: 'retiring', ready: true });
    await updateMachines(() => [record]);
    const { remoteHost } = scripted({
      'ClikCode Remote': () => `machine:${record.id}`,
      retiring: () => 'remove',
      'Remove retiring': () => 'uninstall',
    }, []);
    const outcome = await interactiveRemotePicker(remoteHost);
    expect(outcome.notice).toMatch(/removed, and ClikCode is uninstalled there\.$/);
    expect(await readMachines()).toEqual([]);
    expect(existsSync(join(home, '.local', 'share', 'clikcode', 'src'))).toBe(false);
    expect(existsSync(join(home, '.clikcode'))).toBe(true);
  });
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
