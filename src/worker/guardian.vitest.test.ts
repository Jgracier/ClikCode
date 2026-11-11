import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { sendResourceNote, startGuardian } from './guardian.js';
import { FrameDecoder } from './protocol.js';
import { ensureWorkersDirectory, socketPathFor, takeConversation, writeWorkerRecord } from './registry.js';
import { tryLease } from '../session/store/locks.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'clikcode-guardian-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('the guardian worker', () => {
  it('runs the machine-wide guards in one worker only, and another takes them over when it goes', async () => {
    const lockPath = join(dir, 'guardian.lease');
    const running: string[] = [];
    const guard = (name: string) => () => { running.push(name); return () => { running.splice(running.indexOf(name), 1); }; };
    const first = startGuardian({ lockPath, checkMs: 20, guard: guard('first') });
    await vi.waitFor(() => expect(running).toEqual(['first']));
    const second = startGuardian({ lockPath, checkMs: 20, guard: guard('second') });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(running).toEqual(['first']);
    await first();
    await vi.waitFor(() => expect(running).toEqual(['second']));
    await second();
    expect(running).toEqual([]);
  });

  it('takes a lease whose holder is gone', async () => {
    const lockPath = join(dir, 'guardian.lease');
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_646, host: 'elsewhere', nonce: 'n', at: '' }));
    expect(await tryLease(lockPath)).toBeUndefined();
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lockPath, old, old);
    const lease = await tryLease(lockPath);
    expect(lease && await lease.held()).toBe(true);
    await lease?.release();
  });

  it('sends a note for another worker\'s conversation to that worker, with its token', async () => {
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = dir;
    const server = createServer();
    try {
      await ensureWorkersDirectory();
      const socketPath = socketPathFor('other');
      const received = new Promise<unknown[]>((resolveFrames) => {
        server.on('connection', (socket) => {
          const frames = new FrameDecoder();
          const got: unknown[] = [];
          socket.on('data', (chunk) => { got.push(...frames.push(chunk)); });
          socket.on('end', () => resolveFrames(got));
        });
      });
      await new Promise<void>((resolveListening) => server.listen(socketPath, resolveListening));
      await writeWorkerRecord({ sessionId: 'other', pid: process.pid, socketPath, token: 'tok', installationId: 'i', startedAt: new Date().toISOString() });
      const taken = await takeConversation('other', 'worker');
      await sendResourceNote(process.pid, 'memory is tight');
      expect(await received).toEqual([{ type: 'resource-note', token: 'tok', note: 'memory is tight' }]);
      if ('hold' in taken) await taken.hold.release();
    } finally {
      server.close();
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
    }
  });
});
