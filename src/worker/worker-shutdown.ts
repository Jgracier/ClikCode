/** The worker's shutdown: what it stops, and the successor it may start. */
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { startsSuccessor } from './idle-decisions.js';
import { closePersistentTransport } from '../turn/vendor-process.js';
import { disposeSessionState, takeShellNotifications } from '../agent/session-state.js';
import { existingSessionAgents } from '../agent/background-agents.js';
import { stateDirectory } from '../session/store/paths.js';
import { shutdownLanguageServers } from '../agent/lsp/servers.js';
import { closeComputerPage } from '../agent/computer/browser.js';
import { sendEvent } from './broadcast-observer.js';
import { removeWorkerRecord } from './registry.js';
import type { WorkerContext } from './worker-context.js';

/** How long the last events get to reach a window that is slow to read. */
const FLUSH_WINDOWS_MS = 10_000;
/** How long running agents get to commit their work when the worker must go. */
const AGENT_WIND_DOWN_MS = 30_000;

/** Per step (out-of-turn settle, vendor close, language servers) before shutdown moves on. */
const STEP_MS = 15_000;
/** The whole shutdown: past this it exits whatever is still pending. */
const SHUTDOWN_CEILING_MS = 90_000;

/** Runs one shutdown step for at most `ms`: a step that throws or hangs is
 * logged (lifecycle `worker.shutdown.stalled`, naming it) and shutdown goes on. */
export async function boundedStep(step: string, work: () => Promise<unknown> | undefined, ms = STEP_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<void>((resolve) => { timer = setTimeout(() => { lifecycle('worker.shutdown.stalled', { step, afterMs: ms }); resolve(); }, ms); timer.unref(); });
  try { await Promise.race([Promise.resolve(work()).then(() => undefined, () => undefined), stalled]); } finally { clearTimeout(timer); }
}

export function createShutdown(ctx: WorkerContext) {
  const { observer, sessionId, token, hold, socketPath, connections } = ctx;
  /** Once: a second signal while the first shutdown is still recording
   * what it stopped must not exit underneath that write. */
  let shuttingDown: Promise<void> | undefined;
  /** The step the shutdown is in, named when the ceiling is hit. */
  let currentStep = 'start';
  const shutdown = (reason: string): Promise<void> => {
    // Every step below is bounded (boundedStep, the wind-down and flush
    // timers), and the whole shutdown has a ceiling: a step that hangs
    // would otherwise leave shuttingDown set and every later signal doing
    // nothing. A step that throws must still end in an exit too.
    if (!shuttingDown) {
      const ceiling = setTimeout(() => { lifecycle('worker.shutdown.stalled', { step: currentStep, afterMs: SHUTDOWN_CEILING_MS }); process.exit(0); }, SHUTDOWN_CEILING_MS);
      ceiling.unref();
      shuttingDown = shutdownOnce(reason).catch(() => process.exit(0));
    }
    return shuttingDown;
  };
  /** The worker itself must go (not a replacement: that waits for agents to finish, worker-idle.ts):
   * running agents stop gracefully so their work is committed to their branches, and the next
   * turn is told what happened to each. Bounded. */
  const windDownAgents = async (reason: string): Promise<void> => {
    const agents = existingSessionAgents(ctx.agentSession);
    if (!agents?.runningAgents().length) return;
    ctx.agentSession.onNotification = undefined;
    const names = agents.runningAgents().map((agent) => agent.id).join(', ');
    lifecycle('worker.agents.wind-down', { reason, agents: names });
    await Promise.race([agents.stopAll(`ClikCode's worker stopped (${reason}); its work is committed to its branch`), new Promise<void>((resolve) => { setTimeout(resolve, AGENT_WIND_DOWN_MS).unref(); })]);
    const owed = takeShellNotifications(ctx.agentSession);
    ctx.agentSession.notifications.push(...owed.filter((note) => note.kind !== 'agent'));
    await ctx.io.recordNotifications(owed.filter((note) => note.kind === 'agent').map((note) => ({ ...note, reason: 'interrupted' }))).catch(quiet('worker/worker-shutdown'));
  };
  const shutdownOnce = async (reason: string): Promise<void> => {
    lifecycle('worker.shutdown', { reason, turnRunning: ctx.turnRunning, clients: observer.attachedCount });
    // A message the vendor was saying on its own is kept, not lost with the worker.
    currentStep = 'out-of-turn settle';
    await boundedStep(currentStep, () => ctx.outOfTurn?.settle());
    // Background shells the agent tools started are spawned DETACHED on
    // everything but Windows, so they outlive this process rather than dying
    // with it. disposeSessionState is the only thing that kills them and had
    // no caller anywhere, which meant a background command survived its
    // worker, its session and this terminal -- indefinitely. Done on every
    // shutdown reason, not just the idle one: whenever this worker is going
    // away, so is the session whose shells these are.
    //
    // Nothing is queued for the model about what this stops: killing
    // ClikCode leaves no turn behind and no text.
    currentStep = 'agent wind-down';
    await windDownAgents(reason);
    disposeSessionState(stateDirectory(), sessionId, `ClikCode's worker for this conversation stopped (${reason})`);
    // Codex app-server and ACP children are spawned detached too, and were
    // orphaned the same way.
    currentStep = 'vendor close';
    await boundedStep(currentStep, () => closePersistentTransport());
    // The lsp tool's language servers live as long as this worker.
    currentStep = 'language servers';
    await boundedStep(currentStep, () => shutdownLanguageServers());
    // The tab this chat opened in the shared Chrome goes with it, so tabs do not pile up (Chrome and other chats' tabs stay).
    await Promise.race([closeComputerPage(stateDirectory()).catch(quiet('worker/worker-shutdown')), new Promise<void>((resolve) => { setTimeout(resolve, 3_000).unref(); })]);
    currentStep = 'window flush';
    const flushed: Promise<void>[] = [];
    for (const connection of connections.keys()) {
      sendEvent(connection, { type: 'shutdown', reason });
      connection.end();
      flushed.push(new Promise<void>((resolve) => {
        if (connection.destroyed || connection.writableFinished) { resolve(); return; }
        connection.once('finish', resolve);
        connection.once('close', resolve);
        connection.once('error', () => resolve());
      }));
    }
    // The end of a long turn writes the whole conversation to each window
    // (megabytes), and what is still queued here is lost when the process
    // exits: the window got a cut-off frame and a closed socket instead of
    // the turn's end, and showed it running until it was reopened.
    await Promise.race([Promise.all(flushed), new Promise<void>((resolve) => { setTimeout(resolve, FLUSH_WINDOWS_MS).unref(); })]);
    ctx.server.close();
    currentStep = 'record cleanup';
    // Only what is still this worker's: the record and socket of a worker
    // that replaced it are that worker's to remove.
    observer.onAwaitingApproval = undefined;
    ctx.keepWarm?.stop();
    observer.onBackgroundWork = undefined;
    await ctx.recordWrite;
    await removeWorkerRecord(sessionId, token).catch(quiet('worker/worker-shutdown'));
    if (await hold.held()) await unlink(socketPath).catch(quiet('worker/worker-shutdown'));
    await hold.release().catch(quiet('worker/worker-shutdown'));
    // A turn parked for the reset is owed: stopped by nobody's choice (a
    // newer build, the 24-hour ceiling), a successor -- on whatever build is
    // installed now -- sends it. Stopped by a signal, it stays stopped.
    ctx.resumeWaiter.stop();
    const successor = startsSuccessor(ctx.resumeWaiter.pending, reason);
    lifecycle('worker.stopped', { reason, successor });
    if (successor) startSuccessor();
    process.exit(0);
  };
  const startSuccessor = (): void => {
    try {
      const child = spawn(process.execPath, [process.argv[1]!, 'session-worker', sessionId], { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => undefined);
      child.unref();
    } catch { /* fail-open-ok: the queued notification waits for the next open */ }
  };
  return shutdown;
}
