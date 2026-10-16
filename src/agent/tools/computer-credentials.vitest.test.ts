import { expect, it, vi } from 'vitest';
import { encryptPacket } from '../computer/handoff-crypto.js';
import type { ToolContext } from '../tool-contract.js';

const vault = vi.hoisted(() => ({ save: vi.fn(async () => '11111111-1111-4111-8111-111111111111'), ready: vi.fn(async () => undefined), sessionReady: vi.fn(() => false), unlock: vi.fn(async () => undefined), fill: vi.fn(async () => undefined) }));
vi.mock('../computer/bitwarden.js', () => ({ bitwardenReady: vault.ready, bitwardenSessionReady: vault.sessionReady, unlockBitwarden: vault.unlock, saveBitwardenCredential: vault.save, fillBitwardenCredential: vault.fill, CredentialError: class CredentialError extends Error {} }));
vi.mock('../computer/browser.js', () => ({ computerPage: async () => ({ url: () => 'https://signin.aws.amazon.com/login?token=private' }) }));
vi.mock('../computer/settings.js', () => ({ computerEnabled: async () => true }));
vi.mock('../models/for-session.js', () => ({ gatewayConnection: () => ({ baseUrl: 'https://gateway.example', apiKey: 'test-key' }) }));

import { computerCredentialsTool } from './computer-credentials.js';

it('accepts encrypted private form data and returns only an opaque Bitwarden reference', async () => {
  const original = globalThis.fetch;
  let link = '';
  let polled = false;
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    let data: unknown = { accepted: true };
    if (String(url).endsWith('/computer')) data = { id: 'A'.repeat(32), expiresAt: Date.now() + 60_000 };
    if (String(url).endsWith('/action')) {
      if (!polled) {
        polled = true;
        const key = Buffer.from(new URL(link).hash.slice(1).split('&')[0].slice(4), 'base64url');
        data = { status: 'active', packet: encryptPacket(key, 'A'.repeat(32), 'action', 1, Buffer.from(JSON.stringify({
          kind: 'credential', accountId: 'secret-account', email: 'private@example.com', password: 'secret-password', vaultPassword: 'vault-secret',
        }))) };
      } else data = { status: 'done', packet: null };
    }
    return { ok: true, json: async () => ({ success: true, data }) } as Response;
  }) as typeof fetch;
  try {
    const result = await computerCredentialsTool.run({ action: 'request' }, {
      stateDir: '/tmp/credential-test', emitOutput: (text: string) => { link = text.trim().split(' ').at(-1)!; },
    } as ToolContext);
    expect(result.isError).toBeUndefined();
    expect(link).toContain('mode=credential');
    expect(link).toContain('site=https%3A%2F%2Fsignin.aws.amazon.com');
    expect(vault.save).toHaveBeenCalledWith('/tmp/credential-test', 'https://signin.aws.amazon.com', {
      accountId: 'secret-account', email: 'private@example.com', password: 'secret-password', vaultPassword: 'vault-secret',
    });
    for (const secret of ['secret-account', 'private@example.com', 'secret-password', 'vault-secret']) expect(result.output).not.toContain(secret);
    expect(result.output).toContain('11111111-1111-4111-8111-111111111111');
  } finally { globalThis.fetch = original; }
});

it('privately unlocks Bitwarden when filling after the worker session expired', async () => {
  const original = globalThis.fetch;
  let link = '';
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    let data: unknown = { accepted: true };
    if (String(url).endsWith('/computer')) data = { id: 'B'.repeat(32), expiresAt: Date.now() + 60_000 };
    if (String(url).endsWith('/action')) {
      const key = Buffer.from(new URL(link).hash.slice(1).split('&')[0].slice(4), 'base64url');
      data = { status: 'active', packet: encryptPacket(key, 'B'.repeat(32), 'action', 1,
        Buffer.from(JSON.stringify({ kind: 'unlock', vaultPassword: 'new-vault-secret' }))) };
    }
    return { ok: true, json: async () => ({ success: true, data }) } as Response;
  }) as typeof fetch;
  try {
    const result = await computerCredentialsTool.run({ action: 'fill', item_id: '11111111-1111-4111-8111-111111111111' }, {
      stateDir: '/tmp/credential-test', emitOutput: (text: string) => { link = text.trim().split(' ').at(-1)!; },
    } as ToolContext);
    expect(result.isError).toBeUndefined();
    expect(link).toContain('mode=unlock');
    expect(vault.unlock).toHaveBeenCalledWith('/tmp/credential-test', 'new-vault-secret');
    expect(vault.fill).toHaveBeenCalled();
    expect(result.output).not.toContain('new-vault-secret');
  } finally { globalThis.fetch = original; }
});
