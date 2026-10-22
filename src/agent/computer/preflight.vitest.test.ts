import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockCredentialVault } from './credential-vault.js';
import { checkDepsLink, classifyGmail, classifyGoogleSignIn, postToClikDeploy, runPreflight, type PreflightPage } from './preflight.js';
import { saveProfile } from './profiles.js';

const made: string[] = [];
afterEach(async () => { for (const dir of made.splice(0)) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); } });
const scratch = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), 'clikcode-preflight-')); made.push(dir); return dir; };

/** A page that ends on the address `landing` says for each address asked for. */
const fakePage = (landing: Record<string, string>, present: string[] = [], visited: string[] = []): PreflightPage & { closed: boolean } => {
  let at = 'about:blank';
  const page = {
    closed: false,
    goto: async (url: string) => { visited.push(url); at = Object.entries(landing).find(([from]) => url.startsWith(from))?.[1] ?? url; },
    url: () => at,
    locator: (selector: string) => ({ count: async () => (present.some(item => selector.includes(item)) ? 1 : 0), first: () => ({ waitFor: async () => { if (!present.some(item => selector.includes(item))) throw new Error('timeout'); } }) }),
    close: async () => { page.closed = true; },
  };
  return page;
};

describe('classifyGoogleSignIn', () => {
  it('is signed in on the account page and signed out on the sign-in form, the account chooser or anywhere else', () => {
    expect(classifyGoogleSignIn('https://myaccount.google.com/?pli=1', { emailBox: false }).signedIn).toBe(true);
    expect(classifyGoogleSignIn('https://accounts.google.com/v3/signin/identifier?flowName=x', { emailBox: true })).toMatchObject({ signedIn: false, reason: expect.stringContaining('sign-in form') });
    expect(classifyGoogleSignIn('https://accounts.google.com/', { emailBox: true }).signedIn).toBe(false);
    expect(classifyGoogleSignIn('https://accounts.google.com/AccountChooser?x=1', { emailBox: false }).reason).toContain('chooser');
    expect(classifyGoogleSignIn('https://example.com/', { emailBox: false }).reason).toContain('example.com');
    expect(classifyGoogleSignIn('about:blank', { emailBox: false }).signedIn).toBe(false);
  });
  it('gmail is readable only on mail.google.com with the inbox rendered', () => {
    expect(classifyGmail('https://mail.google.com/mail/u/0/#inbox', true).readable).toBe(true);
    expect(classifyGmail('https://mail.google.com/mail/u/0/#inbox', false).reason).toContain('did not render');
    expect(classifyGmail('https://accounts.google.com/v3/signin', true).reason).toContain('sign-in');
  });
});

describe('checkDepsLink', () => {
  const release = async (modulesTarget: string): Promise<string> => {
    const dir = await scratch();
    await writeFile(join(dir, 'package.json'), '{"name":"x"}');
    await symlink(modulesTarget, join(dir, 'node_modules'));
    return dir;
  };
  const modules = async (names: string[]): Promise<string> => {
    const dir = await scratch();
    for (const name of names) { await mkdir(join(dir, name), { recursive: true }); await writeFile(join(dir, name, 'package.json'), `{"name":"${name}","version":"1.0.0"}`); }
    return dir;
  };

  it('passes when the link resolves playwright-core and yaml outside the temp folder', async () => {
    const real = await modules(['playwright-core', 'yaml']);
    const elsewhere = await scratch(); // stands in for the temp folder: a different one from where the modules live
    expect(checkDepsLink(await release(real), elsewhere).ok).toBe(true);
  });
  it('fails when the link points into the temp folder, at nothing, or lacks a package', async () => {
    const real = await modules(['playwright-core', 'yaml']);
    const inTemp = checkDepsLink(await release(real), tmpdir());
    expect(inTemp).toMatchObject({ ok: false, reason: expect.stringContaining('temp folder') });
    const outside = await scratch();
    expect(checkDepsLink(await release(join(outside, 'gone')), outside).reason).toContain('missing or points at nothing');
    const partial = await modules(['playwright-core']);
    expect(checkDepsLink(await release(partial), outside).reason).toContain('yaml does not resolve');
    expect(checkDepsLink(undefined).reason).toContain('no installed release');
  });
});

describe('runPreflight', () => {
  const good = async (): Promise<string> => { const real = await scratch(); for (const name of ['playwright-core', 'yaml']) { await mkdir(join(real, name), { recursive: true }); await writeFile(join(real, name, 'package.json'), '{}'); } const rel = await scratch(); await writeFile(join(rel, 'package.json'), '{}'); await symlink(real, join(rel, 'node_modules')); return rel; };

  it('reports all four yes, using the profile mailbox, and closes its tab', async () => {
    const stateDir = await scratch();
    await saveProfile(stateDir, { label: 'Personal', fields: { sso_email: 'me@example.test' } });
    const visited: string[] = [];
    const page = fakePage({ 'https://accounts.google.com/': 'https://myaccount.google.com/' }, ['role="main"'], visited);
    const result = await runPreflight({ stateDir, openPage: async () => page, releaseDir: await good(), temp: await scratch(), buildId: 'abc1234' });
    expect(result).toMatchObject({ browserOk: true, googleSignedIn: true, gmailReadable: true, depsLinkOk: true, ok: true, buildId: 'abc1234', reasons: [] });
    expect(visited[1]).toBe('https://mail.google.com/mail/u/me%40example.test/#inbox');
    expect(page.closed).toBe(true);
  });

  it('signed out: says why, skips Gmail, and is not ok', async () => {
    const page = fakePage({ 'https://accounts.google.com/': 'https://accounts.google.com/v3/signin/identifier' }, ['#identifierId']);
    const result = await runPreflight({ stateDir: await scratch(), openPage: async () => page, releaseDir: await good(), temp: await scratch(), buildId: 'b' });
    expect(result).toMatchObject({ browserOk: true, googleSignedIn: false, gmailReadable: false, depsLinkOk: true, ok: false });
    expect(result.reasons.join('\n')).toContain('googleSignedIn: Google shows its sign-in form');
    expect(page.closed).toBe(true);
  });

  it('a browser that will not start, and a release linked into temp, are reported and never thrown', async () => {
    const real = await scratch(); for (const name of ['playwright-core', 'yaml']) { await mkdir(join(real, name)); await writeFile(join(real, name, 'package.json'), '{}'); }
    const rel = await scratch(); await writeFile(join(rel, 'package.json'), '{}'); await symlink(real, join(rel, 'node_modules'));
    const result = await runPreflight({ stateDir: await scratch(), openPage: async () => { throw new Error('ClikCode Chrome could not start.\nmore'); }, releaseDir: rel, temp: tmpdir(), buildId: 'b' });
    expect(result).toMatchObject({ browserOk: false, googleSignedIn: false, gmailReadable: false, depsLinkOk: false, ok: false });
    expect(result.reasons[0]).toBe('browserOk: ClikCode Chrome could not start.');
    expect(result.reasons.join('\n')).toContain('depsLinkOk');
  });

  it('posts the result when a poster is given, and a failing poster does not fail the check', async () => {
    const page = fakePage({ 'https://accounts.google.com/': 'https://myaccount.google.com/' }, ['role="main"']);
    const base = { stateDir: await scratch(), openPage: async () => page, releaseDir: await good(), temp: await scratch(), buildId: 'b' };
    expect((await runPreflight({ ...base, post: async () => 'posted' })).clikdeploy).toBe('posted');
    expect((await runPreflight({ ...base, post: async () => { throw new Error('offline'); } })).clikdeploy).toBe('not posted: offline');
  });
});

describe('postToClikDeploy', () => {
  it('says plainly when ClikDeploy has no connector_preflight tool, without running anything', async () => {
    const dir = await scratch();
    const { chmod } = await import('node:fs/promises');
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'bin', 'clikdeploy'), `#!/bin/sh\necho '{"status":"success","data":[{"name":"deploy_read"}]}'\n`);
    await chmod(join(dir, 'bin', 'clikdeploy'), 0o755);
    const old = process.env.PATH; process.env.PATH = `${join(dir, 'bin')}:${old}`;
    try {
      const result = { browserOk: true, googleSignedIn: true, gmailReadable: true, buildId: 'b', depsLinkOk: true, ok: true, reasons: [], checkedAt: 'now' };
      expect(await postToClikDeploy(result)).toBe('not posted: ClikDeploy has no connector_preflight tool yet');
      await writeFile(join(dir, 'bin', 'clikdeploy'), `#!/bin/sh\ncase "$2" in search) echo '{"status":"success","data":[{"name":"connector_preflight"}]}';; run) printf "%s" "$5" > "${dir}/body"; echo '{"status":"success"}';; esac\n`);
      expect(await postToClikDeploy(result)).toBe('posted');
      const { readFile } = await import('node:fs/promises');
      expect(JSON.parse(await readFile(join(dir, 'body'), 'utf8'))).toMatchObject({ buildId: 'b', ok: true });
    } finally { process.env.PATH = old; }
  });
});
