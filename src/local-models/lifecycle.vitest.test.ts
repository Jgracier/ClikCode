import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldByLiveProcess, serverDir, sessionHeldElsewhere, writeLease } from './lifecycle';

const previous = process.env.CLIKCODE_LOCAL_MODELS_HOME;
beforeEach(() => { process.env.CLIKCODE_LOCAL_MODELS_HOME = mkdtempSync(join(tmpdir(), 'cc-leases-')); });
afterEach(() => {
  if (previous === undefined) delete process.env.CLIKCODE_LOCAL_MODELS_HOME;
  else process.env.CLIKCODE_LOCAL_MODELS_HOME = previous;
});

function leaseFrom(pid: number, sessionId: string): void {
  const directory = join(serverDir('qwen3.5-4b'), 'leases');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${pid}-${sessionId}.json`), '{}');
}

describe('whether another process holds a session', () => {
  it('counts a live other process, and neither this one nor a dead one', async () => {
    await writeLease('qwen3.5-4b', 'abc-123');
    expect(await sessionHeldElsewhere('qwen3.5-4b', 'abc-123')).toBe(false);
    // pid 1 is always alive; a pid far past pid_max never is.
    leaseFrom(99_999_999, 'abc-123');
    expect(await sessionHeldElsewhere('qwen3.5-4b', 'abc-123')).toBe(false);
    leaseFrom(1, 'other-session');
    expect(await sessionHeldElsewhere('qwen3.5-4b', 'abc-123')).toBe(false);
    leaseFrom(1, 'abc-123');
    expect(await sessionHeldElsewhere('qwen3.5-4b', 'abc-123')).toBe(true);
    expect(await sessionHeldElsewhere('gpt-oss-20b', 'abc-123')).toBe(false);
  });
});

describe('measured footprints', () => {
  it('are read per machine and model, keyed by configuration', async () => {
    const { footprintKey, readFootprints } = await import('./measure');
    const { footprintsFile } = await import('./paths');
    const run = { context: 65_536, cacheType: 'f16', parallel: 2, vision: false, anonBytes: 3.9e9, fileBytes: 2.1e9, at: 'now' };
    mkdirSync(serverDir('qwen3.5-4b'), { recursive: true });
    writeFileSync(footprintsFile('qwen3.5-4b'), JSON.stringify({ here: { [footprintKey(run)]: run }, elsewhere: { x: { ...run, anonBytes: 1 } } }));
    expect(footprintKey(run)).toBe('65536|f16|2|text');
    expect(await readFootprints('here', ['qwen3.5-4b', 'gpt-oss-20b'])).toEqual({ 'qwen3.5-4b': [run] });
    expect(await readFootprints('new-machine', ['qwen3.5-4b'])).toEqual({});
  });
});

describe('whether anyone holds a model', () => {
  it('counts only leases whose process is alive', async () => {
    expect(await heldByLiveProcess('m')).toBe(false);
    mkdirSync(join(serverDir('m'), 'leases'), { recursive: true });
    writeFileSync(join(serverDir('m'), 'leases', '999999999-gone.json'), '{}');
    expect(await heldByLiveProcess('m')).toBe(false);
    await writeLease('m', 'mine');
    expect(await heldByLiveProcess('m')).toBe(true);
  });
});
