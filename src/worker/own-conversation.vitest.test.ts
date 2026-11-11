import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { backgroundSignature, ownConversation } from './session-worker.js';

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

describe('the worker record\'s background work', () => {
  it('is rewritten when what runs changes, not when a command\'s cpu or output time moves', () => {
    const command = { pid: 7, label: 'pnpm test', startedAt: 1, cpuPercent: 3, lastOutputAt: 10 };
    const before = backgroundSignature({ terminals: 1, commands: [command] });
    expect(backgroundSignature({ terminals: 1, commands: [{ ...command, cpuPercent: 97, lastOutputAt: 20 }] })).toBe(before);
    expect(backgroundSignature({ terminals: 1, commands: [{ ...command, stale: true } as never] })).not.toBe(before);
    expect(backgroundSignature({ terminals: 2, commands: [command, { ...command, pid: 8 }] })).not.toBe(before);
  });
});
