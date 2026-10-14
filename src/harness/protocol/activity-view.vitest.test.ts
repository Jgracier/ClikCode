import { describe, expect, it } from 'vitest';
import { agentProgress } from './activity-view.js';

describe('agentProgress', () => {
  it('always carries the elapsed time, and the rest when known', () => {
    expect(agentProgress({ elapsedMs: 80_000 })).toBe('1m 20s');
    expect(agentProgress({ latest: 'reading a.ts', tools: 12, tokens: 12_300, elapsedMs: 5_000 })).toBe('reading a.ts · 12 tool uses · 12k tokens · 5s');
  });
});
