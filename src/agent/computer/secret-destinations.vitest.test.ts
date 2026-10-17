import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { describeDestinations, destinationProblem, sendToDestinations, type Destination } from './secret-destinations.js';
import { forgetSecrets, registerSecret } from './secret-scrubber.js';

const VALUE = 'salad_live_9f8e7d6c5b4a39281706';
let dir = '';
let bin = '';
const oldPath = process.env.PATH;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-dest-')); bin = join(dir, 'bin'); await mkdir(bin); process.env.PATH = `${bin}:${oldPath}`; registerSecret(VALUE); });
afterEach(async () => { process.env.PATH = oldPath; forgetSecrets(); await rm(dir, { recursive: true, force: true }); });
const fake = async (name: string, script: string): Promise<void> => { await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`); await chmod(join(bin, name), 0o755); };

const GCP: Destination = { type: 'clikdeploy', tool: 'admin_compute_save_credentials', args: { provider: 'GCP', credentials: { serviceAccountJson: '{{secret}}' } } };

it('accepts a sound plan and says what is wrong with an unsound one', () => {
  expect(destinationProblem([GCP, { type: 'github', repo: 'Jgracier/app', name: 'SALAD_API_KEY' }])).toBeUndefined();
  expect(destinationProblem([{ type: 'clikdeploy', tool: 'admin_platform_set_secret', args: { key: 'X', value: 'literal' } }])).toContain('{{secret}}');
  expect(destinationProblem([{ type: 'clikdeploy', tool: 'rm -rf /', args: { v: '{{secret}}' } }])).toContain('tool name');
  expect(destinationProblem([{ type: 'github', repo: 'nope', name: 'X_KEY' }])).toContain('owner/name');
  expect(destinationProblem([{ type: 'github', repo: 'a/b', name: 'lower' }])).toContain('upper-case');
  expect(destinationProblem([{ type: 'curl', url: 'https://evil' }])).toContain('clikdeploy or github');
  expect(destinationProblem(['x'])).toContain('object');
});

it('shows the plan with the key only as its placeholder', () => {
  const text = describeDestinations([GCP, { type: 'github', repo: 'Jgracier/app', name: 'SALAD_API_KEY' }]);
  expect(text).toContain('admin_compute_save_credentials');
  expect(text).toContain('‹the key›');
  expect(text).not.toContain('{{secret}}');
  expect(text).toContain('Jgracier/app');
});

it('fills the value in wherever the placeholder is, JSON-escaped, and relays the answer without the value', async () => {
  await fake('clikdeploy', `printf '%s\\n' "$@" > "${dir}/argv"; echo '{"status":"success","message":"saved ${VALUE}","data":{"appliedToWebProcess":true}}'`);
  const json = '{"type":"service_account","private_key":"-----BEGIN KEY-----\\nabc\\n-----END KEY-----"}';
  const [result] = await sendToDestinations([{ ...GCP, args: { provider: 'GCP', credentials: { serviceAccountJson: '{{secret}}' } } }], json);
  expect(result).toMatchObject({ ok: true, label: 'ClikDeploy admin_compute_save_credentials' });
  expect(result!.message).toContain('appliedToWebProcess=true');
  const argv = (await readFile(join(dir, 'argv'), 'utf8')).split('\n');
  expect(argv.slice(0, 3)).toEqual(['tools', 'run', 'admin_compute_save_credentials']);
  expect(argv).toContain('--confirm');
  const sent = JSON.parse(argv[argv.indexOf('--args-json') + 1]!) as { credentials: { serviceAccountJson: string } };
  expect(sent.credentials.serviceAccountJson).toBe(json);
});

it('does not echo the value when the CLI prints it', async () => {
  await fake('clikdeploy', `echo '{"status":"success","message":"stored ${VALUE}"}'`);
  const [result] = await sendToDestinations([{ type: 'clikdeploy', tool: 'admin_platform_set_secret', args: { key: 'SALAD_API_KEY', value: '{{secret}}' } }], VALUE);
  expect(result!.message).not.toContain(VALUE);
});

it('sets a GitHub secret with the value on stdin, never on the command line', async () => {
  await fake('gh', `printf '%s\\n' "$@" > "${dir}/gh-argv"; cat > "${dir}/gh-stdin"`);
  const [result] = await sendToDestinations([{ type: 'github', repo: 'Jgracier/app', name: 'SALAD_API_KEY' }], VALUE);
  expect(result!.ok).toBe(true);
  expect(await readFile(join(dir, 'gh-stdin'), 'utf8')).toBe(VALUE);
  expect(await readFile(join(dir, 'gh-argv'), 'utf8')).not.toContain(VALUE);
});

it('keeps going after a destination fails, and says which failed and why', async () => {
  await fake('clikdeploy', `echo '{"status":"error","message":"step-up required"}'; exit 2`);
  await fake('gh', 'cat > /dev/null');
  const results = await sendToDestinations([GCP, { type: 'github', repo: 'a/b', name: 'X_KEY' }], VALUE);
  expect(results.map(result => result.ok)).toEqual([false, true]);
  expect(results[0]!.message).toContain('step-up required');
});

it('says so when the CLI is not installed', async () => {
  process.env.PATH = bin;
  const [result] = await sendToDestinations([GCP], VALUE);
  expect(result).toMatchObject({ ok: false });
  expect(result!.message).toContain('not installed');
});
