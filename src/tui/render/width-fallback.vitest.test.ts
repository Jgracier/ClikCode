import { describe, expect, it } from 'vitest';
import { fallbackSegmenter } from './width.js';

const split = (text: string) => [...fallbackSegmenter.segment(text)].map((s) => s.segment);
const real = (text: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);

describe('grapheme segmenting without Intl.Segmenter (the phone app: Hermes has none)', () => {
  // The phone's chat crashed the moment a tool ran: the shared chat client drew the tool's row through visibleSlice, which built an
  // Intl.Segmenter, and Hermes has no such constructor.
  it.each([
    ['plain text', 'deploy the api'],
    ['a combining accent', 'café, café'],
    ['a skin-tone modifier', 'hi 👋🏽 there'],
    ['a variation selector', 'ok ❤️ done'],
    ['a ZWJ family', 'a 👨‍👩‍👧 b'],
    ['a flag (two regional indicators), and two flags in a row', 'go 🇺🇸🇨🇦 now'],
    ['a tag sequence (subdivision flag)', '🏴󠁧󠁢󠁳󠁣󠁴󠁿!'],
    ['CJK', '部署する'],
  ])('%s: the same clusters as the real segmenter', (_name, text) => {
    expect(split(text)).toEqual(real(text));
  });

  it('reports where each cluster starts, as Intl.Segmenter does', () => {
    expect([...fallbackSegmenter.segment('a👋🏽b')].map((s) => s.index)).toEqual([0, 1, 5]);
  });
});

describe('the width functions on an engine without Intl.Segmenter', () => {
  it('cut a tool row to width instead of throwing (what crashed the phone app)', async () => {
    const { vi } = await import('vitest');
    const saved = Intl.Segmenter;
    vi.resetModules();
    // @ts-expect-error -- Hermes: no Intl.Segmenter at all
    delete Intl.Segmenter;
    try {
      const { visibleSlice, terminalCellWidth } = await import('./width.js');
      const row = 'clikdeploy_list_deployments {"appId":"marketing-site","limit":20} 👋🏽 部署';
      const cut = visibleSlice(row, 24);
      expect(terminalCellWidth(cut)).toBeLessThanOrEqual(24);
      expect(cut.endsWith('…')).toBe(true);
      expect(terminalCellWidth('部署')).toBe(4);
    } finally {
      Intl.Segmenter = saved;
      vi.resetModules();
    }
  });
});
