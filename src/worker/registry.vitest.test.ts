import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkersDirectory, readWorkerRecord, removeWorkerRecord, socketPathFor, workerIsReachable, writeWorkerRecord } from './registry.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function isolatedHome(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-worker-registry-'));
  process.env.CLIKCODE_HOME = root;
  return root;
}

describe('worker registry', () => {
  it('round-trips a record through write/read/remove', async () => {
    await isolatedHome();
    const record = { pid: 1234, sessionId: 'abc', socketPath: socketPathFor('abc'), installationId: 'install', startedAt: new Date().toISOString(), token: 'secret' };
    await writeWorkerRecord(record);
    expect(await readWorkerRecord('abc')).toEqual(record);
    await removeWorkerRecord('abc');
    expect(await readWorkerRecord('abc')).toBeUndefined();
  });

  it('returns undefined for a session with no record at all', async () => {
    await isolatedHome();
    expect(await readWorkerRecord('never-written')).toBeUndefined();
  });

  it('keeps every socket path under the platform UDS length limit regardless of session id length', () => {
    const longId = 'a-very-long-session-identifier-that-is-not-a-plain-uuid-at-all-and-keeps-going';
    expect(socketPathFor(longId).length).toBeLessThan(100);
  });

  it('two different session ids never collide on the same socket path', () => {
    expect(socketPathFor('session-one')).not.toBe(socketPathFor('session-two'));
  });

  describe('workerIsReachable', () => {
    it('is true for a socket that is actually listening', async () => {
      await isolatedHome();
      await ensureWorkersDirectory();
      const path = socketPathFor('reachable');
      const server = createServer();
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(path, resolveListen);
      });
      try {
        expect(await workerIsReachable(path)).toBe(true);
      } finally {
        server.close();
      }
    });

    it('is false for a socket path nothing is listening on', async () => {
      await isolatedHome();
      expect(await workerIsReachable(socketPathFor('nothing-here'))).toBe(false);
    });
  });
});
