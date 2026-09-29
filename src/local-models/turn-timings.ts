/** The actual cost of local turns, on this host and model.
 *
 * llama.cpp reports how many prompt tokens were reused and how long it
 * spent reading and writing. Keeping those numbers lets us distinguish a
 * cache miss from slow generation on any CPU or GPU. No prompt, response or
 * session identifier is written. Metrics are advisory and never delay a turn.
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlamaTimings } from '../agent/models/openai-client.js';
import { safeName, serversDir } from './paths.js';

/** Recent history is what matters; one rotated generation bounds disk use. */
const MAX_LOG_BYTES = 1 << 20;

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export async function recordLocalTurnTiming(modelId: string, timings: LlamaTimings, elapsedMs: number): Promise<void> {
  const dir = join(serversDir(), safeName(modelId));
  const record = {
    at: new Date().toISOString(),
    ...(finite(timings.cache_n) !== undefined ? { cacheTokens: timings.cache_n } : {}),
    ...(finite(timings.prompt_n) !== undefined ? { readTokens: timings.prompt_n } : {}),
    ...(finite(timings.prompt_ms) !== undefined ? { readMs: timings.prompt_ms } : {}),
    ...(finite(timings.predicted_n) !== undefined ? { writtenTokens: timings.predicted_n } : {}),
    ...(finite(timings.predicted_ms) !== undefined ? { writeMs: timings.predicted_ms } : {}),
    ...(finite(elapsedMs) !== undefined ? { elapsedMs: Math.round(elapsedMs) } : {}),
  };
  try {
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'turn-timings.jsonl');
    const size = await stat(file).then((s) => s.size, () => 0);
    if (size >= MAX_LOG_BYTES) await rename(file, `${file}.1`);
    await appendFile(file, `${JSON.stringify(record)}\n`);
  } catch { /* A read-only or full disk cannot interrupt inference. */ }
}
