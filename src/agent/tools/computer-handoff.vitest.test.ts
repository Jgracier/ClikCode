import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ screenshot: vi.fn(async () => Buffer.from('jpeg')), page: {} as Record<string, unknown> }));
mock.page = { screenshot: mock.screenshot, mouse: { click: vi.fn(), wheel: vi.fn() }, keyboard: { insertText: vi.fn(), press: vi.fn() } };
vi.mock('../computer/browser.js', () => ({ computerPage: async () => mock.page }));
vi.mock('../computer/settings.js', () => ({ computerEnabled: async () => true }));
vi.mock('../models/for-session.js', () => ({ gatewayConnection: () => ({ baseUrl: 'https://gateway.example', apiKey: 'test-key' }) }));
vi.mock('../images.js', () => ({ sniffImage: () => ({ width: 800, height: 600 }) }));
vi.mock('node:timers/promises', () => ({ setTimeout: async () => undefined }));

import { computerHandoffTool } from './computer-handoff.js';
import { encryptPacket } from '../computer/handoff-crypto.js';
import type { ToolContext } from '../tool-contract.js';

it('shows one phone link, sends an encrypted frame, and resumes when Done arrives', async () => {
  const seen: { url: string; method: string; body?: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL, options?: RequestInit) => {
    seen.push({ url: String(url), method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) as unknown : undefined });
    const data = String(url).endsWith('/computer') ? { id: 'A'.repeat(32), expiresAt: Date.now() + 60_000 }
      : String(url).endsWith('/action') ? { status: 'done', packet: null } : { accepted: true };
    return { ok: true, json: async () => ({ success: true, data }) } as Response;
  }) as typeof fetch;
  try {
    const output: string[] = [];
    const result = await computerHandoffTool.run({}, { stateDir: '/tmp/clikcode-test', emitOutput: (text) => output.push(text) } as ToolContext);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('Continue the task');
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/https:\/\/gateway\.example\/computer\/handoff\/A{32}#key=[A-Za-z0-9_-]{43}/);
    expect(seen.map((entry) => entry.method)).toEqual(['POST', 'POST', 'GET', 'DELETE']);
    const frame = seen[1].body as { iv: string; data: string; seq: number; width: number; height: number };
    expect(frame).toMatchObject({ seq: 1, width: 800, height: 600 });
    expect(frame.data).not.toContain('jpeg');
  } finally { globalThis.fetch = original; }
});

it('applies a phone tap to the already open browser and then resumes', async () => {
  const original = globalThis.fetch;
  let secret = '';
  let polls = 0;
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    let data: unknown = { accepted: true };
    if (String(url).endsWith('/computer')) data = { id: 'B'.repeat(32), expiresAt: Date.now() + 60_000 };
    if (String(url).endsWith('/action')) {
      data = ++polls === 1
        ? { status: 'active', packet: encryptPacket(Buffer.from(secret, 'base64url'), 'B'.repeat(32), 'action', 1,
          Buffer.from(JSON.stringify({ kind: 'click', x: 100, y: 200 }))) }
        : { status: 'done', packet: null };
    }
    return { ok: true, json: async () => ({ success: true, data }) } as Response;
  }) as typeof fetch;
  try {
    mock.page.mouse && vi.mocked((mock.page.mouse as { click: () => void }).click).mockClear();
    const result = await computerHandoffTool.run({}, { stateDir: '/tmp/clikcode-test', emitOutput: (text) => {
      secret = new URL(text.trim().split(' ').at(-1)!).hash.slice(5);
    } } as ToolContext);
    expect(result.isError).toBeUndefined();
    expect((mock.page.mouse as { click: ReturnType<typeof vi.fn> }).click).toHaveBeenCalledWith(100, 200);
  } finally { globalThis.fetch = original; }
});
