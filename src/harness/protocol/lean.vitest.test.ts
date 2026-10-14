import { describe, expect, it } from 'vitest';
import { callOutcomeParts, costShownInline, endLineShown, endLineUsageShown, failedOutputTail } from './lean.js';

describe('lean thresholds', () => {
  it('ends on a line only for a long turn or a turn that changed files', () => {
    expect(endLineShown(9_999, 0)).toBe(false);
    expect(endLineShown(10_000, 0)).toBe(true);
    expect(endLineShown(1_000, 1)).toBe(true);
  });
  it('carries usage only for 20k tokens or $0.05', () => {
    expect(endLineUsageShown(undefined)).toBe(false);
    expect(endLineUsageShown({ input: 15_000, output: 4_999 })).toBe(false);
    expect(endLineUsageShown({ input: 15_000, output: 5_000 })).toBe(true);
    expect(endLineUsageShown({ input: 10, costUsd: 0.049 })).toBe(false);
    expect(endLineUsageShown({ input: 10, costUsd: 0.05 })).toBe(true);
    expect(costShownInline(0.04)).toBe(false);
    expect(costShownInline(0.05)).toBe(true);
    expect(costShownInline(undefined)).toBe(false);
  });
  it('shows exit only when non-zero and duration from 5s', () => {
    const words = (ms: number): string => `${ms / 1000}s`;
    expect(callOutcomeParts(0, 4_999, words)).toEqual([]);
    expect(callOutcomeParts(undefined, undefined, words)).toEqual([]);
    expect(callOutcomeParts(1, 300, words)).toEqual(['exit 1']);
    expect(callOutcomeParts(1, 2_000, words)).toEqual(['exit 1', '2s']);
    expect(callOutcomeParts(0, 5_000, words)).toEqual(['5s']);
  });
  it('keeps the last three lines of a failed call', () => {
    expect(failedOutputTail('a\nb\nc\nd\ne\n\n')).toEqual(['c', 'd', 'e']);
    expect(failedOutputTail('only')).toEqual(['only']);
    expect(failedOutputTail(undefined)).toEqual([]);
  });
});
