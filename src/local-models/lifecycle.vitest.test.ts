import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverDir, sessionHeldElsewhere, writeLease } from './lifecycle';

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
