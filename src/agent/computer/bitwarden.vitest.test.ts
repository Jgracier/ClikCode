import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bitwardenReady, fillBitwardenCredential, forgetBitwardenSession, saveBitwardenCredential } from './bitwarden.js';
import type { Page } from 'playwright-core';

const originalPath = process.env.PATH;
let dir = '';
const stateDir = 'private-vault-test';
afterEach(async () => {
  process.env.PATH = originalPath;
  forgetBitwardenSession(stateDir);
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('saves through Bitwarden stdin and fills only the matching HTTPS site without returning secrets', async () => {
  dir = await mkdtemp(join(tmpdir(), 'clikcode-bw-'));
  const itemFile = join(dir, 'item.json');
  const executable = join(dir, 'bw');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'status') { process.stdout.write(JSON.stringify({status:'locked'})); process.exit(0); }
if (args[0] === 'unlock') { if (process.env.CLIKCODE_PRIVATE_BW_PASSWORD !== 'vault-only') process.exit(1); process.stdout.write('private-session'); process.exit(0); }
if (process.env.BW_SESSION !== 'private-session') process.exit(1);
if (args[0] === 'get' && args[1] === 'template') { process.stdout.write(JSON.stringify(args[2] === 'item' ? {type:1, notes:null, favorite:false, login:null} : {username:null, password:null, uris:null, totp:null})); process.exit(0); }
if (args[0] === 'create') {
  let input = ''; process.stdin.on('data', (data) => input += data);
  process.stdin.on('end', () => { const item = JSON.parse(Buffer.from(input, 'base64').toString());
    item.id = '11111111-1111-4111-8111-111111111111'; fs.writeFileSync(process.env.TEST_BW_ITEM, JSON.stringify(item));
    process.stdout.write(JSON.stringify(item)); });
} else if (args[0] === 'get') process.stdout.write(fs.readFileSync(process.env.TEST_BW_ITEM, 'utf8'));
`);
  await chmod(executable, 0o700);
  process.env.PATH = `${dir}:${originalPath}`;
  process.env.TEST_BW_ITEM = itemFile;
  await bitwardenReady();
  const secret = 'website-only-secret';
  const id = await saveBitwardenCredential(stateDir, 'https://signin.aws.amazon.com/login', {
    accountId: 'account-123', email: 'user@example.com', password: secret, vaultPassword: 'vault-only',
  });
  expect(id).toBe('11111111-1111-4111-8111-111111111111');
  const saved = JSON.parse(await readFile(itemFile, 'utf8')) as { login: { uris: Array<{ uri: string; match: number }> } };
  expect(saved.login.uris).toEqual([{ uri: 'https://signin.aws.amazon.com', match: 1 }]);
  const filled: Record<string, string> = {};
  const page = (url: string) => ({
    url: () => url,
    locator: (selector: string) => ({ count: async () => 1, fill: async (value: string) => { filled[selector] = value; } }),
    getByRole: () => ({ count: async () => 1, fill: async (value: string) => { filled.account = value; } }),
  }) as unknown as Page;
  await expect(fillBitwardenCredential(stateDir, page('https://evil.example/login'), id)).rejects.toThrow('does not match');
  expect(filled).toEqual({});
  await fillBitwardenCredential(stateDir, page('https://signin.aws.amazon.com/login'), id);
  expect(filled['input[type="password"]:visible']).toBe(secret);
  expect(filled.account).toBe('account-123');
  delete process.env.TEST_BW_ITEM;
});
