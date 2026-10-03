import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveWorkerSessions } from './liveness.js';
import { ensureWorkersDirectory, writeWorkerRecord } from '../worker/registry.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('liveWorkerSessions reads the worker directory once', () => {
  it('reports only workers whose process is still alive', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-live-workers-'));
    process.env.CLIKCODE_HOME = root;
    await ensureWorkersDirectory();
    await writeWorkerRecord({
      sessionId: 'alive',
      pid: process.pid,
      socketPath: join(root, 'alive.sock'),
      token: 't',
      installationId: 'install',
      build: 'test',
      startedAt: new Date().toISOString(),
    });
    await writeWorkerRecord({
      sessionId: 'dead',
      pid: 2_147_483_646,
      socketPath: join(root, 'dead.sock'),
      token: 't',
      installationId: 'install',
      build: 'test',
      startedAt: new Date().toISOString(),
    });
    const live = await liveWorkerSessions();
    expect(live('alive')).toBe(true);
    expect(live('dead')).toBe(false);
    expect(live('chat-0')).toBe(false);
  });
});
