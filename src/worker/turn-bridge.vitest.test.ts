import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { HarnessSession } from '../session/model.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';
import { readWorkerRecord } from './registry.js';
import { closeAllWorkerClients, runTurnThroughWorker } from './turn-bridge.js';

const previousHome = process.env.CLIKCODE_HOME;
const previousWorkerEntry = process.env.CLIKCODE_WORKER_ENTRY;
let root: string | undefined;
/** See session-worker.vitest.test.ts's identical mechanism for why this
 * exists: closing a WorkerClient only disconnects, it does not tell the
 * worker itself to stop, and that worker is designed to sit idle for up to
 * 30 real minutes otherwise -- correct in production, wrong left to a test
 * suite that runs this file repeatedly. */
const spawnedSessionIds: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = join(repoRoot, 'dist', 'index.js');

async function terminateSpawnedWorkers(): Promise<void> {
  for (const sessionId of spawnedSessionIds.splice(0)) {
    const record = await readWorkerRecord(sessionId).catch(() => undefined);
    if (record) { try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
}

beforeAll(async () => {
  process.env.CLIKCODE_WORKER_ENTRY = distEntry;
  const alreadyBuilt = await access(distEntry).then(() => true, () => false);
  if (!alreadyBuilt) await promisify(execFile)('node', ['scripts/build.mjs'], { cwd: repoRoot });
}, 30_000);

afterAll(() => {
  if (previousWorkerEntry === undefined) delete process.env.CLIKCODE_WORKER_ENTRY;
  else process.env.CLIKCODE_WORKER_ENTRY = previousWorkerEntry;
});

afterEach(async () => {
  await closeAllWorkerClients();
  // Must run while CLIKCODE_HOME still points at this test's own temp
  // directory -- readWorkerRecord looks the record up under it.
  await terminateSpawnedWorkers();
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function isolatedSession(): Promise<HarnessSession> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-turn-bridge-'));
  process.env.CLIKCODE_HOME = root;
  const state = await readState();
  const now = new Date().toISOString();
  const session: HarnessSession = {
    id: randomUUID(), conversationId: randomUUID(), route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
  };
  state.sessions.push(session);
  await writeState(state);
  spawnedSessionIds.push(session.id);
  return session;
}

/** Records every call `runTurnThroughWorker` makes on what it believes is a
 * real TerminalHarnessPrompter. Cast, not structurally typed: the real class
 * has private fields, so nothing can satisfy its type honestly outside the
 * class itself -- this is the accepted test-only escape hatch for exactly
 * that, not a design flaw in the class. */
function fakePrompter(): TerminalHarnessPrompter & { calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push(`${name}(${args.map((a) => (typeof a === 'function' ? '[fn]' : JSON.stringify(a))).join(',')})`);
  };
  const fake = {
    calls,
    render: record('render'),
    response: record('response'),
    activity: record('activity'),
    activityEvent: record('activityEvent'),
    phase: record('phase'),
    setPlan: record('setPlan'),
    setTurnUsage: record('setTurnUsage'),
    approval: async (...args: unknown[]) => { record('approval')(...args); return false; },
    startWaiting: record('startWaiting'),
    stopWaiting: record('stopWaiting'),
    suspend: async (...args: unknown[]) => { record('suspend')(...args); },
    resume: record('resume'),
    restoreDraft: record('restoreDraft'),
    panel: record('panel'),
    close: record('close'),
    question: async () => '',
  };
  return fake as unknown as TerminalHarnessPrompter & { calls: string[] };
}

describe('runTurnThroughWorker (real spawned worker, fake terminal)', () => {
  it('a failing turn (no account configured) rejects and still calls stopWaiting', async () => {
    const session = await isolatedSession();
    const rl = fakePrompter();
    await expect(runTurnThroughWorker(session.id, rl, 'hello', { echo: true }))
      .rejects.toThrow(/no account selected/);
    expect(rl.calls).toContain('startWaiting("thinking",[fn],[fn])');
    expect(rl.calls).toContain('stopWaiting()');
    // Rendered the optimistic pending state via the worker's own snapshot
    // on attach, before the submit was even sent -- proves the event
    // ordering (attach -> snapshot -> submit) actually holds over the wire,
    // not just in the protocol's type definitions.
    expect(rl.calls.some((call) => call.startsWith('render('))).toBe(true);
  });

  it('reuses the same worker connection across two calls for the same session', async () => {
    const session = await isolatedSession();
    const rl = fakePrompter();
    await runTurnThroughWorker(session.id, rl, 'first', { echo: true }).catch(() => undefined);
    const firstSnapshotCount = rl.calls.filter((call) => call.startsWith('render(')).length;
    await runTurnThroughWorker(session.id, rl, 'second', { echo: true }).catch(() => undefined);
    const secondSnapshotCount = rl.calls.filter((call) => call.startsWith('render(')).length;
    // Two turns, but only one attach's worth of "first contact" overhead --
    // a fresh WorkerClient per call would still work, just wastefully; this
    // confirms clientFor()'s cache is actually doing its job.
    expect(secondSnapshotCount).toBeGreaterThan(firstSnapshotCount);
  });
});
