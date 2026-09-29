import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { recordLocalTurnTiming } from './turn-timings.js';

let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it('records cache reuse and latency without conversation content', async () => {
  directory = await mkdtemp(join(tmpdir(), 'clikcode-timings-'));
  vi.stubEnv('CLIKCODE_LOCAL_MODELS_HOME', directory);
  await recordLocalTurnTiming('test/model', { cache_n: 4200, prompt_n: 37, prompt_ms: 400, predicted_n: 18, predicted_ms: 900 }, 1510);
  const raw = await readFile(join(directory, 'servers', 'test_model', 'turn-timings.jsonl'), 'utf8');
  expect(JSON.parse(raw)).toMatchObject({ cacheTokens: 4200, readTokens: 37, readMs: 400, writtenTokens: 18, writeMs: 900, elapsedMs: 1510 });
  expect(raw).not.toContain('session');
  expect(raw).not.toContain('prompt');
});

it('rotates the log instead of growing without bound', async () => {
  directory = await mkdtemp(join(tmpdir(), 'clikcode-timings-'));
  vi.stubEnv('CLIKCODE_LOCAL_MODELS_HOME', directory);
  const dir = join(directory, 'servers', 'm');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'turn-timings.jsonl'), 'x'.repeat(1 << 20));
  await recordLocalTurnTiming('m', { cache_n: 1 }, 5);
  expect((await readFile(join(dir, 'turn-timings.jsonl'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);
  expect((await readFile(join(dir, 'turn-timings.jsonl.1'), 'utf8')).length).toBe(1 << 20);
});
