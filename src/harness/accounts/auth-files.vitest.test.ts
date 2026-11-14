import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptAuthFiles, authEvidencePresent, authFilePresent, authFilesStamp, expandAuthPath, prepareAuthFilesForLogin, harnessCanLogout, removableAuthFiles, removeAuthFiles } from './auth-files.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';

const harness = (fields: Partial<AiLocalHarnessDefinition>): AiLocalHarnessDefinition => ({
  command: 'x', provider: 'x', displayName: 'X', localAuth: ['vendor-cli'], binary: 'x', ...fields,
}) as AiLocalHarnessDefinition;

describe('vendor credential files', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'auth-files-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('is signed in only once a file the vendor cannot do without is there too', async () => {
    // OpenHands: the cloud key is written first, the agent settings it needs a moment later.
    const openhands = AI_LOCAL_HARNESSES.find((item) => item.command === 'openhands')!;
    const environment = { HOME: root, OPENHANDS_PERSISTENCE_DIR: join(root, '.openhands') };
    await mkdir(join(root, '.openhands', 'cloud'), { recursive: true });
    await writeFile(join(root, '.openhands', 'cloud', 'api_key.txt'), 'sk-oh-1');
    expect(await authFilePresent(openhands, environment, {})).toBe(false);
    expect(await authEvidencePresent(openhands, environment, {})).toBe(false);
    await writeFile(join(root, '.openhands', 'agent_settings.json'), '{"llm":{"api_key":"k"}}');
    expect(await authFilePresent(openhands, environment, {})).toBe(true);
    // Without a required file, any one is still enough (Droid's alternatives).
    const either = harness({ authFiles: [{ path: '~/a' }, { path: '~/b' }] });
    await writeFile(join(root, 'b'), 'x');
    expect(await authFilePresent(either, { HOME: root }, {})).toBe(true);
  });

  it('carries a fresh sign-in into the account\'s own profile, credential only', async () => {
    const fresh = join(root, 'fresh');
    const kept = join(root, 'kept');
    const at = (profile: string) => ({ root: profile, environment: { HOME: profile, X_HOME: profile } });
    const x = harness({ authFiles: [
      { path: '${X_HOME}/auth.json' },
      { path: '${X_HOME}/.env', contains: 'X_API_KEY', removeLine: true },
      { path: '~/.x/credentials.json', jsonFields: ['oauth.accessToken'] },
      { path: '~/.x/tokens/' },
    ] });
    await mkdir(join(fresh, '.x', 'tokens'), { recursive: true });
    await mkdir(join(kept, '.x'), { recursive: true });
    await writeFile(join(fresh, 'auth.json'), 'new-token');
    await writeFile(join(fresh, '.env'), 'X_API_KEY=new\n');
    await writeFile(join(fresh, '.x', 'credentials.json'), JSON.stringify({ oauth: { accessToken: 'new' }, fresh: true }));
    await writeFile(join(fresh, '.x', 'tokens', 'a'), 'new');
    // The account's own profile: an old credential beside things that are not one.
    await writeFile(join(kept, 'auth.json'), 'expired');
    await writeFile(join(kept, '.env'), 'EDITOR=vim\nX_API_KEY=old\n');
    await writeFile(join(kept, '.x', 'credentials.json'), JSON.stringify({ oauth: { accessToken: 'old' }, mcpOAuth: { server: 'kept' } }));
    await writeFile(join(kept, 'history.jsonl'), 'chats');

    expect(await adoptAuthFiles(x, at(fresh), at(kept), {})).toBe(true);
    expect(await readFile(join(kept, 'auth.json'), 'utf8')).toBe('new-token');
    expect(await readFile(join(kept, '.env'), 'utf8')).toBe('EDITOR=vim\nX_API_KEY=new\n');
    expect(JSON.parse(await readFile(join(kept, '.x', 'credentials.json'), 'utf8'))).toEqual({ oauth: { accessToken: 'new' }, mcpOAuth: { server: 'kept' } });
    expect(await readFile(join(kept, '.x', 'tokens', 'a'), 'utf8')).toBe('new');
    expect(await readFile(join(kept, 'history.jsonl'), 'utf8')).toBe('chats');
  });

  it('carries nothing, and says so, when the sign-in left no credential or left it outside its profile', async () => {
    const fresh = join(root, 'fresh');
    const kept = join(root, 'kept');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(fresh, { recursive: true });
    await mkdir(kept, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(kept, 'auth.json'), 'expired');
    await writeFile(join(elsewhere, 'auth.json'), 'not-this-profile');
    const x = harness({ authFiles: [{ path: '${X_HOME}/auth.json' }] });
    expect(await adoptAuthFiles(x, { root: fresh, environment: { X_HOME: fresh } }, { root: kept, environment: { X_HOME: kept } }, {})).toBe(false);
    expect(await adoptAuthFiles(x, { root: fresh, environment: { X_HOME: elsewhere } }, { root: kept, environment: { X_HOME: kept } }, {})).toBe(false);
    expect(await adoptAuthFiles(harness({}), { root: fresh, environment: {} }, { root: kept, environment: {} }, {})).toBe(false);
    expect(await readFile(join(kept, 'auth.json'), 'utf8')).toBe('expired');
  });

  it('requires complete, parseable Antigravity credentials before reporting signed in', async () => {
    const agy = AI_LOCAL_HARNESSES.find((entry) => entry.command === 'antigravity')!;
    const directory = join(root, '.gemini', 'antigravity-cli');
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'antigravity-oauth-token');
    const valid = JSON.stringify({ token: { access_token: 'access', refresh_token: 'refresh' } });
    for (const invalid of [valid + 'trailing data', '{', '{}', '{"token":{}}', '{"token":{"access_token":"access"}}']) {
      await writeFile(file, invalid);
      expect(await authEvidencePresent(agy, { HOME: root }, {})).toBe(false);
    }
    await writeFile(file, valid);
    expect(await authEvidencePresent(agy, { HOME: root }, {})).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(valid);
  });

  it('preserves corrupt credentials before explicit reauthentication and leaves valid credentials alone', async () => {
    const vendor = harness({ authFiles: [{ path: '~/auth.json', jsonFields: ['token.access_token'] }] });
    const file = join(root, 'auth.json');
    const corrupt = '{"token":{"access_token":"old"}}trailing bytes';
    await writeFile(file, corrupt);
    expect(await authEvidencePresent(vendor, { HOME: root }, {})).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(corrupt);
    await prepareAuthFilesForLogin(vendor, { HOME: root }, {});
    const [backup] = await readdir(root);
    expect(backup).toMatch(/^auth.json\.invalid-.*\.bak$/);
    expect(await readFile(join(root, backup!), 'utf8')).toBe(corrupt);
    await prepareAuthFilesForLogin(vendor, { HOME: root }, {});
    const valid = '{"token":{"access_token":"new"}}';
    await writeFile(file, valid);
    await prepareAuthFilesForLogin(vendor, { HOME: root }, {});
    expect(await readFile(file, 'utf8')).toBe(valid);
    expect(await readdir(root)).toHaveLength(2);
  });

  it('Claude is signed in by its own OAuth tokens, never by the MCP servers\' OAuth kept in the same file', async () => {
    const claude = AI_LOCAL_HARNESSES.find((entry) => entry.command === 'claude')!;
    const environment = { CLAUDE_CONFIG_DIR: root };
    const file = join(root, '.credentials.json');
    const mcpOnly = (token: string) => JSON.stringify({ mcpOAuth: { 'stripe|x': { accessToken: token } } });
    await writeFile(file, mcpOnly('m1'));
    expect(await authEvidencePresent(claude, environment, {})).toBe(false);
    // Signed out with MCP servers connected: the file is the vendor's, never set aside.
    await prepareAuthFilesForLogin(claude, environment, {});
    expect(await readFile(file, 'utf8')).toBe(mcpOnly('m1'));
    const signedIn = (access: string, mcp: string) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: 'r', expiresAt: 1 }, mcpOAuth: { 'stripe|x': { accessToken: mcp } } });
    await writeFile(file, signedIn('a1', 'm1'));
    expect(await authEvidencePresent(claude, environment, {})).toBe(true);
    const before = await authFilesStamp(claude, environment, {});
    // An MCP server's token refreshed: not a sign-in.
    await writeFile(file, signedIn('a1', 'm2'));
    expect(await authFilesStamp(claude, environment, {})).toBe(before);
    await writeFile(file, signedIn('a2', 'm2'));
    expect(await authFilesStamp(claude, environment, {})).not.toBe(before);
  });

  it('a credential file rewritten with the same content is not a new credential', async () => {
    const vendor = harness({ authFiles: [{ path: '~/auth.json' }] });
    const file = join(root, 'auth.json');
    await writeFile(file, '{"token":"t"}');
    const before = await authFilesStamp(vendor, { HOME: root }, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(file, '{"token":"t"}');
    expect(await authFilesStamp(vendor, { HOME: root }, {})).toBe(before);
    await writeFile(file, '{"token":"u"}');
    expect(await authFilesStamp(vendor, { HOME: root }, {})).not.toBe(before);
  });

  it('expands ~ and ${VAR:-default} against the profile environment', () => {
    expect(expandAuthPath('~/.grok/auth.json', {}, '/home/u')).toBe('/home/u/.grok/auth.json');
    expect(expandAuthPath('${GEMINI_CLI_HOME:-~}/.gemini/oauth_creds.json', {}, '/home/u')).toBe('/home/u/.gemini/oauth_creds.json');
    expect(expandAuthPath('${GEMINI_CLI_HOME:-~}/.gemini/oauth_creds.json', { GEMINI_CLI_HOME: '/profiles/g1' }, '/home/u'))
      .toBe('/profiles/g1/.gemini/oauth_creds.json');
    expect(expandAuthPath('${QWEN_HOME:-~/.qwen}/settings.json', { QWEN_HOME: '  ' }, '/home/u')).toBe('/home/u/.qwen/settings.json');
    expect(expandAuthPath('~/.cline/data/settings/providers.json', { HOME: '/profiles/cline' }, '/home/u'))
      .toBe('/profiles/cline/.cline/data/settings/providers.json');
  });

  it('reads a * segment as every entry of that directory (MiniMax Code: region and client)', async () => {
    const mcode = AI_LOCAL_HARNESSES.find((item) => item.command === 'mcode')!;
    const environment = { HOME: root };
    expect(await authEvidencePresent(mcode, environment, {})).toBe(false);
    const stampBefore = await authFilesStamp(mcode, environment, {});
    const dir = join(root, '.minimax', 'auth', 'prod', 'en', 'client-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'auth.json'), '{"records":{}}');
    expect(await authEvidencePresent(mcode, environment, {})).toBe(false);
    await writeFile(join(dir, 'auth.json'), '{"records":{"a":{"accessToken":"t","expiresAtMs":1}}}');
    expect(await authEvidencePresent(mcode, environment, {})).toBe(true);
    expect(await authFilesStamp(mcode, environment, {})).not.toBe(stampBefore);
    expect(await authEvidencePresent(mcode, { HOME: join(root, 'elsewhere') }, {})).toBe(false);
  });

  it('is signed in by a non-empty file, a file containing the key, a non-empty directory, or an API-key variable', async () => {
    const entry = { path: `${root}/creds.json` };
    const vendor = harness({ authFiles: [entry], authEnv: ['VENDOR_API_KEY'] });
    expect(await authEvidencePresent(vendor, {}, {})).toBe(false);
    await writeFile(entry.path, '');
    expect(await authEvidencePresent(vendor, {}, {})).toBe(false);
    await writeFile(entry.path, '{"token":"t"}');
    expect(await authEvidencePresent(vendor, {}, {})).toBe(true);
    expect(await authEvidencePresent(harness({ authEnv: ['VENDOR_API_KEY'] }), {}, { VENDOR_API_KEY: 'k' })).toBe(true);
    expect(await authEvidencePresent(harness({ authEnv: ['VENDOR_API_KEY'] }), {}, { VENDOR_API_KEY: ' ' })).toBe(false);

    const shared = harness({ authFiles: [{ path: `${root}/config.yaml`, contains: 'apiKey:' }] });
    await writeFile(`${root}/config.yaml`, 'models: []\n');
    expect(await authEvidencePresent(shared, {}, {})).toBe(false);
    await writeFile(`${root}/config.yaml`, 'models:\n  - apiKey: sk\n');
    expect(await authEvidencePresent(shared, {}, {})).toBe(true);

    const directory = harness({ authFiles: [{ path: `${root}/credentials/` }] });
    await mkdir(`${root}/credentials`);
    expect(await authEvidencePresent(directory, {}, {})).toBe(false);
    await writeFile(`${root}/credentials/a.json`, '{}');
    expect(await authEvidencePresent(directory, {}, {})).toBe(true);
  });

  it('checks an isolated account in its own profile directory', async () => {
    const gemini = harness({ authFiles: [{ path: '${GEMINI_CLI_HOME:-~}/.gemini/oauth_creds.json' }] });
    await mkdir(join(root, '.gemini'));
    await writeFile(join(root, '.gemini', 'oauth_creds.json'), '{"refresh_token":"r"}');
    expect(await authEvidencePresent(gemini, { GEMINI_CLI_HOME: root }, {})).toBe(true);
    expect(await authEvidencePresent(gemini, { GEMINI_CLI_HOME: join(root, 'other') }, {})).toBe(false);
  });

  it('signs out by removing whole credential files and key lines, never a shared config', async () => {
    const vendor = harness({
      authFiles: [
        { path: `${root}/auth.v2.file` },
        { path: `${root}/credentials/` },
        { path: `${root}/.env`, contains: 'MISTRAL_API_KEY=', removeLine: true },
        { path: `${root}/config.yaml`, contains: 'apiKey:' },
      ],
    });
    await writeFile(`${root}/auth.v2.file`, 'x');
    await mkdir(`${root}/credentials`);
    await writeFile(`${root}/credentials/k.json`, '{}');
    await writeFile(`${root}/.env`, 'OTHER=1\nMISTRAL_API_KEY=abc\n');
    await writeFile(`${root}/config.yaml`, 'apiKey: sk\n');
    expect(removableAuthFiles(vendor).map((entry) => entry.path)).toEqual([`${root}/auth.v2.file`, `${root}/credentials/`, `${root}/.env`]);
    expect(await removeAuthFiles(vendor, {}, {})).toEqual([`${root}/auth.v2.file`, `${root}/credentials/`, `${root}/.env`]);
    expect(await readFile(`${root}/.env`, 'utf8')).toBe('OTHER=1\n');
    expect(await readFile(`${root}/config.yaml`, 'utf8')).toBe('apiKey: sk\n');
    expect(await authEvidencePresent(harness({ authFiles: vendor.authFiles!.slice(0, 3) }), {}, {})).toBe(false);
  });

  it('can log out with a logout command or removable files only', () => {
    expect(harnessCanLogout(harness({ logoutArgv: ['logout'] }))).toBe(true);
    expect(harnessCanLogout(harness({ authFiles: [{ path: '~/.grok/auth.json' }] }))).toBe(true);
    expect(harnessCanLogout(harness({ authFiles: [{ path: '~/.continue/config.yaml', contains: 'apiKey:' }] }))).toBe(false);
    expect(harnessCanLogout(harness({}))).toBe(false);
  });

  it("Copilot is signed in while its config lists a logged-in user (copilot 1.0.88 has no status command)", async () => {
    const copilot = AI_LOCAL_HARNESSES.find((entry) => entry.command === 'copilot')!;
    expect(copilot.statusArgv).toBeUndefined();
    const write = (users: string) => writeFile(join(root, 'config.json'), `// User settings belong in settings.json.\n// This file is managed automatically.\n{\n  "firstLaunchAt": "2026-09-22T15:11:02.952Z",\n  "lastLoggedInUser": {\n    "host": "https://github.com",\n    "login": "someone"\n  },\n  "loggedInUsers": ${users}\n}\n`);
    await write('[\n    {\n      "host": "https://github.com",\n      "login": "someone"\n    }\n  ]');
    expect(await authEvidencePresent(copilot, { COPILOT_HOME: root }, {})).toBe(true);
    await write('[]');
    expect(await authEvidencePresent(copilot, { COPILOT_HOME: root }, {})).toBe(false);
    expect(removableAuthFiles(copilot)).toEqual([]);
  });
});
