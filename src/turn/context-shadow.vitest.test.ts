import { describe, expect, it } from 'vitest';
import { addToTally, emptyTally, noteShadowReading, noteVendorCompaction, tokensWithoutTune, turnWasCut, vendorDefaultTrigger, type ContextShadow } from './context-shadow.js';

describe('context shadow', () => {
  it('places the vendor default near the top of the window', () => {
    expect(vendorDefaultTrigger(200_000, true)).toBe(167_000);
    expect(vendorDefaultTrigger(40_000, true)).toBe(20_000);
    expect(vendorDefaultTrigger(400_000, false)).toBe(360_000);
    expect(vendorDefaultTrigger(undefined, false)).toBeUndefined();
  });

  it('carries what a vendor compaction removed, reading its first boundary as the summary', () => {
    const shadow: ContextShadow = { removed: 0 };
    expect(noteShadowReading(shadow, 90_000, undefined, 360_000)).toBe(90_000);
    expect(noteShadowReading(shadow, 100_000, undefined, 360_000)).toBe(100_000);
    // Compaction: the boundary reports the summary (8k), then the context rises.
    expect(noteShadowReading(shadow, 8_000, 'c1', 360_000)).toBe(100_000);
    expect(noteShadowReading(shadow, 12_000, 'c1', 360_000)).toBe(12_000 + 92_000);
    expect(shadow.pending).toBeUndefined();
    expect(noteShadowReading(shadow, 30_000, 'c1', 360_000)).toBe(122_000);
  });

  it("counts ClikCode's own compaction from its first reading, erring toward less saved", () => {
    const shadow: ContextShadow = { removed: 0 };
    noteShadowReading(shadow, 100_000, undefined, 360_000);
    expect(noteShadowReading(shadow, 15_000, 'c1', 360_000)).toBe(100_000);
    expect(noteShadowReading(shadow, 20_000, 'c1', 360_000)).toBe(105_000);
  });

  it('meets the real context again where the vendor would have compacted too', () => {
    const shadow: ContextShadow = { removed: 0 };
    noteShadowReading(shadow, 100_000, undefined, 150_000);
    noteShadowReading(shadow, 10_000, 'c1', 150_000);
    noteShadowReading(shadow, 20_000, 'c1', 150_000);
    expect(shadow.removed).toBe(90_000);
    // 70k + 90k passes 150k: the baseline compacts here.
    expect(noteShadowReading(shadow, 70_000, 'c1', 150_000)).toBe(70_000);
    expect(shadow.removed).toBe(0);
  });

  it('claims nothing without a window', () => {
    const shadow: ContextShadow = { removed: 0 };
    noteShadowReading(shadow, 100_000, undefined, undefined);
    expect(noteShadowReading(shadow, 10_000, 'c1', undefined)).toBe(10_000);
  });

  it('adds the extra context read to the turn tokens', () => {
    const tally = emptyTally();
    addToTally(tally, 10_000, 100_000);
    addToTally(tally, 12_000, 102_000);
    expect(tally).toEqual({ calls: 2, contextSum: 22_000, shadowSum: 202_000 });
    expect(tokensWithoutTune(25_000, tally)).toBe(205_000);
    expect(tokensWithoutTune(25_000, {})).toBe(25_000);
  });

  it('counts a turn as cut when a call read less, even once the shadow has met the vendor again', () => {
    const shadow: ContextShadow = { removed: 0 };
    const tally = emptyTally();
    const trigger = 100_000;
    addToTally(tally, 90_000, noteShadowReading(shadow, 90_000, undefined, trigger));
    addToTally(tally, 20_000, noteShadowReading(shadow, 20_000, 'c1', trigger));
    addToTally(tally, 40_000, noteShadowReading(shadow, 40_000, 'c1', trigger));
    // 40k + 70k removed passes the trigger: the sides meet, and the shadow keeps nothing removed.
    expect(shadow.removed).toBe(0);
    expect(turnWasCut(tally)).toBe(true);
    expect(turnWasCut({ calls: 1, contextSum: 5, shadowSum: 5 })).toBe(false);
  });

  it('counts a mid-turn compaction below the default as cut, though the next reading rose past the last', () => {
    // Sonnet, audit run 2026-11-24: 43.9k, three Reads, the boundary at 81.6k, then 100.5k.
    const shadow: ContextShadow = { removed: 0 };
    const tally = emptyTally();
    const trigger = 167_000;
    addToTally(tally, 43_900, noteShadowReading(shadow, 43_900, undefined, trigger));
    noteVendorCompaction(tally, shadow, trigger);
    addToTally(tally, 100_500, noteShadowReading(shadow, 100_500, 'c1', trigger));
    expect(tally.shadowSum).toBe(tally.contextSum);
    expect(turnWasCut(tally)).toBe(true);
  });

  it('does not count a compaction at the vendor default as cut', () => {
    const shadow: ContextShadow = { removed: 0, last: 172_700 };
    const tally = emptyTally();
    noteVendorCompaction(tally, shadow, 167_000);
    addToTally(tally, 30_000, noteShadowReading(shadow, 30_000, 'c1', 167_000));
    expect(turnWasCut(tally)).toBe(false);
  });
});
