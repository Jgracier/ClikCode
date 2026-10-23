import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ownConversation } from './session-worker.js';

const held = (kind: string, host = 'h') => async () => ({ holder: { kind, pid: 42, host, nonce: 'n', at: 'now' } }) as never;

describe('ownConversation', () => {
  it('fails clearly instead of waiting for ever on a conversation another process holds', async () => {
    await expect(ownConversation('s1', 300, held('command'))).rejects.toThrow(/still held by a command \(pid 42\)/);
  });
  it('returns the hold when it is free, and nothing when another worker has it', async () => {
    const hold = { release: async () => undefined };
    expect(await ownConversation('s1', 300, (async () => ({ hold })) as never)).toBe(hold);
    expect(await ownConversation('s1', 300, held('worker', hostname()))).toBeUndefined();
  });
  it('waits for a worker on another machine to hand the conversation over', async () => {
    await expect(ownConversation('s1', 300, held('worker'))).rejects.toThrow(/still held by a worker/);
  });
});
