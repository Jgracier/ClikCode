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

/** Renders "<sys>system|tools</sys><user>text</user>..." and tokenizes one
 * token per character, so a shared prefix is exactly the shared text. Like
 * Qwen's template, an assistant message after the last user message renders
 * differently ("~") from one that a later user message follows. */
function fakeServer(options: { saveStatus?: number; savedCount?: (tokens: number) => number } = {}) {
  const slots: FakeSlot[] = [{ id: 0, used: false }, { id: 1, used: false }];
  const files = new Map<string, number[]>();
  const calls: string[] = [];
  /** Tokens each /completion actually read, after what its slot held. */
  const reads: number[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url!, 'http://x');
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      const send = (status: number, json: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (url.pathname === '/apply-template') {
        const [system, ...rest] = body.messages as { role: string; content: string }[];
        const lastUser = rest.map((message) => message.role).lastIndexOf('user');
        const turns = rest.map((message, index) => `<${message.role}>${message.role === 'assistant' && index > lastUser ? '~' : ''}${message.content}</${message.role}>`);
        return send(200, { prompt: `<sys>${system!.content}|${JSON.stringify(body.tools ?? [])}</sys>${turns.join('')}` });
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
          const count = slot.tokens?.length ?? 0;
          return send(200, { n_saved: options.savedCount ? options.savedCount(count) : count });
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
        let held = 0;
        while (slot.tokens && held < slot.tokens.length && slot.tokens[held] === body.prompt[held]) held++;
        reads.push(body.prompt.length - held);
        slot.tokens = body.prompt; slot.used = true;
        return send(200, { id_slot: slot.id, timings: { prompt_n: body.prompt.length } });
      }
      send(404, {});
    });
  });
  return { server, slots, files, calls, reads };
}

let dir: string;
let fake: ReturnType<typeof fakeServer>;
let port: number;

const system = `You are ClikCode. ${'Rules. '.repeat(300)}`;
const request = (user: string, folder = '') => ({ messages: [{ role: 'system', content: `${system}${folder}` }, { role: 'user', content: user }], tools: [{ type: 'function', function: { name: 'read_file' } }] });

async function listen(options?: Parameters<typeof fakeServer>[0]): Promise<void> {
  fake = fakeServer(options);
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  port = (fake.server.address() as AddressInfo).port;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prefix-cache-'));
});

afterEach(async () => {
  savedTokens = new Map();
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
    for (let i = 0; i < 6; i++) await fs.writeFile(path.join(dir, `old${i}.bin`), 'x').then(() => fs.utimes(path.join(dir, `old${i}.bin`), Date.now() / 1000 - 100 + i, Date.now() / 1000 - 100 + i));
    await new PrefixCache(port, dir).prepare(request('go'));
    const left = (await fs.readdir(dir)).filter((name) => name.endsWith('.bin')).sort();
    expect(left).toHaveLength(4);
    expect(left).not.toContain('old0.bin');
  });

  it('saves what folders share as a layer, so a new folder reads only its own tail', async () => {
    await listen();
    await new PrefixCache(port, dir).prepare(request('go', '\nWorking directory: /a'));
    fake.server.close();

    // A second folder: no saved state is its prefix, but it shares a long run
    // with the first. That run is saved on its own on the way.
    await listen();
    await writeSaved();
    await new PrefixCache(port, dir).prepare(request('go', '\nWorking directory: /b'));
    expect(fake.calls.filter((call) => call.includes('action=save'))).toHaveLength(2);
    fake.server.close();

    // A third folder restores the layer and reads only what is its own.
    await listen();
    await writeSaved();
    await new PrefixCache(port, dir).prepare(request('go', '\nWorking directory: /c'));
    expect(fake.calls).toContain('POST /slots/0?action=restore');
    expect(fake.reads).toHaveLength(1);
    // The folder line and what this fake renders after it, of a ~2,200-token prefix.
    expect(fake.reads[0]).toBeLessThan(100);

    // And the first folder still restores its own whole prefix.
    fake.server.close();
    await listen();
    await writeSaved();
    await new PrefixCache(port, dir).prepare(request('go', '\nWorking directory: /a'));
    expect(fake.reads).toEqual([]);
  });

  describe('conversations', () => {
    const tools = [{ type: 'function', function: { name: 'read_file' } }];
    const chat = (...turns: { role: string; content: string }[]) => ({ messages: [{ role: 'system', content: system }, ...turns], tools });
    const user1 = { role: 'user', content: 'Q'.repeat(1500) };
    // Reads above 1,024 new tokens are checkpointed (15 s at 10 tokens/s is less).
    const options = { promptPerSecond: 10 };
    const conversationStates = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const name of await fs.readdir(dir)) {
        if (!name.endsWith('.tokens.json')) continue;
        const body = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as { kind: string; tokens: number[] };
        if (body.kind === 'conversation') out.push(String.fromCharCode(...body.tokens));
      }
      return out;
    };

    it('saves a long chat and a fresh server resumes from it instead of rereading', async () => {
      await listen();
      await new PrefixCache(port, dir, options).prepare(chat(user1));
      const [state] = await conversationStates();
      expect(state).toContain('Q'.repeat(1500));
      fake.server.close();

      await listen();
      await writeSaved();
      await new PrefixCache(port, dir, options).prepare(chat(user1, { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Next?' }));
      expect(fake.calls.filter((call) => call.includes('action=restore'))).toHaveLength(1);
      expect(fake.reads).toEqual([]);
      expect(String.fromCharCode(...fake.slots[0]!.tokens!)).toBe(state);
    });

    it('stops before a finished turn the template will render differently', async () => {
      await listen();
      await new PrefixCache(port, dir, options).prepare(chat(user1, { role: 'assistant', content: 'A'.repeat(1500) }));
      const [state] = await conversationStates();
      expect(state).toContain('Q'.repeat(100));
      expect(state).not.toContain('AAAA');
    });

    it('keeps only the latest point of a chat', async () => {
      await listen();
      const cache = new PrefixCache(port, dir, options);
      await cache.prepare(chat(user1));
      await cache.prepare(chat(user1, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'R'.repeat(1500) }));
      const states = await conversationStates();
      expect(states).toHaveLength(1);
      expect(states[0]).toContain('R'.repeat(100));
    });

    it('drops a save when the slot no longer held exactly this chat', async () => {
      await listen({ savedCount: (count) => count + 1 });
      await new PrefixCache(port, dir, options).prepare(chat(user1));
      expect((await fs.readdir(dir)).filter((name) => name.endsWith('.bin'))).toEqual([]);
    });

    it('bounds conversation states by bytes but keeps prefixes', async () => {
      await listen();
      await new PrefixCache(port, dir, { ...options, budgetBytes: 0 }).prepare(chat(user1));
      expect(await conversationStates()).toEqual([]);
      expect((await fs.readdir(dir)).filter((name) => name.endsWith('.bin'))).toHaveLength(1);
    });

    it('does not checkpoint a short chat', async () => {
      await listen();
      await new PrefixCache(port, dir, options).prepare(chat({ role: 'user', content: 'Fix the bug' }));
      expect(await conversationStates()).toEqual([]);
    });
  });
});

/** A fresh fake server knows nothing; the files on disk are the saved states. */
let savedTokens = new Map<string, number[]>();
async function writeSaved(): Promise<void> {
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.tokens.json')) continue;
    savedTokens.set(`${name.slice(0, -'.tokens.json'.length)}.bin`, (JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as { tokens: number[] }).tokens);
  }
  for (const [file, tokens] of savedTokens) fake.files.set(file, tokens);
}

describe('the machine-wide budget for saved states', () => {
  const previousHome = process.env.CLIKCODE_LOCAL_MODELS_HOME;
  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLIKCODE_LOCAL_MODELS_HOME;
    else process.env.CLIKCODE_LOCAL_MODELS_HOME = previousHome;
  });

  it('expires old states, then keeps the newest across every model within one budget', async () => {
    const { enforcePrefixCacheBudget } = await import('./prefix-cache');
    process.env.CLIKCODE_LOCAL_MODELS_HOME = dir;
    fake = fakeServer();
    const now = Date.now();
    const state = async (model: string, key: string, kind: 'prefix' | 'conversation', ageDays: number, bytes: number) => {
      const at = path.join(dir, 'servers', model, 'prefix-cache', 'f16');
      await fs.mkdir(at, { recursive: true });
      await fs.writeFile(path.join(at, `${key}.bin`), Buffer.alloc(bytes));
      await fs.writeFile(path.join(at, `${key}.tokens.json`), JSON.stringify({ kind, tokens: [1] }));
      const when = (now - ageDays * 86_400_000) / 1000;
      await fs.utimes(path.join(at, `${key}.bin`), when, when);
    };
    await state('a', 'a-prefix', 'prefix', 1, 100);
    await state('a', 'a-chat-new', 'conversation', 1, 300);
    await state('a', 'a-ancient', 'prefix', 20, 10);
    await state('b', 'b-prefix', 'prefix', 2, 100);
    await state('b', 'b-chat-old', 'conversation', 3, 300);
    // A model whose weights were deleted: its state ages out like any other.
    await state('gone', 'gone-prefix', 'prefix', 15, 10);
    await enforcePrefixCacheBudget({ budgetBytes: 550, now });
    const left = async (model: string) => (await fs.readdir(path.join(dir, 'servers', model, 'prefix-cache', 'f16')).catch(() => [])).filter((name) => name.endsWith('.bin')).sort();
    expect(await left('a')).toEqual(['a-chat-new.bin', 'a-prefix.bin']);
    expect(await left('b')).toEqual(['b-prefix.bin']);
    expect(await left('gone')).toEqual([]);
    // The sidecars went with their states.
    expect((await fs.readdir(path.join(dir, 'servers', 'b', 'prefix-cache', 'f16'))).sort()).toEqual(['b-prefix.bin', 'b-prefix.tokens.json']);
  });
});
