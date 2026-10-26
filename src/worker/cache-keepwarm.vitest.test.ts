import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { keepsWarm, createKeepWarm, cachePingEffective, KEEP_WARM_ABOVE_TOKENS, KEEP_WARM_FOR_MS, PING_EVERY_MS, MAX_KEEP_WARM_PINGS } from './cache-keepwarm.js';
import type { HarnessSession } from '../session/model.js';

const session = (over: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's', route: 'local', provider: 'anthropic', nativeHarness: 'claude', accountId: 'a', nativeSessionId: 'n', workspace: '/w',
  model: 'opus', effort: 'medium', status: 'active', createdAt: '', updatedAt: '',
  lastUsage: { contextUsed: 700_000, at: '' }, ...over,
} as HarnessSession);

afterEach(() => { vi.useRealTimers(); });

describe('which conversations keep their cache warm', () => {
  it('stops a completed ping that rewrote the chat instead of reading its cache', () => {
    expect(cachePingEffective({ cacheRead: 13_932, cacheWrite: 147_212 }, 200_000)).toBe(false);
    expect(cachePingEffective({ cacheRead: 180_000, cacheWrite: 2_000 }, 200_000)).toBe(true);
    expect(cachePingEffective({}, 200_000)).toBe(false);
  });
  it('a large Claude conversation does; a small one, another harness, or one with no thread does not', () => {
    expect(keepsWarm(session())).toBe(true);
    expect(keepsWarm(session({ lastUsage: { contextUsed: KEEP_WARM_ABOVE_TOKENS - 1, at: '' } as never }))).toBe(false);
    expect(keepsWarm(session({ nativeHarness: 'codex', provider: 'openai' }))).toBe(false);
    expect(keepsWarm(session({ nativeSessionId: undefined }))).toBe(false);
    expect(keepsWarm(undefined)).toBe(false);
  });
});

describe('the four hours', () => {
  it('starts only after a completed Claude Code turn', async () => {
    const previous = process.env.CLIKCODE_HOME;
    const home = await mkdtemp(join(tmpdir(), 'clikcode-keepwarm-'));
    process.env.CLIKCODE_HOME = home;
    try {
      const state = await readState({ transcripts: [] });
      state.sessions.push(session({ id: 'big', messages: [{ role: 'user', content: 'hi' }] } as never));
      await writeState(state);
      const changed = vi.fn();
      const keep = createKeepWarm({ sessionId: 'big', busy: () => false, changed });
      await keep.turnEnded('grok');
      expect(keep.active()).toBe(false);
      await keep.turnEnded('claude');
      expect(keep.active()).toBe(true);
      expect(changed).toHaveBeenCalledTimes(1);
      keep.stop();
      expect(keep.active()).toBe(false);
      expect(changed).toHaveBeenCalledTimes(2);
      expect(KEEP_WARM_FOR_MS).toBe(4 * 60 * 60 * 1000);
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('makes four anchored pings, expires after four hours, and aborts a ping when stopped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    const calls: number[] = [];
    const changed = vi.fn();
    const keep = createKeepWarm({
      sessionId: 's', busy: () => false, changed,
      readSession: async () => session(),
      ping: async () => { calls.push(Date.now()); return true; },
    });
    await keep.turnEnded('claude');
    const start = Date.now();
    for (let slot = 1; slot <= MAX_KEEP_WARM_PINGS; slot++) {
      await vi.advanceTimersByTimeAsync(PING_EVERY_MS);
      expect(calls).toEqual(Array.from({ length: slot }, (_, index) => start + (index + 1) * PING_EVERY_MS));
    }
    expect(keep.active()).toBe(true);
    await vi.advanceTimersByTimeAsync(KEEP_WARM_FOR_MS - MAX_KEEP_WARM_PINGS * PING_EVERY_MS);
    expect(keep.active()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);

    let aborted = false;
    const hanging = createKeepWarm({
      sessionId: 's', busy: () => false, changed: () => undefined,
      readSession: async () => session(),
      ping: async (_id, signal) => new Promise<boolean>((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      }),
    });
    await hanging.turnEnded('claude');
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS);
    hanging.stop();
    expect(aborted).toBe(true);
  });
});
