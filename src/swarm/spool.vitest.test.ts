import { appendFile, mkdir } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessActivityEvent } from '../harness/prompter.js';

describe('following a swarm\'s activity', () => {
  let home: string;
  const previous = process.env.CLIKCODE_HOME;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'clikcode-spool-')); process.env.CLIKCODE_HOME = home; vi.resetModules(); });
  afterEach(async () => {
    if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });

  it('delivers a clerk\'s row as soon as it is written, not on the backstop', async () => {
    const { appendSwarmActivity, watchSwarmActivity } = await import('./spool.js');
    const seen: HarnessActivityEvent[] = [];
    const stop = watchSwarmActivity('s1', (event) => seen.push(event), 60_000);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const written = Date.now();
      await appendSwarmActivity('s1', { kind: 'tool-start', label: 'Read README.md' } as HarnessActivityEvent);
      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 3_000 });
      expect(Date.now() - written).toBeLessThan(2_000);
    } finally { stop(); }
  });

  it('never loses a row read while it was half written', async () => {
    const { readSwarmActivity } = await import('./spool.js');
    const { swarmActivityPath } = await import('./store.js');
    const path = swarmActivityPath('s2');
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ kind: 'tool-start', label: 'one' })}\n{"kind":"tool-st`);
    const first = await readSwarmActivity('s2', 0);
    expect(first.events.map((event) => (event as { label?: string }).label)).toEqual(['one']);
    await appendFile(path, 'art","label":"two"}\n');
    const second = await readSwarmActivity('s2', first.offset);
    expect(second.events.map((event) => (event as { label?: string }).label)).toEqual(['two']);
  });
});
