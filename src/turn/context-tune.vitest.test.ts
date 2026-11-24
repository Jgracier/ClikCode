import { describe, expect, it } from 'vitest';
import { emptyCounts, type SignalCounts } from './context-signals.js';
import {
  EVAL_BELOW, TUNE_MIN_TURNS, TUNE_STEP, applyStep, contextThreshold, decideStep, levelBounds, noteTurnSignals, recordTuneEval, startTune, tunedLevel, tunedModels,
} from './context-tune.js';

const counts = (turns: number, add: Partial<SignalCounts> = {}): SignalCounts => ({ ...emptyCounts(), turns, ...add });
const bounds = { floor: 20_000, window: 200_000 };

describe('context auto-tune', () => {
  it('keeps the level between the floor and 60% of the window', () => {
    expect(levelBounds({ floor: 30_000, window: 200_000 }).ceiling).toBe(120_000);
    expect(levelBounds({ floor: 30_000, window: 100_000 })).toEqual({ floor: 65_000, ceiling: 65_000 }); // the floor wins
    expect(startTune({ window: 100_000 }).level).toBe(60_000);
    expect(startTune({}).level).toBe(100_000);
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
    expect(down.to).toBe(100_000 - TUNE_STEP);
    expect(applyStep(tune, down, 't1')).toMatchObject({ from: 100_000, to: 85_000 });
    expect(tune).toMatchObject({ level: 85_000, confirmed: 100_000, cut: emptyCounts() });
    tune.cut = counts(20, { reReads: 10, corrections: 2 });
    const up = decideStep(tune, bounds)!;
    expect(up.to).toBe(100_000);
    applyStep(tune, up, 't2');
    expect(tune.level).toBe(100_000);
    expect(tune.confirmed).toBeUndefined();
    expect(tune.log.map((change) => change.to)).toEqual([85_000, 100_000]);
  });

  it('goes up when it stops searching', () => {
    const tune = { ...startTune(bounds), full: counts(40, { reReads: 4, hindsight: 20 }), cut: counts(20, { reReads: 3, hindsight: 1 }) };
    expect(decideStep(tune, bounds)!.why).toMatch(/^up/);
  });

  it('holds below the eval line until the graded eval passed there', () => {
    const tune = { ...startTune(bounds), level: 80_000, full: counts(40), cut: counts(20) };
    const hold = decideStep(tune, bounds)!;
    expect(hold).toMatchObject({ to: 80_000, evalWanted: 65_000 });
    expect(65_000).toBeLessThan(EVAL_BELOW);
    expect(applyStep(tune, hold, 't')).toBeUndefined();
    expect(tune.evalWanted).toBe(65_000);
    tune.evalLevel = 65_000;
    tune.cut = counts(20);
    expect(decideStep(tune, bounds)).toMatchObject({ to: 65_000 });
  });

  it('reads the setting: auto is the tuned level, a number is itself, off is the vendor\'s', async () => {
    expect(contextThreshold({}, 'claude', 'm', bounds)).toBe(100_000);
    expect(contextThreshold({ compactAt: 150_000 }, 'claude', 'm', bounds)).toBe(150_000);
    expect(contextThreshold({ compactAt: 'off' }, 'claude', 'm', bounds)).toBeUndefined();
    for (let turn = 0; turn < TUNE_MIN_TURNS; turn += 1) {
      await noteTurnSignals('claude', 'm', counts(1), false, bounds, true);
      await noteTurnSignals('claude', 'm', counts(1), true, bounds, true);
    }
    expect(tunedLevel('claude', 'm', bounds)).toBe(85_000);
    expect(contextThreshold({}, 'claude', 'm', bounds)).toBe(85_000);
    expect(contextThreshold({}, 'claude', 'other', bounds)).toBe(100_000);
    await recordTuneEval('claude', 'm', 70_000, false, bounds);
    expect(tunedLevel('claude', 'm', bounds)).toBe(85_000);
    expect(tunedModels().find((item) => item.model === 'm')!.tune.log.at(-1)!.why).toContain('failed at 70k');
  });
});

describe('the auto-tune report', () => {
  it('shows each model\'s level, rates and last change, and the setting when not auto', async () => {
    const { contextTuneText } = await import('../tui/slash/usage-report.js');
    expect(contextTuneText({ globalSettings: { compactAt: 'off' } } as never)).toContain('off -- each vendor compacts');
    await noteTurnSignals('codex', 'gpt', counts(1, { reReads: 1 }), false, bounds, true);
    const text = contextTuneText({ globalSettings: {} } as never);
    expect(text).toContain('Context auto-tune (/compact auto)');
    expect(text).toContain('codex · gpt · 100k');
    expect(text).toContain('whole context: loss 1.00/turn, search 0.00/turn over 1 turns');
  });
});
