import { describe, expect, it } from 'vitest';
import { allLocalModels } from './catalog.js';
import { MIN_CONTEXT, type Fit } from './choose.js';
import { shrinkNotice, shrinkSteps, stopNotice } from './memory-steps.js';

const model = allLocalModels()[0]!;
const other = allLocalModels()[1]!;
const fit = { fits: true, context: 4 * MIN_CONTEXT, cacheType: 'q8_0', parallel: 1 } as unknown as Fit;
const args = (context: number, cache: number): string[] => [`-c ${context}`, `--cache-ram ${cache}`];

describe('the smaller restarts a local model may make to give memory back', () => {
  it('drops the prompt cache first, then halves the context down to the minimum, never below', () => {
    const steps = shrinkSteps(model, fit, 2048, false, args);
    expect(steps.map((step) => [step.context, step.cacheRamMib])).toEqual([[4 * MIN_CONTEXT, 0], [2 * MIN_CONTEXT, 0], [MIN_CONTEXT, 0]]);
    expect(steps[1]!.args).toEqual([`-c ${2 * MIN_CONTEXT}`, '--cache-ram 0']);
    expect(steps.every((step, index) => index === 0 || step.kvBytes < steps[index - 1]!.kvBytes)).toBe(true);
  });
  it('has no cache step when there is no prompt cache to drop', () => {
    expect(shrinkSteps(model, fit, 0, false, args).map((step) => step.context)).toEqual([2 * MIN_CONTEXT, MIN_CONTEXT]);
  });
});

describe('what the user is told about a memory restart or stop', () => {
  const event = { at: '2026-10-18T10:00:00.000Z', modelId: model.id, fromContext: 65_536, reason: '2 GB free' };
  it('says a restart\'s new and old context', () => {
    expect(shrinkNotice({ ...event, action: 'shrink', toContext: 32_768 })).toBe(`${model.label} was restarted at 32K context (from 64K) to leave memory for other programs: 2 GB free.`);
    expect(shrinkNotice({ ...event, action: 'stop' })).toBeUndefined();
  });
  it('says the last stop, and what was chosen instead', () => {
    const stop = { ...event, action: 'stop' as const };
    expect(stopNotice([], model, undefined)).toBeUndefined();
    expect(stopNotice([stop], model, { context: 32_768 })).toMatch(/was stopped at .* Restarted with 32K context, which fits what is free now\.$/);
    expect(stopNotice([stop], other, { context: 16_384 })).toMatch(new RegExp(`Chose ${other.label} at 16K context because it fits what is free now\\.$`));
    expect(stopNotice([stop], model, undefined)).toMatch(/to leave memory for other programs \(2 GB free\)\.$/);
  });
});
