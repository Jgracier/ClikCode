/** Measured, not estimated: prompt reading and generation speed on the
 * model now serving, and whether it makes a tool call when one is plainly
 * wanted. A model that fits and is fast but cannot call tools cannot do an
 * agent's work.
 *
 * Results are kept per machine and model, keyed by what would change them
 * (CPU, cores, RAM, GPUs, the llama.cpp build), so a new GPU or runtime
 * gets measured afresh while an ordinary restart does not. */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Footprint, Measurement } from './choose.js';
import type { HardwareProfile } from './hardware.js';
import { httpJson } from './launch.js';
import { footprintsFile, measurementsFile } from './paths.js';

export function machineKey(hardware: HardwareProfile, runtimeKey: string): string {
  const identity = [
    hardware.cpuModel, hardware.physicalCores, hardware.logicalCores,
    Math.round(hardware.totalRamBytes / 1024 ** 3),
    ...hardware.gpus.map((gpu) => `${gpu.name}:${Math.round(gpu.vramBytes / 1024 ** 3)}`),
    runtimeKey,
  ].join('|');
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

type MeasurementStore = Record<string, Record<string, Measurement>>;

async function readStore(): Promise<MeasurementStore> {
  try { return JSON.parse(await readFile(measurementsFile(), 'utf8')) as MeasurementStore; } catch { return {}; }
}

export async function readMeasurements(machine: string): Promise<Record<string, Measurement>> {
  return (await readStore())[machine] ?? {};
}

/** The most recent measurement of a model on this host, whatever runtime
 * build or GPU set it was taken under. Needs no hardware probe, so joining a
 * running server can report its speed as cheaply as it joins. */
export async function latestMeasurement(modelId: string): Promise<Measurement | undefined> {
  let latest: Measurement | undefined;
  for (const byModel of Object.values(await readStore())) {
    const entry = byModel?.[modelId];
    if (entry && (!latest || String(entry.at) > String(latest.at))) latest = entry;
  }
  return latest;
}

export async function writeMeasurement(machine: string, modelId: string, measurement: Measurement): Promise<void> {
  const store = await readStore();
  store[machine] = { ...store[machine], [modelId]: measurement };
  await mkdir(dirname(measurementsFile()), { recursive: true });
  // Written aside and renamed: two ClikCode processes measuring at once
  // must not leave a half-written file for either to read.
  const temporary = `${measurementsFile()}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2));
  await rename(temporary, measurementsFile());
}

/** The footprints the supervisor recorded for a model on this machine
 * (keyed as footprintKey), in the store's own words. */
export type FootprintStore = Record<string, Record<string, Footprint>>;

export function footprintKey(config: Pick<Footprint, 'context' | 'cacheType' | 'parallel' | 'vision'>): string {
  return `${config.context}|${config.cacheType}|${config.parallel}|${config.vision ? 'vision' : 'text'}`;
}

export async function readFootprints(machine: string, modelIds: readonly string[]): Promise<Record<string, Footprint[]>> {
  const result: Record<string, Footprint[]> = {};
  for (const modelId of modelIds) {
    let store: FootprintStore = {};
    try { store = JSON.parse(await readFile(footprintsFile(modelId), 'utf8')) as FootprintStore; } catch { /* Never run here. */ }
    const entries = Object.values(store[machine] ?? {}).filter((entry) => entry && typeof entry.anonBytes === 'number');
    if (entries.length) result[modelId] = entries;
  }
  return result;
}

/** About 700 tokens: 240 numbers of one to four digits with separators. */
export function measurementPrompt(): string {
  const numbers = Array.from({ length: 240 }, (_, index) => `${index * 7 + 3}`).join(', ');
  return `Here is a list of numbers: ${numbers}.\nDescribe the pattern in these numbers in a few sentences.`;
}

/** Thinking is turned off for the check (Qwen templates read
 * enable_thinking, gpt-oss reads reasoning_effort; each ignores the
 * other): it measures the same speeds, and a thinking model's tool call
 * would otherwise wait behind hundreds of tokens of reasoning. */
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' };

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function measureServer(port: number, alias: string): Promise<Measurement> {
  // cache_prompt off: on a server that has seen this prompt before, a
  // cached prefix would make reading look instant.
  const speed = await httpJson(port, 'POST', '/v1/chat/completions', {
    model: alias, max_tokens: 64, temperature: 0, cache_prompt: false, ...NO_THINKING,
    messages: [{ role: 'user', content: measurementPrompt() }],
  }, 10 * 60_000);
  const timings = (speed.json as { timings?: { prompt_per_second?: unknown; predicted_per_second?: unknown } } | undefined)?.timings;
  const tool = await httpJson(port, 'POST', '/v1/chat/completions', {
    model: alias, max_tokens: 512, temperature: 0, ...NO_THINKING,
    messages: [{ role: 'user', content: 'What time is it right now? Use the get_time tool.' }],
    tools: [{ type: 'function', function: { name: 'get_time', description: 'Returns the current time', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto',
  }, 10 * 60_000);
  const calls = (tool.json as { choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[] } | undefined)
    ?.choices?.[0]?.message?.tool_calls ?? [];
  const promptPerSecond = positive(timings?.prompt_per_second);
  const generatePerSecond = positive(timings?.predicted_per_second);
  return {
    ...(promptPerSecond ? { promptPerSecond } : {}),
    ...(generatePerSecond ? { generatePerSecond } : {}),
    toolCalls: calls.some((call) => call.function?.name === 'get_time'),
    at: new Date().toISOString(),
  };
}
