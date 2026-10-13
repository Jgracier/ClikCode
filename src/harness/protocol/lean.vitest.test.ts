import { describe, expect, it } from 'vitest';
import { callOutcome, costShownInline, endLineShown, endLineUsageShown, failedOutputTail, usageIsLow } from './lean.js';

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
    expect(callOutcome(0, 4_999)).toBeUndefined();
    expect(callOutcome(undefined, undefined)).toBeUndefined();
    expect(callOutcome(1, 1_000)).toBe('(exit 1)');
    expect(callOutcome(0, 5_000)).toBe('(5s)');
    expect(callOutcome(2, 65_000)).toBe('(exit 2 · 1m 5s)');
  });
  it('puts usage in the footer only when low or spent', () => {
    expect(usageIsLow(42, false)).toBe(false);
    expect(usageIsLow(25, false)).toBe(true);
    expect(usageIsLow(undefined, true)).toBe(true);
    expect(usageIsLow(undefined, false)).toBe(false);
  });
  it('keeps the last three lines of a failed call', () => {
    expect(failedOutputTail('a\nb\nc\nd\ne\n\n')).toEqual(['c', 'd', 'e']);
    expect(failedOutputTail('only')).toEqual(['only']);
    expect(failedOutputTail(undefined)).toEqual([]);
  });
});
