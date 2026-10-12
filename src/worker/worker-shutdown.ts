/** The worker's shutdown: what it records for the model, what it stops, and the
 * successor it may start. */
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { startsSuccessor } from './idle-decisions.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { enqueueSessionTurn } from '../turn/checkpoint.js';
import { CLIKCODE_NOTICE_TAG } from '../session/clikcode-notice.js';
import { closePersistentTransport, persistentWorkRunning } from '../turn/vendor-process.js';
import { disposeSessionState } from '../agent/session-state.js';
import { stateDirectory } from '../session/store/paths.js';
import { shutdownLanguageServers } from '../agent/lsp/servers.js';
import { sendEvent } from './broadcast-observer.js';
import { removeWorkerRecord } from './registry.js';
import type { WorkerContext } from './worker-context.js';

export function createShutdown(ctx: WorkerContext) {
  const { observer, sessionId, token, hold, socketPath, connections } = ctx;
  const { recordNotifications } = ctx.io;
  /** Tell the model, through the next worker for this conversation, that
   * work its vendor left running was stopped -- never stopped unsaid. */
  const recordVendorWorkStopped = async (reason: string): Promise<void> => {
    const latest = await readState({ transcripts: [sessionId] });
    const found = latest.sessions.find((item) => item.id === sessionId);
    if (!found) return;
    const submittedAt = new Date().toISOString();
    enqueueSessionTurn(found, {
      id: randomUUID(), submittedAt, kind: 'notification',
      text: `${CLIKCODE_NOTICE_TAG}Background work you started in an earlier turn (a background command or server) was stopped: ${reason}. Check whether it finished, and start it again if it is still needed.`,
    }, submittedAt);
    await writeState(latest);
  };

  /** Once: a second signal while the first shutdown is still recording
   * what it stopped must not exit underneath that write. */
  let shuttingDown: Promise<void> | undefined;
  const shutdown = (reason: string): Promise<void> => {
    // Every step below is bounded (a vendor gets seconds, then is killed; a
    // state write gives up after its lock wait). A step that throws must
    // still end in an exit: a rejected shutdown never reached it.
    shuttingDown ??= shutdownOnce(reason).catch(() => process.exit(0));
    return shuttingDown;
  };
  const shutdownOnce = async (reason: string): Promise<void> => {
    lifecycle('worker.shutdown', { reason, turnRunning: ctx.turnRunning, clients: observer.attachedCount });
    // Background shells the agent tools started are spawned DETACHED on
    // everything but Windows, so they outlive this process rather than dying
    // with it. disposeSessionState is the only thing that kills them and had
    // no caller anywhere, which meant a background command survived its
    // worker, its session and this terminal -- indefinitely. Done on every
    // shutdown reason, not just the idle one: whenever this worker is going
    // away, so is the session whose shells these are.
    //
    // What the model was never told -- notifications not yet delivered, and
    // each shell this stops -- is recorded as a queued turn first, so the
    // next worker for the conversation delivers it.
    const undelivered = disposeSessionState(stateDirectory(), sessionId, `ClikCode's worker for this conversation stopped (${reason})`);
    let owed = undelivered.length > 0;
    await recordNotifications(undelivered).catch(() => undefined);
    // The same for work a persistent vendor left running: closing the child
    // below stops it.
    if (await persistentWorkRunning(sessionId)) {
      owed = true;
      await recordVendorWorkStopped(`ClikCode's worker for this conversation stopped (${reason})`).catch(() => undefined);
    }
    // Codex app-server and ACP children are spawned detached too, and were
    // orphaned the same way.
    await closePersistentTransport().catch(() => undefined);
    // The lsp tool's language servers live as long as this worker.
    await shutdownLanguageServers().catch(() => undefined);
    for (const connection of connections.keys()) {
      sendEvent(connection, { type: 'shutdown', reason });
      connection.end();
    }
    ctx.server.close();
    // Only what is still this worker's: the record and socket of a worker
    // that replaced it are that worker's to remove.
    observer.onAwaitingApproval = undefined;
    await ctx.recordWrite;
    await removeWorkerRecord(sessionId, token).catch(() => undefined);
    if (await hold.held()) await unlink(socketPath).catch(() => undefined);
    await hold.release().catch(() => undefined);
    // Owed the model something and stopped by nobody's choice (a newer
    // build, the 24-hour ceiling): a successor -- on whatever build is
    // installed now -- delivers it at once, instead of waiting for someone
    // to reopen the conversation. Stopped by a signal, it stays stopped.
    // A turn parked for the reset is owed too: the successor sends it.
    ctx.resumeWaiter.stop();
    const successor = startsSuccessor(owed || ctx.resumeWaiter.pending, reason);
    lifecycle('worker.stopped', { reason, owed, successor });
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
