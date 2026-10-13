/** The worker's shutdown: what it stops, and the successor it may start. */
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { startsSuccessor } from './idle-decisions.js';
import { closePersistentTransport } from '../turn/vendor-process.js';
import { disposeSessionState } from '../agent/session-state.js';
import { stateDirectory } from '../session/store/paths.js';
import { shutdownLanguageServers } from '../agent/lsp/servers.js';
import { sendEvent } from './broadcast-observer.js';
import { removeWorkerRecord } from './registry.js';
import type { WorkerContext } from './worker-context.js';

export function createShutdown(ctx: WorkerContext) {
  const { observer, sessionId, token, hold, socketPath, connections } = ctx;
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
    // Nothing is queued for the model about what this stops: killing
    // ClikCode leaves no turn behind and no text.
    disposeSessionState(stateDirectory(), sessionId, `ClikCode's worker for this conversation stopped (${reason})`);
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
