import { afterEach, expect, it, vi } from 'vitest';
import { bindGlobalFlags } from '../../cli/output-mode.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { aiUsage } from './status.js';

afterEach(() => { vi.restoreAllMocks(); bindGlobalFlags({}); });

async function run(json: boolean, now: number): Promise<string> {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out += chunk; return true; }) as never);
  bindGlobalFlags(json ? { json: true } : { human: true });
  await aiUsage(now);
  return out;
}

it('prints the rollups /usage all shows, not every recorded call or an average latency over them', async () => {
  const now = Date.parse('2026-11-10T15:00:00');
  const state = await readState();
  state.invocations.push(...Array.from({ length: 40 }, (_, index) => ({
    id: `call-${index}`, accountId: 'acct', provider: 'anthropic', model: 'sonnet', at: new Date(now - (index % 2) * 86_400_000).toISOString(),
    inputTokens: 100, outputTokens: 50, costUsd: 0.01, latencyMs: 600_000,
  })));
  await writeState(state);

  const human = await run(false, now);
  expect(human).toContain('Last 7 days');
  expect(human).toContain('40 turns');
  expect(human).not.toMatch(/call-\d|latency/i);

  const json = JSON.parse((await run(true, now)).trim()) as { providers: Array<{ provider: string; turns: number; totalTokens: number; costUsd: number }>; days: Array<{ turns: number }>; invocations?: unknown };
  expect(json.invocations).toBeUndefined();
  expect(json.providers).toEqual([expect.objectContaining({ provider: 'anthropic', turns: 40, totalTokens: 6_000 })]);
  expect(json.providers[0]!.costUsd).toBeCloseTo(0.4);
  expect(json.days.slice(0, 2).map((day) => day.turns)).toEqual([20, 20]);
});
