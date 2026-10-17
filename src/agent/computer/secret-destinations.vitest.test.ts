import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { addDestination, destinationProblem, loadDestinations, removeDestination, sendToDestinations, slotsOf } from './secret-destinations.js';
import { forgetSecrets, registerSecret } from './secret-scrubber.js';

const VALUE = 'salad_live_9f8e7d6c5b4a39281706';
let dir = '';
let bin = '';
const oldPath = process.env.PATH;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-dest-')); bin = join(dir, 'bin'); await mkdir(bin); process.env.PATH = `${bin}:${oldPath}`; registerSecret(VALUE); });
afterEach(async () => { process.env.PATH = oldPath; forgetSecrets(); await rm(dir, { recursive: true, force: true }); });
const fake = async (name: string, script: string): Promise<void> => { await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`); await chmod(join(bin, name), 0o755); };

it('ships a few destinations as plain data, each naming the slots the agent fills', async () => {
  const all = await loadDestinations(dir);
  expect(Object.keys(all)).toEqual(['clikdeploy-secret', 'clikdeploy-app-secret', 'clikdeploy-compute', 'github-secret']);
  expect(slotsOf(all['clikdeploy-secret']!)).toEqual(['key']);
  expect(slotsOf(all['clikdeploy-compute']!)).toEqual(['provider', 'field']);
  expect(slotsOf(all['github-secret']!)).toEqual(['key', 'repo']);
});

it('answers a bad plan with what to fix, including the list of destinations', async () => {
  expect(await destinationProblem(dir, [{ to: 'clikdeploy-secret', with: { key: 'SALAD_API_KEY' } }])).toBeUndefined();
  expect(await destinationProblem(dir, [{ to: 'nope' }])).toContain('Known: clikdeploy-secret(key)');
  expect(await destinationProblem(dir, [{ to: 'clikdeploy-secret' }])).toContain('needs with.key');
  expect(await destinationProblem(dir, [{ to: 'clikdeploy-secret', with: { key: '--evil' } }])).toContain('needs with.key');
  expect(await destinationProblem(dir, [{ to: 'github-secret', with: { repo: 'a/b', key: 'K"; rm' } }])).toContain('needs with.key');
  expect(await destinationProblem(dir, ['x'])).toContain('needs {to:');
});

it('fills the key in JSON-escaped, and the slots from the agent, then relays the answer without the key', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; echo '{"status":"success","message":"saved ${VALUE}","data":{"appliedToWebProcess":true}}'`);
  const json = '{"type":"service_account","private_key":"-----BEGIN KEY-----\\nabc\\n-----END KEY-----"}';
  const [result] = await sendToDestinations(dir, [{ to: 'clikdeploy-compute', with: { provider: 'GCP', field: 'serviceAccountJson' } }], json);
  expect(result).toMatchObject({ ok: true, label: 'clikdeploy-compute (GCP, serviceAccountJson)' });
  expect(result!.message).toContain('appliedToWebProcess=true');
  expect(result!.message).not.toContain(VALUE);
  const argv = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(argv.slice(0, 3)).toEqual(['tools', 'run', 'admin_compute_save_credentials']);
  const sent = JSON.parse(argv[argv.indexOf('--args-json') + 1]!) as { provider: string; credentials: Record<string, string> };
  expect(sent).toEqual({ provider: 'GCP', credentials: { serviceAccountJson: json } });
});

it('reads a key containing {{...}} text as plain text, not as a slot', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; echo '{}'`);
  await sendToDestinations(dir, [{ to: 'clikdeploy-secret', with: { key: 'MY_KEY' } }], 'abc{{key}}def');
  const argv = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(JSON.parse(argv[argv.indexOf('--args-json') + 1]!)).toEqual({ key: 'MY_KEY', value: 'abc{{key}}def' });
});

it('sends on stdin when the destination says so, so the key is in no command line', async () => {
  await fake('gh', `printf '%s\\n' "$@" > "${dir}/gh-argv"; cat > "${dir}/gh-stdin"`);
  const [result] = await sendToDestinations(dir, [{ to: 'github-secret', with: { repo: 'Jgracier/app', key: 'SALAD_API_KEY' } }], VALUE);
  expect(result!.ok).toBe(true);
  expect(await readFile(join(dir, 'gh-stdin'), 'utf8')).toBe(VALUE);
  expect(await readFile(join(dir, 'gh-argv'), 'utf8')).not.toContain(VALUE);
});

it('lets the user add a destination in one line, and the agent can then use it by name', async () => {
  await addDestination(dir, 'my-vault', { run: ['vaultcli', 'put', '{{path}}'], stdin: '{{secret}}', about: 'my vault' });
  await fake('vaultcli', `printf '%s\\n' "$@" > "${dir}/v-argv"; cat > "${dir}/v-stdin"; echo ok`);
  expect(await destinationProblem(dir, [{ to: 'my-vault', with: { path: 'kv/salad' } }])).toBeUndefined();
  const [result] = await sendToDestinations(dir, [{ to: 'my-vault', with: { path: 'kv/salad' } }], VALUE);
  expect(result).toMatchObject({ ok: true, label: 'my-vault (kv/salad)' });
  expect(await readFile(join(dir, 'v-stdin'), 'utf8')).toBe(VALUE);
  expect(await readFile(join(dir, 'v-argv'), 'utf8')).toContain('kv/salad');
  expect(await removeDestination(dir, 'my-vault')).toBe(true);
  expect(await removeDestination(dir, 'my-vault')).toBe(false);
  expect(await destinationProblem(dir, [{ to: 'my-vault', with: { path: 'x' } }])).toContain('no destination named');
});

it('refuses to add a destination that would never carry the key, or has a bad name', async () => {
  await expect(addDestination(dir, 'no-key', { run: ['echo', 'hi'] })).rejects.toThrow('{{secret}}');
  await expect(addDestination(dir, 'Bad Name', { run: ['echo', '{{secret}}'] })).rejects.toThrow('lower-case');
  await expect(addDestination(dir, 'empty', { run: [] })).rejects.toThrow('command');
});

it('keeps going after a destination fails, says which failed and why, and says when the program is missing', async () => {
  await fake('clikdeploy', `echo '{"status":"error","message":"step-up required"}'; exit 2`);
  process.env.PATH = bin; // only the fake: no gh on this path
  const results = await sendToDestinations(dir, [{ to: 'clikdeploy-secret', with: { key: 'K_KEY' } }, { to: 'github-secret', with: { repo: 'a/b', key: 'X_KEY' } }], VALUE);
  expect(results[0]).toMatchObject({ ok: false });
  expect(results[0]!.message).toContain('step-up required');
  expect(results[1]!.message).toContain('not installed');
});
