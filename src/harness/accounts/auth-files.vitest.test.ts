import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authEvidencePresent, authFilesStamp, expandAuthPath, harnessCanLogout, removableAuthFiles, removeAuthFiles } from './auth-files';
import type { AiLocalHarnessDefinition } from '../definition';
import { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';

const harness = (fields: Partial<AiLocalHarnessDefinition>): AiLocalHarnessDefinition => ({
  command: 'x', provider: 'x', displayName: 'X', surface: 'terminal', localAuth: ['vendor-cli'], binary: 'x', ...fields,
});

describe('vendor credential files', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'auth-files-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

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
