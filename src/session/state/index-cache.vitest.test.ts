import { describe, expect, it } from 'vitest';
import type { StateIndex } from './index-file.js';
import { indexWriteIsCache } from './write.js';

const index = (sessions: StateIndex['sessions']): StateIndex => ({
  version: 1, installationId: 'i', accounts: [], sessions, invocations: [], invocationRollups: {},
  globalSettings: {} as StateIndex['globalSettings'], providerSettings: {},
});

describe('which index writes can skip fsync', () => {
  const row = { id: 'chat', updatedAt: 't0', model: 'a' } as StateIndex['sessions'][number];

  it('treats a newer timestamp or last usage as a cache write', () => {
    const disk = index([row]);
    expect(indexWriteIsCache(disk, index([{ ...row, updatedAt: 't1' }]))).toBe(true);
    expect(indexWriteIsCache(disk, index([{ ...row, lastUsage: { at: 't1' } as never }]))).toBe(true);
  });

  it('keeps a model change, a new chat, and a reorder durable', () => {
    const disk = index([row, { ...row, id: 'other' }]);
    expect(indexWriteIsCache(disk, index([{ ...row, model: 'b' }]))).toBe(false);
    expect(indexWriteIsCache(disk, index([{ ...row, id: 'other' }, row]))).toBe(false);
    expect(indexWriteIsCache(disk, index([row, { ...row, id: 'third' }]))).toBe(false);
  });
});
