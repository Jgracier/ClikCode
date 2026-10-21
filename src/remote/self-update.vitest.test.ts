/** /update on the machine that owns the chat: how its ClikCode was installed
 * is read from the running entry, and each kind is updated its own way --
 * against FAKE installs (scripts/tui-e2e/fake-remote.mjs), no real npm,
 * network or machine. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- a plain .mjs fixture module
import { host, installAt, world } from '../../scripts/tui-e2e/fake-remote.mjs';
import { detectInstall, parseCommitArgument, updateThisMachine } from './self-update.js';
import type { ScriptRunner } from './install.js';
import type { SshResult } from './ssh.js';

const file = (path: string, text = ''): string => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); return path; };

/** A managed install's layout under `home`: the clone, the release, the link. */
function managedLayout(home: string, modules?: string): string {
  mkdirSync(join(home, '.local', 'share', 'clikcode', 'src', '.git'), { recursive: true });
  const entry = file(join(home, '.local', 'share', 'clikcode', 'release', 'dist', 'index.js'));
  if (modules) symlinkSync(modules, join(home, '.local', 'share', 'clikcode', 'release', 'node_modules'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  symlinkSync(entry, join(home, '.local', 'bin', 'clikcode'));
  return join(home, '.local', 'bin', 'clikcode');
}

describe('which install this is', () => {
  it('a ClikCode Remote install: its clone, and the entry in its release', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-kind-managed-'));
    const bin = managedLayout(home, join(home, '.local', 'share', 'clikcode', 'src', 'node_modules'));
    mkdirSync(join(home, '.local', 'share', 'clikcode', 'src', 'node_modules'));
    expect(await detectInstall(bin, home)).toEqual({ kind: 'managed' });
  });

  it('a release install-local made from a developer checkout is that checkout', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-kind-dev-'));
    const repo = mkdtempSync(join(tmpdir(), 'cc-kind-repo-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'node_modules'));
    // Even beside a managed clone: the release's node_modules are the checkout's.
    const bin = managedLayout(home, join(repo, 'node_modules'));
    expect(await detectInstall(bin, home)).toEqual({ kind: 'checkout', repo });
  });

  it('the npm package, and a checkout run from its own dist', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'cc-kind-npm-'));
    const entry = file(join(prefix, 'lib', 'node_modules', 'clikcode', 'dist', 'index.js'));
    expect(await detectInstall(entry, prefix)).toEqual({ kind: 'npm', packageRoot: join(prefix, 'lib', 'node_modules', 'clikcode') });
    const repo = mkdtempSync(join(tmpdir(), 'cc-kind-src-'));
    mkdirSync(join(repo, '.git'));
    expect(await detectInstall(file(join(repo, 'dist', 'cli.js')), prefix)).toEqual({ kind: 'checkout', repo });
    expect(await detectInstall('/nowhere/at/all.js', prefix)).toEqual({ kind: 'checkout' });
  });

  it('takes a commit as hex only', () => {
    expect(parseCommitArgument('')).toBeUndefined();
    expect(parseCommitArgument(' ABCDEF1 ')).toBe('abcdef1');
    expect(() => parseCommitArgument('main; rm -rf ~')).toThrow(/7 to 40 hex/);
  });
});

/** A runner that answers by script, recording what ran. */
function scriptedRunner(answers: Array<[RegExp, SshResult]>): ScriptRunner & { ran: string[] } {
  const ran: string[] = [];
  const run = (async (script: string) => {
    ran.push(script);
    return answers.find(([pattern]) => pattern.test(script))?.[1] ?? { code: 127, stdout: '', stderr: 'not expected' };
  }) as ScriptRunner & { ran: string[] };
  run.ran = ran;
  return run;
}

describe('/update, by kind', () => {
  const npmEntry = (): { entry: string; home: string } => {
    const prefix = mkdtempSync(join(tmpdir(), 'cc-npm-'));
    return { entry: file(join(prefix, 'lib', 'node_modules', 'clikcode', 'dist', 'index.js')), home: prefix };
  };

  it('a developer checkout: touches nothing, and says what to run there', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cc-dev-'));
    mkdirSync(join(repo, '.git'));
    const run = scriptedRunner([]);
    const lines: string[] = [];
    const result = await updateThisMachine({ entry: file(join(repo, 'dist', 'cli.js')), home: repo, run, line: (text) => lines.push(text), hostName: 'laptop' });
    expect(result).toEqual({ kind: 'checkout', updated: false, text: `This ClikCode on laptop is built from a developer checkout (${repo}); /update does not touch a checkout. To update it, run \`git pull && pnpm run install-local\` in ${repo}.` });
    expect(run.ran).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('the npm package: the latest version, already there or installed; no commits', async () => {
    const { entry, home } = npmEntry();
    const same = scriptedRunner([[/npm view/, { code: 0, stdout: '1.2.3\n', stderr: '' }]]);
    expect(await updateThisMachine({ entry, home, run: same, line: () => undefined, hostName: 'box', running: { version: '1.2.3' } }))
      .toMatchObject({ kind: 'npm', updated: false, text: 'ClikCode 1.2.3 on box is already up to date.' });
    expect(same.ran).toEqual(['npm view clikcode version']);
    const newer = scriptedRunner([[/npm view/, { code: 0, stdout: '1.3.0\n', stderr: '' }], [/npm install -g clikcode@latest/, { code: 0, stdout: '', stderr: '' }]]);
    const lines: string[] = [];
    expect(await updateThisMachine({ entry, home, run: newer, line: (text) => lines.push(text), hostName: 'box', running: { version: '1.2.3' } }))
      .toMatchObject({ updated: true, text: 'ClikCode 1.2.3 → 1.3.0 on box; chats switch over once they are quiet.' });
    expect(lines).toEqual(['✓ 1/2 Checking npm · clikcode 1.3.0 is the latest', expect.stringMatching(/^✓ 2\/2 Installing clikcode@latest · /)]);
    await expect(updateThisMachine({ entry, home, run: newer, line: () => undefined, commit: 'abcdef1' })).rejects.toThrow(/npm package.*not commits/);
    const refused = scriptedRunner([[/npm view/, { code: 0, stdout: '1.3.0\n', stderr: '' }], [/npm install/, { code: 1, stdout: '', stderr: 'npm ERR! EACCES: permission denied\n' }]]);
    await expect(updateThisMachine({ entry, home, run: refused, line: () => undefined, running: { version: '1.2.3' } })).rejects.toThrow(/^Installing clikcode@latest: .*EACCES/);
  });

  describe('a ClikCode Remote install, with the same scripts Remote runs', () => {
    let root: string;
    let fake: { repoUrl: string; commit: string; first: string };
    let machine: { home: string; bin: string };
    const saved = process.env.CLIKCODE_REMOTE_REPO_URL;
    /** This "machine"'s own sh: its HOME and PATH. */
    const runHere: ScriptRunner = (script) => new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', script], { cwd: machine.home, env: { HOME: machine.home, PATH: machine.bin, LANG: 'C' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
    const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(machine.home, '.local', 'share', 'clikcode', 'src'), encoding: 'utf8' }).trim();

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'cc-self-'));
      fake = world(root, { second: true });
      machine = host(root, 'self');
      installAt(root, 'self', fake.repoUrl, fake.first);
      process.env.CLIKCODE_REMOTE_REPO_URL = fake.repoUrl;
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.CLIKCODE_REMOTE_REPO_URL; else process.env.CLIKCODE_REMOTE_REPO_URL = saved;
    });

    it('updates to main, step by step, and says from what to what', async () => {
      const lines: string[] = [];
      const entry = join(machine.home, '.local', 'bin', 'clikcode');
      const result = await updateThisMachine({ entry, home: machine.home, run: runHere, line: (text) => lines.push(text), hostName: 'self', running: { version: '1.0.0', commit: fake.first } });
      expect(result).toEqual({ kind: 'managed', updated: true, text: `ClikCode ${fake.first.slice(0, 8)} → ${fake.commit.slice(0, 8)} on self; chats switch over once they are quiet.` });
      expect(lines).toEqual([
        `✓ 1/3 Getting ClikCode from GitHub · updated at ${fake.commit.slice(0, 8)}`,
        '✓ 2/3 Building and installing · ~/.local/bin/clikcode',
        `✓ 3/3 Checking the install · ClikCode 1.0.0 (${fake.commit.slice(0, 8)})`,
      ]);
      expect(head()).toBe(fake.commit);
      // Again, running that build: nothing to do, nothing rebuilt.
      const again: string[] = [];
      expect(await updateThisMachine({ entry, home: machine.home, run: runHere, line: (text) => again.push(text), hostName: 'self', running: { version: '1.0.0', commit: fake.commit } }))
        .toEqual({ kind: 'managed', updated: false, text: `ClikCode ${fake.commit.slice(0, 8)} on self is already up to date.` });
      expect(again).toHaveLength(1);
    }, 60_000);

    it('goes to a chosen commit, and names the step when it cannot', async () => {
      const entry = join(machine.home, '.local', 'bin', 'clikcode');
      const result = await updateThisMachine({ entry, home: machine.home, run: runHere, line: () => undefined, hostName: 'self', commit: fake.first.slice(0, 10), running: { version: '1.0.0', commit: fake.commit } });
      expect(result.text).toBe(`ClikCode ${fake.commit.slice(0, 8)} → ${fake.first.slice(0, 8)} on self; chats switch over once they are quiet.`);
      expect(head()).toBe(fake.first);
      await expect(updateThisMachine({ entry, home: machine.home, run: runHere, line: () => undefined, hostName: 'self', commit: 'f'.repeat(40) }))
        .rejects.toThrow(/^Getting ClikCode from GitHub: .*has no commit f{40}/);
    }, 60_000);
  });
});
