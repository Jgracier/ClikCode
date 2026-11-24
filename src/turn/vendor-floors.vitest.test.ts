import { describe, expect, it } from 'vitest';
import { knownVendorMeasures, rememberVendorMeasure } from './vendor-floors.js';

describe('vendor measures', () => {
  it('keeps the highest floor and the smallest window a routed model reported', async () => {
    await rememberVendorMeasure('copilot-t', 'auto', 'c1', { floor: 20_000, window: 922_000 });
    await rememberVendorMeasure('copilot-t', 'auto', 'c1', { window: 272_000 });
    await rememberVendorMeasure('copilot-t', 'auto', 'c1', { window: 922_000, floor: 18_000 });
    await rememberVendorMeasure('copilot-t', 'auto', 'c2', { window: 400_000 });
    expect(knownVendorMeasures('copilot-t', 'auto')).toEqual({ floor: 20_000, window: 272_000 });
  });

  it('does not lend one model\'s window to a model never measured', async () => {
    await rememberVendorMeasure('copilot-u', 'gpt-a', 'c1', { floor: 15_000, window: 128_000 });
    expect(knownVendorMeasures('copilot-u', 'gpt-b')).toEqual({ floor: 15_000 });
  });
});
