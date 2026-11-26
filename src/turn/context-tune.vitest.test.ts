import { describe, expect, it } from 'vitest';
import { emptyCounts, type SignalCounts } from './context-signals.js';
import {
  TUNE_MIN_TURNS, TUNE_STEP, applyStep, contextThreshold, decideStep, levelBounds, noteTurnSignals, startTune, tunedLevel, tunedModels,
} from './context-tune.js';

const counts = (turns: number, add: Partial<SignalCounts> = {}): SignalCounts => ({ ...emptyCounts(), turns, ...add });
const bounds = { floor: 20_000, window: 200_000 };

describe('context auto-tune', () => {
  it('keeps the level between 100k (or the floor) and 150k (or 60% of the window)', () => {
    expect(levelBounds({ floor: 30_000, window: 400_000 })).toEqual({ floor: 100_000, ceiling: 150_000 });
    expect(levelBounds({ floor: 30_000, window: 200_000 }).ceiling).toBe(120_000);
    expect(levelBounds({ floor: 30_000, window: 100_000 })).toEqual({ floor: 100_000, ceiling: 100_000 }); // the floor wins
    expect(levelBounds({ floor: 80_000, window: 400_000 })).toEqual({ floor: 115_000, ceiling: 150_000 });
    expect(startTune({ window: 100_000 }).level).toBe(100_000);
    expect(startTune({}).level).toBe(125_000);
  });

  it('waits for enough turns in both groups', () => {
    const tune = { ...startTune(bounds), full: counts(TUNE_MIN_TURNS), cut: counts(TUNE_MIN_TURNS - 1) };
    expect(decideStep(tune, bounds)).toBeUndefined();
  });

  it('never steps "down" to a higher level when the floor sits above it', () => {
    const tall = { floor: 140_000, window: 133_000 };
    const tune = { ...startTune(bounds), level: 30_000, full: counts(20), cut: counts(20) };
    const step = decideStep(tune, tall)!;
    expect(step.to).toBe(30_000);
    expect(step.why).toMatch(/^holds: .*leaves no room below/);
    expect(applyStep(tune, step, 't1')).toBeUndefined();
    expect(tune.level).toBe(30_000);
  });

  it('steps down while cut turns read like whole ones, and up when they lose more', () => {
    const tune = { ...startTune(bounds), full: counts(40, { reReads: 4, hindsight: 10 }), cut: counts(20, { reReads: 2, hindsight: 5 }) };
    const down = decideStep(tune, bounds)!;
    expect(down.to).toBe(120_000 - TUNE_STEP);
    expect(applyStep(tune, down, 't1')).toMatchObject({ from: 120_000, to: 105_000 });
    expect(tune).toMatchObject({ level: 105_000, confirmed: 120_000, cut: emptyCounts() });
    tune.cut = counts(20, { reReads: 10, corrections: 2 });
    const up = decideStep(tune, bounds)!;
    expect(up.to).toBe(120_000);
    applyStep(tune, up, 't2');
    expect(tune.level).toBe(120_000);
    expect(tune.confirmed).toBeUndefined();
    expect(tune.log.map((change) => change.to)).toEqual([105_000, 120_000]);
  });

  it('never goes below 100k', () => {
    const tune = { ...startTune(bounds), level: 100_000, full: counts(40), cut: counts(20) };
    expect(decideStep(tune, bounds)).toMatchObject({ to: 100_000 });
  });

  it('goes up when it stops searching', () => {
    const tune = { ...startTune(bounds), full: counts(40, { reReads: 4, hindsight: 20 }), cut: counts(20, { reReads: 3, hindsight: 1 }) };
    expect(decideStep(tune, bounds)!.why).toMatch(/^up/);
  });

  it('reads the setting: auto is the tuned level, a number is itself, off is the vendor\'s', async () => {
    expect(contextThreshold({}, 'claude', 'm', bounds)).toBe(120_000);
    expect(contextThreshold({ compactAt: 150_000 }, 'claude', 'm', bounds)).toBe(150_000);
    expect(contextThreshold({ compactAt: 'off' }, 'claude', 'm', bounds)).toBeUndefined();
    for (let turn = 0; turn < TUNE_MIN_TURNS; turn += 1) {
      await noteTurnSignals('claude', 'm', counts(1), false, bounds, true);
      await noteTurnSignals('claude', 'm', counts(1), true, bounds, true);
    }
    expect(tunedLevel('claude', 'm', bounds)).toBe(105_000);
    expect(contextThreshold({}, 'claude', 'm', bounds)).toBe(105_000);
    expect(contextThreshold({}, 'claude', 'other', bounds)).toBe(120_000);
    expect(tunedModels().find((item) => item.model === 'm')!.tune.log.at(-1)!.why).toMatch(/^down/);
  });
});

describe('the auto-tune report', () => {
  it('shows each model\'s level, rates and last change, and the setting when not auto', async () => {
    const { contextTuneText } = await import('../tui/slash/usage-report.js');
    expect(contextTuneText({ globalSettings: { compactAt: 'off' } } as never)).toContain('off -- each vendor compacts');
    await noteTurnSignals('codex', 'gpt', counts(1, { reReads: 1 }), false, bounds, true);
    const text = contextTuneText({ globalSettings: {} } as never);
    expect(text).toContain('Context auto-tune (/compact auto)');
    expect(text).toContain('codex · gpt · 120k');
    expect(text).toContain('whole context: loss 1.00/turn, search 0.00/turn over 1 turns');
  });
});
