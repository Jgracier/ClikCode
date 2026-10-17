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
const SALAD = { secret: 'salad/api-key', send_to: [{ type: 'clikdeploy', tool: 'admin_platform_set_secret', args: { key: 'SALAD_API_KEY', value: '{{secret}}' } }] } as const;

it('sends a saved secret by the plan and relays what the destination says, never the value', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; echo '{"status":"success","message":"stored ${VALUE}","data":{"appliedToWebProcess":true}}'`);
  const result = await storeSecretTool.run(SALAD as never, ctx());
  expect(result.isError).toBeUndefined();
  expect(result.output).toContain('Sent - ClikDeploy admin_platform_set_secret');
  expect(result.output).toContain('appliedToWebProcess=true');
  expect(result.output).not.toContain(VALUE);
  const argv = await readFile(join(dir, 'argv'), 'utf8');
  expect(argv).toContain('admin_platform_set_secret');
  expect(argv).toContain(VALUE);
});

it('can send one saved secret to several places, saying which failed', async () => {
  await fake('clikdeploy', `echo '{"status":"error","message":"step-up required"}'; exit 2`);
  await fake('gh', 'cat > /dev/null');
  const result = await storeSecretTool.run({ secret: 'salad/api-key', send_to: [...SALAD.send_to, { type: 'github', repo: 'Jgracier/app', name: 'SALAD_API_KEY' }] } as never, ctx());
  expect(result.isError).toBe(true);
  expect(result.output).toContain('FAILED - ClikDeploy admin_platform_set_secret: step-up required');
  expect(result.output).toContain('Sent - GitHub Jgracier/app SALAD_API_KEY');
});

it('refuses an unsound plan, an unknown secret and a missing CLI', async () => {
  expect((await storeSecretTool.run({ secret: 'salad/api-key', send_to: [{ type: 'clikdeploy', tool: 'admin_platform_set_secret', args: { value: 'literal' } }] } as never, ctx())).output).toContain('{{secret}}');
  expect((await storeSecretTool.run({ ...SALAD, secret: 'nope' } as never, ctx())).output).toContain('No secret named');
  process.env.PATH = bin;
  expect((await storeSecretTool.run(SALAD as never, ctx())).output).toContain('not installed');
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
