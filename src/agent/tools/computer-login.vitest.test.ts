import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../tool-contract.js';
import { lockCredentialVault } from '../computer/credential-vault.js';

const browser = vi.hoisted(() => {
  const filled: string[] = [];
  const page = {
    url: () => 'https://accounts.google.com/v3/signin/identifier',
    locator: (selector: string) => ({
      count: async () => selector.includes('password') || selector.includes('email') ? 1 : 0,
      fill: async (value: string) => { filled.push(value); },
      press: async (key: string) => { filled.push(key); },
    }),
    getByRole: () => ({ count: async () => 0 }),
  };
  return { filled, page };
});
vi.mock('../computer/browser.js', () => ({ computerPage: async () => browser.page }));
vi.mock('../computer/settings.js', () => ({ computerEnabled: async () => true }));

import { computerWebTool } from './computer-web.js';

let stateDir = '';
afterEach(async () => {
  if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; }
  browser.filled.length = 0;
});

it('prompts in the client, saves and submits the login without returning credentials to the model', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-'));
  const secret = { accountId: '', email: 'private@example.com', password: 'private-secret' };
  const result = await computerWebTool.run({ action: 'login' }, {
    stateDir, requestPrivateLogin: async () => secret,
  } as ToolContext);
  expect(result.isError).toBeUndefined();
  expect(browser.filled).toEqual([secret.email, secret.password, 'Enter']);
  expect(JSON.stringify(result)).not.toContain(secret.email);
  expect(JSON.stringify(result)).not.toContain(secret.password);
  const items = await readdir(join(stateDir, 'computer', 'vault', 'items'));
  const encrypted = await readFile(join(stateDir, 'computer', 'vault', 'items', items[0]), 'utf8');
  expect(encrypted).not.toContain(secret.email);
  expect(encrypted).not.toContain(secret.password);
});

it('does not fall back to a phone credential link when no private client UI is attached', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-headless-'));
  const result = await computerWebTool.run({ action: 'login' }, { stateDir } as ToolContext);
  expect(result.isError).toBe(true);
  expect(result.output).toContain('Private login did not finish');
  expect(result.output).not.toContain('https://jgracier.github.io');
});
