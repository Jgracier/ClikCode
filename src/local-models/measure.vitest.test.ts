import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestMeasurement, writeMeasurement } from './measure';

const previous = process.env.CLIKCODE_LOCAL_MODELS_HOME;
beforeEach(() => { process.env.CLIKCODE_LOCAL_MODELS_HOME = mkdtempSync(join(tmpdir(), 'cc-measure-')); });
afterEach(() => {
  if (previous === undefined) delete process.env.CLIKCODE_LOCAL_MODELS_HOME;
  else process.env.CLIKCODE_LOCAL_MODELS_HOME = previous;
});

describe('latestMeasurement', () => {
  // Joining a running server reads this instead of probing the hardware; the
  // start path reads it too, so every turn of a session sees one speed.
  it('returns the most recent measurement of the model across machine keys', async () => {
    expect(await latestMeasurement('qwen3.5-4b')).toBeUndefined();
    await writeMeasurement('machine-a', 'qwen3.5-4b', { promptPerSecond: 80, generatePerSecond: 9, toolCalls: true, at: '2026-09-01T00:00:00.000Z' });
    await writeMeasurement('machine-b', 'qwen3.5-4b', { promptPerSecond: 1500, generatePerSecond: 60, toolCalls: true, at: '2026-09-20T00:00:00.000Z' });
    await writeMeasurement('machine-b', 'gpt-oss-20b', { promptPerSecond: 40, generatePerSecond: 5, toolCalls: true, at: '2026-09-25T00:00:00.000Z' });
    expect((await latestMeasurement('qwen3.5-4b'))?.promptPerSecond).toBe(1500);
  });
});
