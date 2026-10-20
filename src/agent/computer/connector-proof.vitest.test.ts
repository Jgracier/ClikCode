import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { lockCredentialVault } from './credential-vault.js';
import { parseConnectorProof, syncConnectorProof } from './connector-proof.js';

let dir = '';
const oldPath = process.env.PATH;
afterEach(async () => { process.env.PATH = oldPath; if (dir) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); dir = ''; } });

it('accepts only ClikDeploy’s proof envelope for the requested connector', () => {
  const body = JSON.stringify({ status: 'success', data: { success: true, data: { id: 'acme', ready: true, specVersion: 'v-1', testsDigest: 't-1', coverage: { total: 1, passing: 1 }, problems: [] } } });
  expect(parseConnectorProof(body, 'acme').ready).toBe(true);
  expect(() => parseConnectorProof(body, 'other')).toThrow('invalid proof verdict');
});

it('uses the remote verdict to mark a local proof task done, without receiving credentials', async () => {
  dir = await mkdtemp(join(tmpdir(), 'proof-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const script = join(bin, 'clikdeploy');
  await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\nprintf '%s\\n' '{"status":"success","data":{"success":true,"data":{"id":"acme","ready":true,"specVersion":"v-1","testsDigest":"t-1","coverage":{"total":2,"passing":2},"problems":[]}}}'`);
  await chmod(script, 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  const { proof, task } = await syncConnectorProof(dir, 'acme');
  expect(proof.ready).toBe(true);
  expect(task).toMatchObject({ vendor: 'acme', kind: 'connector-proof', status: 'done' });
  expect(await readFile(join(dir, 'argv'), 'utf8')).toContain('connector_proof');
});

it('keeps ClikDeploy\'s next step as the note on an unfinished connector, and tolerates an older ClikDeploy without a checklist', async () => {
  dir = await mkdtemp(join(tmpdir(), 'proof-'));
  const bin = join(dir, 'bin'); await mkdir(bin);
  const verdict = (extra: object) => JSON.stringify({ status: 'success', data: { success: true, data: { id: 'acme', ready: false, specVersion: 'v-1', testsDigest: 't-1', coverage: null, problems: ['connector.logo: add a logo'], ...extra } } });
  await writeFile(join(bin, 'clikdeploy'), `#!/bin/sh\ncat <<'EOF'\n${verdict({ done: ['Name'], missing: [{ area: 'identity', item: 'connector.logo', fix: 'add a logo' }], next: 'connector.logo: add a logo' })}\nEOF\n`);
  await chmod(join(bin, 'clikdeploy'), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  const { task } = await syncConnectorProof(dir, 'acme');
  expect(task).toMatchObject({ status: 'queued', note: 'connector.logo: add a logo' });
  await writeFile(join(bin, 'clikdeploy'), `#!/bin/sh\ncat <<'EOF'\n${verdict({})}\nEOF\n`);
  expect((await syncConnectorProof(dir, 'acme')).task.note).toBe('connector.logo: add a logo');
});

