import { describe, expect, it } from 'vitest';
import { quotaRefusalHolds } from './usage-reading.js';
import type { AiHarnessAccount } from '../definition.js';

const now = Date.parse('2026-10-17T23:52:00.000Z');
const refused = (windows: Array<{ name: string; usedPct: number; resetsAt?: string; advisory?: boolean }>, readAt = '2026-10-17T23:51:33.927Z') => ({
  id: 'a', status: 'ready', quotaState: 'exhausted', quotaExhaustedAt: '2026-10-17T23:50:54.217Z', quotaRetryAt: '2026-10-18T01:50:00.000Z',
  usage: { at: readAt, windows },
}) as unknown as AiHarnessAccount;

describe('a quota refusal and a later usage reading', () => {
  it('holds when the later reading still has a window spent', () => {
    expect(quotaRefusalHolds(refused([{ name: '5h', usedPct: 100, resetsAt: '2026-10-18T01:49:00.000Z' }, { name: 'weekly', usedPct: 82 }]), now)).toBe(true);
  });
  it('is overruled by a later reading with room in every window', () => {
    expect(quotaRefusalHolds(refused([{ name: '5h', usedPct: 4 }, { name: 'weekly', usedPct: 82 }]), now)).toBe(false);
  });
  it('holds against a reading from before it', () => {
    expect(quotaRefusalHolds(refused([{ name: '5h', usedPct: 4 }], '2026-10-17T23:40:00.000Z'), now)).toBe(true);
  });
  it('is not answered by advisory windows alone', () => {
    expect(quotaRefusalHolds(refused([{ name: 'pool', usedPct: 3, advisory: true }]), now)).toBe(true);
  });
});
