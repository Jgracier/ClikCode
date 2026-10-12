import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureWorkersDirectory, liveOpenConversations, takeConversation, workersDirectory } from './registry';

const file = (id: string): string => join(workersDirectory(), `${createHash('sha256').update(id).digest('hex').slice(0, 20)}.open`);
const record = (id: string, pid: number, host = hostname()): void => {
  writeFileSync(file(id), JSON.stringify({ pid, host, kind: 'client', nonce: 'n', at: new Date().toISOString() }));
};

describe('presence records in the worker registry', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  beforeEach(async () => { process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'cc-presence-')); await ensureWorkersDirectory(); });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
  });

  it('refuses a second live holder and names the first', async () => {
    record('chat', process.ppid);
    const taken = await takeConversation('chat', 'client');
    expect('holder' in taken && taken.holder.pid).toBe(process.ppid);
  });

  it('does not compete with the worker for the owner file', async () => {
    const presence = await takeConversation('chat', 'client');
    const worker = await takeConversation('chat', 'worker');
    expect('hold' in presence && 'hold' in worker).toBe(true);
    if ('hold' in presence) await presence.hold.release();
    if ('hold' in worker) await worker.hold.release();
  });

  it('frees the chat when the holder died, or stopped refreshing on another machine', async () => {
    record('dead', 2 ** 22 + 12345);
    expect((await liveOpenConversations())('dead')).toBe(false);
    record('remote', 1, 'another-machine');
    expect((await liveOpenConversations())('remote')).toBe(true);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(file('remote'), old, old);
    expect((await liveOpenConversations())('remote')).toBe(false);
    const taken = await takeConversation('dead', 'client');
    expect('hold' in taken).toBe(true);
    if ('hold' in taken) await taken.hold.release();
  });
});
