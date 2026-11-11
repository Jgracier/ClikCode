/** Starting a worker: the window hears from the worker it started (an
 * inherited pipe), not from reading its record every 10 ms -- and a worker
 * that dies at startup is said at once, with what it wrote, not at the deadline. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import { forceStoreSession, unforceStoreSession } from '../session/ephemeral.js';
import { WorkerClient } from './client.js';

const saved = { home: process.env.CLIKCODE_HOME, entry: process.env.CLIKCODE_WORKER_ENTRY, scope: process.env.CLIKCODE_OWN_SCOPE };
const restore = (name: string, value: string | undefined): void => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
let root: string | undefined;
let sessionId: string | undefined;

afterEach(async () => {
  if (sessionId) unforceStoreSession(sessionId);
  restore('CLIKCODE_HOME', saved.home);
  restore('CLIKCODE_WORKER_ENTRY', saved.entry);
  restore('CLIKCODE_OWN_SCOPE', saved.scope);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('a worker that fails as it starts', () => {
  it('is reported as soon as it exits, with what it wrote', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-start-'));
    process.env.CLIKCODE_HOME = root;
    process.env.CLIKCODE_OWN_SCOPE = '0';
    const entry = join(root, 'broken-worker.mjs');
    await writeFile(entry, "process.stderr.write('Error: the worker could not load its build\\n'); process.exit(3);\n");
    process.env.CLIKCODE_WORKER_ENTRY = entry;
    const state = await readState();
    const now = new Date().toISOString();
    const session: HarnessSession = {
      id: randomUUID(), conversationId: randomUUID(), route: 'local', accountId: null, provider: null, model: null,
      effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    };
    sessionId = session.id;
    state.sessions.push(session);
    forceStoreSession(session.id);
    await writeState(state);
    const started = Date.now();
    await expect(WorkerClient.attach(session.id)).rejects.toThrow(/exited \(code 3\) before it started:[\s\S]*could not load its build/);
    // Well inside the 5 s a worker is given to start.
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
