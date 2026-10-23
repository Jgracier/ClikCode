import { describe, expect, it } from 'vitest';
import { agentSpinnerGlyph, mergeActivity } from './activity-view.js';

it('keeps the vendor agent id when its completion frame omits it', () => {
  expect(mergeActivity(
    { kind: 'tool-start', id: 'call-a', label: 'Agent review', agent: true, agentId: 'task-a' },
    { kind: 'tool-done', id: 'call-a', label: 'Agent review' },
  ).agentId).toBe('task-a');
});

describe('agentSpinnerGlyph', () => {
  it('is two braille cells that circle the edge and never repeat within a lap', () => {
    const lap = Array.from({ length: 12 }, (_, frame) => agentSpinnerGlyph(frame));
    for (const glyph of lap) expect(glyph).toMatch(/^[\u2800-\u28ff]{2}$/u);
    expect(new Set(lap).size).toBeGreaterThan(8);
  });
});
