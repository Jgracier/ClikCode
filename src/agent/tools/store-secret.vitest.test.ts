import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { lockCredentialVault, saveNamedSecret } from '../computer/credential-vault.js';
import { forgetSecrets } from '../computer/secret-scrubber.js';
import type { ToolContext } from '../tool-contract.js';
import { storeSecretTool } from './store-secret.js';

const VALUE = 'salad_live_9f8e7d6c5b4a39281706';
let dir = '';
let bin = '';
const oldPath = process.env.PATH;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-store-'));
  bin = join(dir, 'bin');
  await import('node:fs/promises').then(fs => fs.mkdir(bin));
  process.env.PATH = `${bin}:${oldPath}`;
  await saveNamedSecret(dir, 'salad/api-key', VALUE);
});
afterEach(async () => { process.env.PATH = oldPath; forgetSecrets(); lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); });

async function fakeCli(script: string): Promise<void> {
  await writeFile(join(bin, 'clikdeploy'), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, 'clikdeploy'), 0o755);
}
const ctx = (): ToolContext => ({ stateDir: dir } as ToolContext);

it('hands the value to the CLI, and neither the result nor an echoing CLI shows it', async () => {
  await fakeCli(`printf '%s\\n' "$@" > "${dir}/argv"; echo '{"status":"success","message":"stored '"$4"'","data":{"appliedToWebProcess":true}}'`);
  const result = await storeSecretTool.run({ secret: 'salad/api-key', destination: 'clikdeploy', key: 'SALAD_API_KEY' }, ctx());
  expect(result.isError).toBeUndefined();
  expect(result.output).toContain('Stored "salad/api-key" in ClikDeploy as SALAD_API_KEY');
  expect(result.output).toContain('appliedToWebProcess=true');
  expect(result.output).not.toContain(VALUE);
  const argv = await readFile(join(dir, 'argv'), 'utf8');
  expect(argv).toContain('admin_platform_set_secret');
  expect(argv).toContain('"key":"SALAD_API_KEY"');
  expect(argv).toContain(VALUE);
  expect(argv).toContain('--confirm');
});

it('sets an app secret when an app is named', async () => {
  await fakeCli(`printf '%s\\n' "$@" > "${dir}/argv"; echo '{"status":"success"}'`);
  await storeSecretTool.run({ secret: 'salad/api-key', destination: 'clikdeploy', key: 'SALAD_API_KEY', app: 'app_1' }, ctx());
  const argv = await readFile(join(dir, 'argv'), 'utf8');
  expect(argv).toContain('set_secret');
  expect(argv).not.toContain('admin_platform_set_secret');
  expect(argv).toContain('"appId":"app_1"');
});

it('reports a failure without the value, even when the CLI prints it', async () => {
  await fakeCli(`echo '{"status":"error","message":"rejected '"$(printf '%s' "$4" | cut -c1-0)"'bad value ${VALUE}"}'; exit 2`);
  const result = await storeSecretTool.run({ secret: 'salad/api-key', destination: 'clikdeploy', key: 'SALAD_API_KEY' }, ctx());
  expect(result.isError).toBe(true);
  expect(result.output).toContain('did not store');
  expect(result.output).not.toContain(VALUE);
});

it('refuses an unknown secret, a lower-case destination key, and a missing CLI', async () => {
  expect((await storeSecretTool.run({ secret: 'nope', destination: 'clikdeploy', key: 'X_KEY' }, ctx())).output).toContain('No secret named');
  expect((await storeSecretTool.run({ secret: 'salad/api-key', destination: 'clikdeploy', key: 'lower' }, ctx())).output).toContain('upper-case');
  process.env.PATH = bin;
  const result = await storeSecretTool.run({ secret: 'salad/api-key', destination: 'clikdeploy', key: 'SALAD_API_KEY' }, ctx());
  expect(result.output).toContain('not installed');
});
