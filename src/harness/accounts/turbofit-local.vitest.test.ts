import { describe, expect, it } from 'vitest';
import { isTurboFitModel } from './turbofit-local';
import { TURBOFIT_PLAN_SCRIPT, TURBOFIT_SUPERVISOR_SCRIPT } from './turbofit-scripts';

describe('turbofit local models', () => {
  it('knows which Hermes model ids run on the TurboFit gateway', () => {
    expect(isTurboFitModel('turbofit:auto')).toBe(true);
    expect(isTurboFitModel('turbofit:active:main')).toBe(true);
    expect(isTurboFitModel('custom:turbofit:active:aux')).toBe(true);
    expect(isTurboFitModel('openai-codex:gpt-6-astra')).toBe(false);
    expect(isTurboFitModel('openrouter:turbofit-lookalike')).toBe(false);
    expect(isTurboFitModel(null)).toBe(false);
  });

  it('keeps its Python verbatim: the markers ClikCode parses reach Python as escapes', () => {
    // String.raw: `\x00` must arrive as a Python escape, not a NUL in the source.
    expect(TURBOFIT_PLAN_SCRIPT).toContain('"\\x00TURBOFIT_PLAN"');
    expect(TURBOFIT_PLAN_SCRIPT).not.toContain('\x00');
    expect(TURBOFIT_SUPERVISOR_SCRIPT).toContain('clikcode-leases');
    expect(TURBOFIT_SUPERVISOR_SCRIPT).toContain('llama-server');
  });
});

import { estimateLane, meetsBar, rankLanes, type CpuLane, type CpuLanes } from './turbofit-local';

/** The CPU lanes TurboFit offers an 8-core Zen 4 with 56 GB, as listed there. */
function lane(variant: string, name: string, quant: string, totalB: number, activeB: number, gb: number): CpuLane {
  return { variant, name, quant, totalB, activeB, mainBytes: gb * 1e9, totalBytes: gb * 1e9, binaries: [], files: [] };
}
const LANES: CpuLanes = {
  pool: 'cpu', usableMb: 56_067, cores: 8,
  lanes: [
    lane('qwen3-8-27b-unleashed-ud-q3-k-xl', 'Qwen 3.8 27B Unleashed UD-Q3_K_XL', 'UD-Q3_K_XL', 27, 27, 13.2),
    lane('qwen3-8-27b-unleashed-ud-iq3-xxs', 'Qwen 3.8 27B Unleashed UD-IQ3_XXS', 'UD-IQ3_XXS', 27, 27, 11.0),
    lane('ornith-1-5-35a3b', 'Ornith 1.5 35B-A3B Q4_K_M', 'Q4_K_M', 35, 3, 21.7),
    lane('maple-preview-tq2', 'Maple Preview 20B-A1B TQ2_0', 'TQ2_0', 20, 1, 5.5),
  ],
};

describe('choosing a TurboFit model for a CPU', () => {
  it('estimates what llama-bench measured on the machine the rates come from', () => {
    // Measured there: Qwen Q3_K_XL 5.0 read / 3.3 write, IQ3_XXS 2.9 / 3.2,
    // Ornith Q4_K_M 88 / 20.4 tokens a second.
    const [qwen, iq3, ornith] = LANES.lanes.map((item) => estimateLane(item, 8));
    expect(qwen!.promptPerSecond).toBeCloseTo(5.0, 0);
    expect(iq3!.promptPerSecond).toBeCloseTo(2.9, 0);
    expect(ornith!.promptPerSecond).toBeCloseTo(88, -1);
    expect(qwen!.generatePerSecond).toBeCloseTo(3.0, 0);
    expect(ornith!.generatePerSecond).toBeGreaterThan(18);
    expect(ornith!.generatePerSecond).toBeLessThan(24);
  });

  it('tries the largest model expected to be usable first, and the dense 27Bs last', () => {
    const order = rankLanes(LANES, {}).map((item) => item.lane.variant);
    expect(order).toEqual(['ornith-1-5-35a3b', 'maple-preview-tq2', 'qwen3-8-27b-unleashed-ud-q3-k-xl', 'qwen3-8-27b-unleashed-ud-iq3-xxs']);
  });

  it('ranks a measured lane by its measurement, not its estimate', () => {
    const measuredSlow = { 'manual-cpu-ornith-1-5-35a3b-64k': { toolCalls: false, promptPerSecond: 88, generatePerSecond: 20 } };
    const order = rankLanes(LANES, measuredSlow);
    expect(order[0]!.lane.variant).toBe('maple-preview-tq2');
    expect(order.find((item) => item.lane.variant === 'ornith-1-5-35a3b')!.passes).toBe(false);
  });

  it('calls a model usable only with tool calls and both speeds over the bar', () => {
    expect(meetsBar({ toolCalls: true, promptPerSecond: 88, generatePerSecond: 20 })).toBe(true);
    expect(meetsBar({ toolCalls: false, promptPerSecond: 88, generatePerSecond: 20 })).toBe(false);
    expect(meetsBar({ toolCalls: true, promptPerSecond: 5, generatePerSecond: 3.3 })).toBe(false);
    expect(meetsBar({ toolCalls: true, promptPerSecond: 88 })).toBe(false);
    expect(meetsBar(undefined)).toBe(false);
  });
});
