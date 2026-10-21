/** The install check for "nothing interrupts the sub-agents except an explicit
 * stop": cancel the turn, replace the worker, close the window -- the agents
 * still finish -- and when a worker does die, no work is lost.
 *
 * Run it after any change to turns, workers or agents:
 *   npx vitest run src/worker/agents-survive.vitest.test.ts */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionAgents } from '../agent/background-agents.js';
import { agentRecordStarted, agentRecordUpdated, readAgentRecords, reconcileAgents } from '../agent/agent-registry.js';
import { sessionState } from '../agent/session-state.js';
import { createWorktreeForTest } from './agents-survive.fixture.js';
import { createIdleControl } from './worker-idle.js';
import { BroadcastObserver } from './broadcast-observer.js';

const run = promisify(execFile);
let dir: string;
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-survive-'))); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const idleControlFor = (session: ReturnType<typeof sessionState>) => createIdleControl({
  observer: new BroadcastObserver(), sessionId: session.sessionId, agentSession: session,
  turnRunning: false, draining: false, vendorBackground: { busy: false }, outOfTurn: { active: false }, resumeWaiter: { pending: false },
} as never);

describe('background agents survive everything but an explicit stop', () => {
  it('a turn that is cancelled, a window that closes and a worker a newer build wants to replace all leave the agent running to its end', async () => {
    const session = sessionState(dir, `survive-${Math.random()}`);
    const agents = sessionAgents(session, dir);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let abortedBy: string | undefined;
    agents.start('long job', async (_steer, signal) => {
      signal.addEventListener('abort', () => { abortedBy = 'its own signal'; });
      await gate;
      return { output: 'finished the job' };
    });

    // 1. The turn that started it is cancelled (Esc, Ctrl+C, the editor's Stop).
    agents.attachTurn();
    agents.detachTurn();
    expect(agents.running()).toBe(1);

    // 2. The window closes: nothing about the agent depends on a connection.
    new BroadcastObserver();

    // 3. A newer build asks this worker to step down: it is busy, and says why.
    expect(idleControlFor(session).retireBlocker()).toBe('background agents are running');

    // Not one of them touched the agent.
    expect(abortedBy).toBeUndefined();
    finish();
    await agents.settled();

    // It finished, its result is owed to the model as a notification, and the worker is
    // not free to be replaced until the model has been told.
    expect(session.notifications).toMatchObject([{ kind: 'agent', shellId: 'agent_1', command: 'long job', tail: 'finished the job' }]);
    expect(idleControlFor(session).retireBlocker()).toBe('a notification is on its way to the model');
    expect(readAgentRecords(dir, session.sessionId)).toMatchObject([{ id: 'agent_1', status: 'finished' }]);
  });

  it('only an explicit stop ends it, and says who asked', async () => {
    const session = sessionState(dir, `survive-${Math.random()}`);
    const agents = sessionAgents(session, dir);
    agents.start('long job', (_steer, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ output: 'partial work committed' }))));
    await agents.stop('agent_1', 'stopped by you');
    expect(session.notifications[0]).toMatchObject({ kind: 'agent', tail: expect.stringContaining('[stopped: stopped by you]') });
  });

  it('a worker that died mid-run loses no work: its worktree is committed to the branch and the agent reported interrupted', async () => {
    const sessionId = `survive-${Math.random()}`;
    const worktree = await createWorktreeForTest(dir);
    await fs.writeFile(path.join(worktree.cwd, 'new.txt'), 'half-finished work\n');
    agentRecordStarted(dir, sessionId, { id: 'agent_1', label: 'long job', startedAt: Date.now() });
    agentRecordUpdated(dir, sessionId, 'agent_1', { worktree });
    // The record is from a worker that no longer exists.
    const file = path.join(dir, 'agent-registry', `${sessionId}.json`);
    const records = JSON.parse(await fs.readFile(file, 'utf8')) as Array<{ pid: number }>;
    records[0]!.pid = 2_147_483_646;
    await fs.writeFile(file, JSON.stringify(records));

    const reports = await reconcileAgents(dir, sessionId);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.report).toMatch(/ended before it finished.*changes are on branch/s);
    expect((await run('git', ['show', `${worktree.branch}:new.txt`], { cwd: worktree.repo })).stdout).toBe('half-finished work\n');
    expect(readAgentRecords(dir, sessionId)).toMatchObject([{ status: 'interrupted' }]);
    // Said once.
    expect(await reconcileAgents(dir, sessionId)).toEqual([]);
  });
});
