import { describe, expect, it } from 'vitest';
import { ownConversation } from './session-worker.js';

const held = (kind: string) => async () => ({ holder: { kind, pid: 42, host: 'h', nonce: 'n', at: 'now' } }) as never;

describe('ownConversation', () => {
  it('fails clearly instead of waiting for ever on a conversation another process holds', async () => {
    await expect(ownConversation('s1', 300, held('command'))).rejects.toThrow(/still held by a command \(pid 42\)/);
  });
  it('returns the hold when it is free, and nothing when another worker has it', async () => {
    const hold = { release: async () => undefined };
    expect(await ownConversation('s1', 300, (async () => ({ hold })) as never)).toBe(hold);
    expect(await ownConversation('s1', 300, held('worker'))).toBeUndefined();
  });
});
