import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../tool-contract.js';
import { lockCredentialVault } from '../computer/credential-vault.js';

const browser = vi.hoisted(() => {
  const filled: string[] = [];
  let step = 0;
  const field = (type: string, name: string, label: string) => ({
    type, name, id: name, autocomplete: type === 'password' ? 'current-password' : 'username', required: true, placeholder: '', labels: [],
    getAttribute: (attribute: string) => attribute === 'aria-label' ? label : null,
  });
  const page = {
    url: () => 'https://accounts.google.com/v3/signin/identifier',
    locator: (selector: string) => ({
      count: async () => selector.includes('password') ? step : 1,
      evaluateAll: async (callback: (nodes: unknown[]) => unknown) => callback([step ? field('password', 'password', 'Password') : field('text', 'identifier', 'Email or phone')]),
      nth: () => ({ fill: async (value: string) => { filled.push(value); }, press: async (key: string) => { filled.push(key); step++; } }),
      fill: async (value: string) => { filled.push(value); },
      press: async (key: string) => { filled.push(key); },
    }),
    getByRole: () => ({ count: async () => 0 }),
  };
  return { filled, page, reset: () => { step = 0; } };
});
vi.mock('../computer/browser.js', () => ({ computerPage: async () => browser.page }));
vi.mock('../computer/settings.js', () => ({ computerEnabled: async () => true }));

import { computerWebTool } from './computer-web.js';

let stateDir = '';
afterEach(async () => {
  if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; }
  browser.filled.length = 0;
  browser.reset();
});

it('asks for only Gmail’s visible field at each step without returning credentials to the model', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-'));
  const asked: string[][] = [];
  const ctx = {
    stateDir, requestPrivateLogin: async (_site: string, fields: { key: string }[]) => {
      asked.push(fields.map(field => field.key));
      return fields[0].key === 'password' ? { password: 'private-secret' } : { username: 'private@example.com' };
    },
  } as ToolContext;
  const first = await computerWebTool.run({ action: 'login' }, ctx);
  const result = await computerWebTool.run({ action: 'login' }, ctx);
  expect(first.isError).toBeUndefined();
  expect(result.isError).toBeUndefined();
  expect(asked).toEqual([['username'], ['password']]);
  expect(browser.filled).toEqual(['private@example.com', 'Enter', 'private-secret', 'Enter']);
  expect(JSON.stringify([first, result])).not.toContain('private@example.com');
  expect(JSON.stringify([first, result])).not.toContain('private-secret');
  const items = await readdir(join(stateDir, 'computer', 'vault', 'items'));
  expect(items).toHaveLength(1);
  const encrypted = await readFile(join(stateDir, 'computer', 'vault', 'items', items[0]), 'utf8');
  expect(encrypted).not.toContain('private@example.com');
  expect(encrypted).not.toContain('private-secret');
  browser.reset();
  await computerWebTool.run({ action: 'login' }, ctx);
  await computerWebTool.run({ action: 'login' }, ctx);
  expect(asked).toEqual([['username'], ['password']]);
});

it('does not fall back to a phone credential link when no private client UI is attached', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-private-login-headless-'));
  const result = await computerWebTool.run({ action: 'login' }, { stateDir } as ToolContext);
  expect(result.isError).toBe(true);
  expect(result.output).toContain('Private login did not finish');
  expect(result.output).not.toContain('https://jgracier.github.io');
});
