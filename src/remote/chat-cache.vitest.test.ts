import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../session/model.js';
import { ChatKeeper, readChatCache, writeChatCache } from './chat-cache.js';

type Messages = NonNullable<HarnessSession['messages']>;
const said = (count: number): Messages => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index}` }) as Messages[number]);

let home: string;
const before = process.env.CLIKCODE_HOME;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cc-')); process.env.CLIKCODE_HOME = home; });
afterEach(async () => { vi.useRealTimers(); if (before === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = before; await rm(home, { recursive: true, force: true }); });

describe('a chat kept from the last time it was shown', () => {
  it('reads back what was kept for that machine and chat, with its log generation, and nothing for another', async () => {
    await writeChatCache('mac', 'c1', said(5), 'gen-1');
    expect(await readChatCache('mac', 'c1')).toEqual({ messages: said(5), gen: 'gen-1' });
    expect(await readChatCache('imac', 'c1')).toBeUndefined();
    expect(await readChatCache('mac', 'c2')).toBeUndefined();
  });

  it('reads as nothing kept when the file is damaged', async () => {
    await writeChatCache('mac', 'c1', said(2));
    const file = join(home, 'remote', 'chats', (await readdir(join(home, 'remote', 'chats')))[0]!);
    await writeFile(file, 'not gzip');
    expect(await readChatCache('mac', 'c1')).toBeUndefined();
  });

  it('keeps the newest forty chats', async () => {
    for (let index = 0; index < 42; index += 1) {
      await writeChatCache('mac', `c${index}`, said(1));
    }
    expect((await readdir(join(home, 'remote', 'chats'))).filter((name) => name.endsWith('.json.gz')).length).toBeLessThanOrEqual(40);
  });

  it('writes a burst of changes once, and what is held when it does', async () => {
    vi.useFakeTimers();
    let messages = said(1);
    const keeper = new ChatKeeper(() => 'mac', () => ({ sessionId: 'c1', messages, gen: 'g' }), 100);
    keeper.soon(); messages = said(3); keeper.soon();
    vi.useRealTimers();
    keeper.now();
    await vi.waitFor(async () => { expect((await readChatCache('mac', 'c1'))?.messages).toHaveLength(3); });
  });
});
