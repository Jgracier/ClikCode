import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  await mkdir(bin);
  process.env.PATH = `${bin}:${oldPath}`;
  await saveNamedSecret(dir, 'salad/api-key', VALUE, { url: 'https://salad.com' });
});
afterEach(async () => { process.env.PATH = oldPath; forgetSecrets(); lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); });
const fake = async (name: string, script: string): Promise<void> => { await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`); await chmod(join(bin, name), 0o755); };
const ctx = (): ToolContext => ({ stateDir: dir } as ToolContext);
const SALAD = { secret: 'salad/api-key', send_to: [{ to: 'clikdeploy-secret', with: { key: 'SALAD_API_KEY' } }] } as never;

it('sends a saved secret by name and relays what the destination says, never the value', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; echo '{"status":"success","message":"stored ${VALUE}","data":{"appliedToWebProcess":true}}'`);
  const result = await storeSecretTool.run(SALAD, ctx());
  expect(result.isError).toBeUndefined();
  expect(result.output).toContain('SENT - clikdeploy-secret (SALAD_API_KEY)');
  expect(result.output).toContain('appliedToWebProcess=true');
  expect(result.output).not.toContain(VALUE);
  expect(await readFile(join(dir, 'argv'), 'utf8')).toContain(VALUE);
});

it('says NOT SENT with the reason when a destination fails', async () => {
  await fake('clikdeploy', `echo '{"status":"error","message":"step-up required"}'; exit 2`);
  const result = await storeSecretTool.run(SALAD, ctx());
  expect(result.isError).toBe(true);
  expect(result.output).toContain('NOT SENT - clikdeploy-secret (SALAD_API_KEY): step-up required');
});

it('refuses an unknown destination, an unknown secret and a missing program, each with its real reason', async () => {
  expect((await storeSecretTool.run({ secret: 'salad/api-key', send_to: [{ to: 'nowhere' }] } as never, ctx())).output).toContain('no destination named "nowhere"');
  expect((await storeSecretTool.run({ ...(SALAD as object), secret: 'nope' } as never, ctx())).output).toContain('No secret named');
  process.env.PATH = bin;
  expect((await storeSecretTool.run(SALAD, ctx())).output).toContain('not installed');
});

it('takes the one-destination call in its simplest shape, and a list, an object or a bare name', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" >> "${dir}/argv"; echo '{"status":"success","message":"ok"}'`);
  const forms = [
    { secret: 'salad/api-key', to: 'clikdeploy-secret', with: { key: 'SALAD_API_KEY' } },
    { secret: 'salad/api-key', send_to: { to: 'clikdeploy-secret', with: { key: 'SALAD_API_KEY' } } },
    { secret: 'salad/api-key', send_to: [{ to: 'clikdeploy-secret', with: { key: 'SALAD_API_KEY' } }] },
  ];
  for (const form of forms) expect((await storeSecretTool.run(form as never, ctx())).output).toContain('SENT - clikdeploy-secret (SALAD_API_KEY)');
  expect((await storeSecretTool.run({ secret: 'salad/api-key', send_to: 'clikdeploy-secret' } as never, ctx())).output).toContain('needs with.key');
});

it('every correction carries a working example, so one wrong call is enough to fix', async () => {
  const none = await storeSecretTool.run({ secret: 'salad/api-key' } as never, ctx());
  expect(none.output).toContain('"to":"clikdeploy-secret"');
  const unknown = await storeSecretTool.run({ secret: 'salad/api-key', to: 'clikdeploy' } as never, ctx());
  expect(unknown.output).toContain('no destination named "clikdeploy"');
  expect(unknown.output).toContain('Example: {"to":"clikdeploy-secret"');
});

it('accepts the slots as JSON text too', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" >> "${dir}/argv"; echo '{"status":"success","message":"ok"}'`);
  const result = await storeSecretTool.run({ secret: 'salad/api-key', to: 'clikdeploy-secret', with: '{"key":"SALAD_API_KEY"}' } as never, ctx());
  expect(result.output).toContain('SENT - clikdeploy-secret (SALAD_API_KEY)');
});
