import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { addDestination, destinationProblem, loadDestinations, normalizeSendTo, removeDestination, sendToDestinations, slotsOf } from './secret-destinations.js';
import { forgetSecrets, registerSecret } from './secret-scrubber.js';
import { lockCredentialVault, saveNamedSecret } from './credential-vault.js';

const VALUE = 'salad_live_9f8e7d6c5b4a39281706';
let dir = '';
let bin = '';
const oldPath = process.env.PATH;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-dest-')); bin = join(dir, 'bin'); await mkdir(bin); process.env.PATH = `${bin}:${oldPath}`; registerSecret(VALUE); });
afterEach(async () => { process.env.PATH = oldPath; forgetSecrets(); lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); });
const fake = async (name: string, script: string): Promise<void> => { await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`); await chmod(join(bin, name), 0o755); };

it('ships a few destinations as plain data, each naming the slots the agent fills', async () => {
  const all = await loadDestinations(dir);
  expect(Object.keys(all)).toEqual(['clikdeploy-secret', 'clikdeploy-app-secret', 'clikdeploy-compute', 'clikdeploy-connector', 'clikdeploy-connection', 'clikdeploy-connection-basic', 'github-secret']);
  expect(slotsOf(all['clikdeploy-secret']!)).toEqual(['key']);
  expect(slotsOf(all['clikdeploy-compute']!)).toEqual(['provider', 'field']);
  expect(slotsOf(all['clikdeploy-connector']!)).toEqual(['integration', 'client_id']);
  expect(slotsOf(all['clikdeploy-connection']!)).toEqual(['integration']);
  expect(slotsOf(all['clikdeploy-connection-basic']!)).toEqual(['integration', 'username']);
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
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; cat > "${dir}/stdin"; echo '{"status":"success","message":"saved ${VALUE}","data":{"appliedToWebProcess":true}}'`);
  const json = '{"type":"service_account","private_key":"-----BEGIN KEY-----\\nabc\\n-----END KEY-----"}';
  const [result] = await sendToDestinations(dir, [{ to: 'clikdeploy-compute', with: { provider: 'GCP', field: 'serviceAccountJson' } }], json);
  expect(result).toMatchObject({ ok: true, label: 'clikdeploy-compute (GCP, serviceAccountJson)' });
  expect(result!.message).toContain('appliedToWebProcess=true');
  expect(result!.message).not.toContain(VALUE);
  const argv = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(argv.slice(0, 3)).toEqual(['tools', 'run', 'admin_compute_save_credentials']);
  expect(argv[argv.indexOf('--args-json') + 1]).toBe('-');
  expect(argv.join(' ')).not.toContain(json);
  const sent = JSON.parse(await readFile(join(dir, 'stdin'), 'utf8')) as { provider: string; credentials: Record<string, string> };
  expect(sent).toEqual({ provider: 'GCP', credentials: { serviceAccountJson: json } });
});

it('registers a connector\'s OAuth app: the client id from the agent, the secret JSON-escaped, no code or password asked', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; cat > "${dir}/stdin"; echo '{"status":"success","data":{"success":true,"data":{"applied":true}}}'`);
  const secret = 'GOCSPX-a"b\\c_d-0123456789';
  const [result] = await sendToDestinations(dir, [{ to: 'clikdeploy-connector', with: { integration: 'googlesheets', client_id: '1234-abc.apps.googleusercontent.com' } }], secret);
  expect(result).toMatchObject({ ok: true, label: 'clikdeploy-connector (googlesheets, 1234-abc.apps.googleusercontent.com)' });
  const argv = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(argv.slice(0, 3)).toEqual(['tools', 'run', 'admin_platform_save_connector_credentials']);
  expect(argv).toContain('--confirm');
  expect(argv.some(arg => /password|totp/i.test(arg))).toBe(false);
  expect(argv[argv.indexOf('--args-json') + 1]).toBe('-');
  expect(argv.join(' ')).not.toContain(secret);
  expect(JSON.parse(await readFile(join(dir, 'stdin'), 'utf8'))).toEqual({ integrationId: 'googlesheets', clientId: '1234-abc.apps.googleusercontent.com', clientSecret: secret });
  // A slot that is not a plain id is refused before anything runs.
  expect(await destinationProblem(dir, [{ to: 'clikdeploy-connector', with: { integration: 'googlesheets', client_id: '--evil' } }])).toContain('needs with.client_id');
  expect(await destinationProblem(dir, [{ to: 'clikdeploy-connector', with: { integration: 'googlesheets' } }])).toContain('needs with.client_id');
});

it('a client id the agent never saw: client_id may name a saved secret, read from the vault only when it is sent', async () => {
  await saveNamedSecret(dir, 'google/connectors-client-id', '1234567890-abcdefghij.apps.googleusercontent.com');
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; cat > "${dir}/stdin"; echo '{}'`);
  const plan = [{ to: 'clikdeploy-connector', with: { integration: 'googlesheets', client_id: 'secret:google/connectors-client-id' } }];
  expect(await destinationProblem(dir, plan)).toBeUndefined();
  const [result] = await sendToDestinations(dir, plan, 'GOCSPX-clientsecret0123456789abcd');
  expect(result).toMatchObject({ ok: true, label: 'clikdeploy-connector (googlesheets, secret:google/connectors-client-id)' });
  const argv = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(argv[argv.indexOf('--args-json') + 1]).toBe('-');
  expect(JSON.parse(await readFile(join(dir, 'stdin'), 'utf8'))).toEqual({ integrationId: 'googlesheets', clientId: '1234567890-abcdefghij.apps.googleusercontent.com', clientSecret: 'GOCSPX-clientsecret0123456789abcd' });
  // A name that is not saved is refused before anything runs, and a slot that is not a vault slot never reads one.
  expect(await destinationProblem(dir, [{ to: 'clikdeploy-connector', with: { integration: 'googlesheets', client_id: 'secret:no/such' } }])).toContain('not in the Secrets Manager');
  // Any other slot takes "secret:..." as the plain text it is: the vault is never read for it.
  await sendToDestinations(dir, [{ to: 'clikdeploy-secret', with: { key: 'secret:google/connectors-client-id' } }], 'a-value');
  const other = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(other[other.indexOf('--args-json') + 1]).toBe('-');
  const sent = JSON.parse(await readFile(join(dir, 'stdin'), 'utf8')) as { key: string; value: string };
  expect(sent).toEqual({ key: 'secret:google/connectors-client-id', value: 'a-value' });
  expect(JSON.stringify(sent)).not.toContain('apps.googleusercontent.com');
});

it('reads a key containing {{...}} text as plain text, not as a slot', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; cat > "${dir}/stdin"; echo '{}'`);
  await sendToDestinations(dir, [{ to: 'clikdeploy-secret', with: { key: 'MY_KEY' } }], 'abc{{key}}def');
  const argv = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(argv[argv.indexOf('--args-json') + 1]).toBe('-');
  expect(JSON.parse(await readFile(join(dir, 'stdin'), 'utf8'))).toEqual({ key: 'MY_KEY', value: 'abc{{key}}def' });
});

it('connects a vendor key through ClikDeploy without putting it in process arguments', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; cat > "${dir}/stdin"; echo '{}'`);
  const [result] = await sendToDestinations(dir, [{ to: 'clikdeploy-connection', with: { integration: 'acme' } }], VALUE);
  expect(result).toMatchObject({ ok: true });
  const argv = await readFile(join(dir, 'argv'), 'utf8');
  expect(argv).toContain('connect_connector');
  expect(argv).not.toContain(VALUE);
  expect(JSON.parse(await readFile(join(dir, 'stdin'), 'utf8'))).toEqual({ integrationId: 'acme', apiKey: VALUE });
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

it('reads a plan a harness handed over as JSON text, because its cached schema did not know the argument', () => {
  expect(normalizeSendTo('{"to":"clikdeploy-compute","with":{"provider":"GCP","field":"serviceAccountJson"}}')).toEqual([{ to: 'clikdeploy-compute', with: { provider: 'GCP', field: 'serviceAccountJson' } }]);
  expect(normalizeSendTo('[{"to":"github-secret","with":{"repo":"a/b","key":"K_KEY"}}]')).toHaveLength(1);
  expect(normalizeSendTo('clikdeploy-secret')).toEqual([{ to: 'clikdeploy-secret' }]);
  expect(normalizeSendTo('{broken')).toBeUndefined();
});

it('connects a vendor key as a ClikDeploy connection through the product\'s own connect capability, the key JSON-escaped and never in a flag', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; cat > "${dir}/stdin"; echo '{"status":"success","data":{"success":true,"data":{"status":"active"}}}'`);
  const secret = 'ab"c\\d_0123456789';
  const [result] = await sendToDestinations(dir, [{ to: 'clikdeploy-connection', with: { integration: 'ipinfo' } }], secret);
  expect(result).toMatchObject({ ok: true, label: 'clikdeploy-connection (ipinfo)' });
  const argv = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(argv.slice(0, 3)).toEqual(['tools', 'run', 'connect_connector']);
  expect(argv[argv.indexOf('--args-json') + 1]).toBe('-');
  expect(argv.join(' ')).not.toContain(secret);
  expect(JSON.parse(await readFile(join(dir, 'stdin'), 'utf8'))).toEqual({ integrationId: 'ipinfo', apiKey: secret });
});

it('a username the vendor hides from the browser (Mux\'s token id): the basic-auth username may name a saved secret, read from the vault only when sent', async () => {
  await saveNamedSecret(dir, 'mux/token-id', '3f2a9c1e-token-id-uuid');
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; cat > "${dir}/stdin"; echo '{}'`);
  const plan = [{ to: 'clikdeploy-connection-basic', with: { integration: 'mux', username: 'secret:mux/token-id' } }];
  expect(await destinationProblem(dir, plan)).toBeUndefined();
  const [result] = await sendToDestinations(dir, plan, 'the-token-secret-0123456789');
  expect(result).toMatchObject({ ok: true });
  const argv = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(argv[argv.indexOf('--args-json') + 1]).toBe('-');
  expect(argv.join(' ')).not.toContain('the-token-secret-0123456789');
  expect(JSON.parse(await readFile(join(dir, 'stdin'), 'utf8'))).toEqual({ integrationId: 'mux', username: '3f2a9c1e-token-id-uuid', password: 'the-token-secret-0123456789' });
  // A plain username still goes through as written, and a name that is not saved is refused before anything runs.
  await sendToDestinations(dir, [{ to: 'clikdeploy-connection-basic', with: { integration: 'upstash', username: 'me@example.com' } }], 'k-0123456789abcdef');
  const plain = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(plain[plain.indexOf('--args-json') + 1]).toBe('-');
  expect(JSON.parse(await readFile(join(dir, 'stdin'), 'utf8'))).toMatchObject({ username: 'me@example.com' });
  expect(await destinationProblem(dir, [{ to: 'clikdeploy-connection-basic', with: { integration: 'mux', username: 'secret:no/such' } }])).toContain('not in the Secrets Manager');
});
