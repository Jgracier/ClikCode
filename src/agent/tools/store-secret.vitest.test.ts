import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { lockCredentialVault, saveNamedSecret } from '../computer/credential-vault.js';
import { forgetSecrets } from '../computer/secret-scrubber.js';
import type { ToolContext } from '../tool-contract.js';
import { deleteSecretTool, listSecretsTool } from './manage-secrets.js';
import { storeSecretTool } from './store-secret.js';

const VALUE = 'salad_live_9f8e7d6c5b4a39281706';
let dir = '';
let bin = '';
const oldPath = process.env.PATH;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-store-'));
  bin = join(dir, 'bin');
  await mkdir(bin);
  process.env.PATH = `${bin}:${oldPath}`;
  await saveNamedSecret(dir, 'salad/api-key', VALUE);
});
afterEach(async () => { process.env.PATH = oldPath; forgetSecrets(); lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); });

async function fake(name: string, script: string): Promise<void> {
  await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, name), 0o755);
}
const ctx = (): ToolContext => ({ stateDir: dir } as ToolContext);
const SALAD = { secret: 'salad/api-key', destination: 'clikdeploy', key: 'SALAD_API_KEY' } as const;

/** A ClikDeploy CLI that records the write and answers the two read-only checks. */
function clikdeploy(options: { category?: string; stale?: boolean; healthy?: boolean; echo?: boolean } = {}): Promise<void> {
  const updated = options.stale ? '2020-01-01T00:00:00Z' : new Date().toISOString();
  return fake('clikdeploy', `
case "$3" in
  admin_platform_set_secret|set_secret) printf '%s\\n' "$@" > "${dir}/argv"; echo '{"status":"success","message":"stored${options.echo ? ' ' + VALUE : ''}","data":{"appliedToWebProcess":true}}';;
  admin_platform_secrets) echo '{"data":{"secrets":[{"key":"SALAD_API_KEY","configured":true,"updatedAt":"${updated}","category":"${options.category ?? 'compute-gpu'}"}]}}';;
  admin_compute_gpu_providers) echo '{"data":{"providers":[{"id":"salad","credentialKeys":["SALAD_API_KEY"],"health":{"healthy":${options.healthy ?? true}${options.healthy === false ? ',"error":"401"' : ''}}}]}}';;
esac`);
}

it('stores the value, then confirms it is set and the provider is healthy, never showing the value', async () => {
  await clikdeploy({ echo: true });
  const result = await storeSecretTool.run(SALAD, ctx());
  expect(result.isError).toBeUndefined();
  expect(result.output).toContain('Stored "salad/api-key" in ClikDeploy as SALAD_API_KEY');
  expect(result.output).toContain('appliedToWebProcess=true');
  expect(result.output).toContain('Confirmed set in ClikDeploy. Provider salad reports healthy');
  expect(result.output).not.toContain(VALUE);
  const argv = await readFile(join(dir, 'argv'), 'utf8');
  expect(argv).toContain('admin_platform_set_secret');
  expect(argv).toContain(VALUE);
});

it('says so plainly when the provider is unhealthy with the stored key', async () => {
  await clikdeploy({ healthy: false });
  const result = await storeSecretTool.run(SALAD, ctx());
  expect(result.output).toContain('UNHEALTHY');
  expect(result.output).toContain(': 401');
});

it('says a non-compute key is set but not tested, and warns when ClikDeploy does not show it as just set', async () => {
  await clikdeploy({ category: 'ai' });
  expect((await storeSecretTool.run(SALAD, ctx())).output).toContain('set but not tested');
  await clikdeploy({ stale: true });
  expect((await storeSecretTool.run(SALAD, ctx())).output).toContain('does not show it as just set');
});

it('sets an app secret when an app is named, without the platform checks', async () => {
  await clikdeploy();
  const result = await storeSecretTool.run({ ...SALAD, app: 'app_1' }, ctx());
  const argv = await readFile(join(dir, 'argv'), 'utf8');
  expect(argv).toContain('set_secret');
  expect(argv).not.toContain('admin_platform_set_secret');
  expect(argv).toContain('"appId":"app_1"');
  expect(result.output).not.toContain('Confirmed set');
});

it('reports a failed write without the value, even when the CLI prints it', async () => {
  await fake('clikdeploy', `echo '{"status":"error","message":"bad value ${VALUE}"}'; exit 2`);
  const result = await storeSecretTool.run(SALAD, ctx());
  expect(result.isError).toBe(true);
  expect(result.output).toContain('did not store');
  expect(result.output).not.toContain(VALUE);
});

it('sets a GitHub repository secret with the value on stdin, never on the command line', async () => {
  await fake('gh', `printf '%s\\n' "$@" > "${dir}/gh-argv"; cat > "${dir}/gh-stdin"`);
  const result = await storeSecretTool.run({ secret: 'salad/api-key', destination: 'github', key: 'SALAD_API_KEY', repo: 'Jgracier/app' }, ctx());
  expect(result.isError).toBeUndefined();
  expect(result.output).toContain('GitHub repository Jgracier/app');
  expect(await readFile(join(dir, 'gh-stdin'), 'utf8')).toBe(VALUE);
  expect(await readFile(join(dir, 'gh-argv'), 'utf8')).not.toContain(VALUE);
  expect((await storeSecretTool.run({ secret: 'salad/api-key', destination: 'github', key: 'SALAD_API_KEY' }, ctx())).output).toContain('owner/name');
});

it('refuses an unknown secret, a lower-case destination key, and a missing CLI', async () => {
  expect((await storeSecretTool.run({ ...SALAD, secret: 'nope' }, ctx())).output).toContain('No secret named');
  expect((await storeSecretTool.run({ ...SALAD, key: 'lower' }, ctx())).output).toContain('upper-case');
  process.env.PATH = bin;
  expect((await storeSecretTool.run(SALAD, ctx())).output).toContain('not installed');
});

it('lists secret names only, and deletes one by name', async () => {
  await saveNamedSecret(dir, 'runpod/api-key', 'runpod_key_0123456789');
  const listed = await listSecretsTool.run({}, ctx());
  expect(listed.output).toContain('- salad/api-key');
  expect(listed.output).toContain('- runpod/api-key');
  expect(listed.output).not.toContain(VALUE);
  expect((await deleteSecretTool.run({ name: 'salad/api-key' }, ctx())).output).toBe('Deleted secret "salad/api-key".');
  expect((await deleteSecretTool.run({ name: 'salad/api-key' }, ctx())).output).toContain('No secret named');
  expect((await listSecretsTool.run({}, ctx())).output).not.toContain('salad');
});
