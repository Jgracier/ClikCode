import { describe, expect, it } from 'vitest';
import { agentProgress, agentSpinnerGlyph } from './activity-view.js';

describe('agentProgress', () => {
  it('always carries the elapsed time, and the rest when known', () => {
    expect(agentProgress({ elapsedMs: 80_000 })).toBe('1m 20s');
    expect(agentProgress({ latest: 'reading a.ts', tools: 12, tokens: 12_300, elapsedMs: 5_000 })).toBe('reading a.ts · 12 tool uses · 12k tokens · 5s');
  });
});

describe('agentSpinnerGlyph', () => {
  it('is two braille cells that circle the edge and never repeat within a lap', () => {
    const lap = Array.from({ length: 12 }, (_, frame) => agentSpinnerGlyph(frame));
    for (const glyph of lap) expect(glyph).toMatch(/^[\u2800-\u28ff]{2}$/u);
    expect(new Set(lap).size).toBeGreaterThan(8);
  });
});
