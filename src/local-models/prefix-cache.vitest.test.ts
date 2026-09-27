/** The saved system+tools prefix, against a stand-in llama-server that keeps
 * slots and files the way the real one does. */
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrefixCache } from './prefix-cache.js';

interface FakeSlot { id: number; tokens?: number[]; used: boolean }

/** Renders "<sys>system|tools</sys><user>text</user>" and tokenizes one token
 * per character, so a shared prefix is exactly the shared text. */
function fakeServer(options: { saveStatus?: number } = {}) {
  const slots: FakeSlot[] = [{ id: 0, used: false }, { id: 1, used: false }];
  const files = new Map<string, number[]>();
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url!, 'http://x');
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      const send = (status: number, json: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (url.pathname === '/apply-template') {
        const [system, user] = body.messages;
        return send(200, { prompt: `<sys>${system.content}|${JSON.stringify(body.tools ?? [])}</sys><user>${user.content}</user>` });
      }
      if (url.pathname === '/tokenize') return send(200, { tokens: [...(body.content as string)].map((char) => char.charCodeAt(0)) });
      if (url.pathname === '/slots' && req.method === 'GET') return send(200, slots.map((slot) => ({ id: slot.id, is_processing: false, ...(slot.used ? { id_task: 7 } : {}) })));
      const slotMatch = url.pathname.match(/^\/slots\/(\d+)$/);
      if (slotMatch) {
        const slot = slots[Number(slotMatch[1])]!;
        if (url.searchParams.get('action') === 'save') {
          if (options.saveStatus) return send(options.saveStatus, { error: 'no slot-save-path' });
          files.set(body.filename, slot.tokens ?? []);
          writeFileSync(path.join(dir, body.filename), 'state');
          return send(200, { n_saved: slot.tokens?.length ?? 0 });
        }
        if (url.searchParams.get('action') === 'restore') {
          const saved = files.get(body.filename);
          if (!saved) return send(400, { error: 'missing' });
          slot.tokens = saved;
          return send(200, { n_restored: saved.length });
        }
      }
      if (url.pathname === '/completion') {
        const slot = slots[body.id_slot ?? 1]!;
        slot.tokens = body.prompt; slot.used = true;
        return send(200, { id_slot: slot.id, timings: { prompt_n: body.prompt.length } });
      }
      send(404, {});
    });
  });
  return { server, slots, files, calls };
}

let dir: string;
let fake: ReturnType<typeof fakeServer>;
let port: number;

const system = `You are ClikCode. ${'Rules. '.repeat(300)}`;
const request = (user: string) => ({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], tools: [{ type: 'function', function: { name: 'read_file' } }] });

async function listen(options?: { saveStatus?: number }): Promise<void> {
  fake = fakeServer(options);
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  port = (fake.server.address() as AddressInfo).port;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prefix-cache-'));
});

afterEach(async () => {
  fake.server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('prefix cache', () => {
  it('reads the prefix once into an unused slot and saves exactly that', async () => {
    await listen();
    const cache = new PrefixCache(port, dir);
    await cache.prepare(request('Fix the bug'));
    const [file] = [...fake.files.keys()];
    expect(file).toMatch(/^[0-9a-f]{32}\.bin$/);
    const saved = String.fromCharCode(...fake.files.get(file!)!);
    expect(saved.startsWith('<sys>You are ClikCode.')).toBe(true);
    expect(saved).not.toContain('Fix the bug');
    expect(saved).not.toContain('Alpha');
    // A later request with the same prefix is not read again.
    await cache.prepare(request('Something else'));
    expect(fake.calls.filter((call) => call === 'POST /completion')).toHaveLength(1);
  });

  it('restores a saved prefix into a fresh server instead of reading it', async () => {
    await listen();
    await new PrefixCache(port, dir).prepare(request('first run'));
    const [file] = [...fake.files.keys()];
    const tokens = fake.files.get(file!)!;
    fake.server.close();

    await listen();
    fake.files.set(file!, tokens);
    await new PrefixCache(port, dir).prepare(request('second run'));
    expect(fake.calls).toContain('POST /slots/0?action=restore');
    expect(fake.calls).not.toContain('POST /completion');
    expect(fake.slots[0]!.tokens).toEqual(tokens);
  });

  it('never restores into a slot a conversation has used', async () => {
    await listen();
    await new PrefixCache(port, dir).prepare(request('first run'));
    for (const slot of fake.slots) slot.used = true;
    fake.calls.length = 0;
    await new PrefixCache(port, dir).prepare(request('joined later'));
    expect(fake.calls.some((call) => call.includes('action=restore'))).toBe(false);
    expect(fake.calls.some((call) => call.includes('action=save'))).toBe(false);
  });

  it('leaves short prompts and requests without a system prompt alone', async () => {
    await listen();
    const cache = new PrefixCache(port, dir);
    await cache.prepare({ messages: [{ role: 'system', content: 'Summarize.' }, { role: 'user', content: 'x' }] });
    await cache.prepare({ messages: [{ role: 'user', content: 'x' }] });
    expect(fake.calls.filter((call) => call.startsWith('POST /completion') || call.includes('action='))).toEqual([]);
  });

  it('stops trying on a server started without a save path', async () => {
    await listen({ saveStatus: 501 });
    const cache = new PrefixCache(port, dir);
    await cache.prepare(request('one'));
    fake.calls.length = 0;
    await cache.prepare({ ...request('two'), tools: [] });
    expect(fake.calls).toEqual([]);
  });

  it('keeps the newest few saved prefixes', async () => {
    await listen();
    for (let i = 0; i < 6; i++) await fs.writeFile(path.join(dir, `old${i}.bin`), 'x').then(() => fs.utimes(path.join(dir, `old${i}.bin`), i + 1, i + 1));
    await new PrefixCache(port, dir).prepare(request('go'));
    const left = (await fs.readdir(dir)).sort();
    expect(left).toHaveLength(4);
    expect(left).not.toContain('old0.bin');
  });
});
