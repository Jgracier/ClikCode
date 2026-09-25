import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authEvidencePresent, expandAuthPath, harnessCanLogout, removableAuthFiles, removeAuthFiles } from './auth-files';
import type { AiLocalHarnessDefinition } from '../definition';

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
});
