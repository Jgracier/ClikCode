/** The worker's idle exit, vendor idle close and build-watch retirement: the
 * timers and the rules for when each lets the worker go. */
import { lifecycle } from '../runtime/lifecycle-log.js';
import { existingSessionAgents } from '../agent/background-agents.js';
import { idleDecision, vendorIdleDecision } from './idle-decisions.js';
import { hasHeldVendorProcess, whenHeldVendorGone } from '../harness/transport/native/held-vendor.js';
import { closePersistentTransport, hasPersistentTransport, persistentWorkRunning } from '../turn/vendor-process.js';
import { runningShellCount } from '../agent/session-state.js';
import { stopBackgroundShell } from '../agent/tools/bash.js';
import { currentWorkerBuild } from './registry.js';
import type { WorkerContext } from './worker-context.js';

/** No attached client and no turn running, for this long: the worker exits
 * on its own rather than living forever the way the process it replaces
 * did. Generous enough that a flaky reconnect (the original SIGHUP/SIGINT
 * problem this whole design fixes more robustly) has plenty of time to
 * happen without racing a shutdown; short enough that a genuinely abandoned
 * session does not sit as dead weight for days the way the zombie processes
 * that motivated this design did. CLIKCODE_WORKER_IDLE_EXIT_MS overrides it
 * for tests that need to watch a worker decide to exit. */
const IDLE_EXIT_MS = Number(process.env.CLIKCODE_WORKER_IDLE_EXIT_MS) > 0 ? Number(process.env.CLIKCODE_WORKER_IDLE_EXIT_MS) : 30 * 60 * 1000;
/** How often an idle worker checks whether a rebuild replaced its entry.
 * CLIKCODE_WORKER_BUILD_WATCH_MS overrides it for tests. */
export const BUILD_WATCH_MS = Number(process.env.CLIKCODE_WORKER_BUILD_WATCH_MS) > 0 ? Number(process.env.CLIKCODE_WORKER_BUILD_WATCH_MS) : 15_000;

/** A background shell keeps an otherwise idle worker alive -- its exit is
 * owed to the model -- but not for ever: this long after it started, with
 * nobody attached and no turn running, it is stopped, and the model is told
 * so like any other exit. */
const ABANDONED_SHELL_MS = 24 * 60 * 60 * 1000;
/** How often a worker that reached its idle time looks again at vendor work
 * still running between turns (a process's exit gives no event to another
 * process's parent). */
const VENDOR_WORK_RECHECK_MS = 30 * 1000;
/** No turn for this long: the persistent vendor (Codex app-server, an ACP
 * agent) and the MCP servers it started are closed, even with a window
 * open -- they are most of a conversation's memory. The worker stays; the
 * next turn starts the vendor again and resumes its thread natively.
 * CLIKCODE_VENDOR_IDLE_CLOSE_MS overrides it for tests. */
const VENDOR_IDLE_CLOSE_MS = Number(process.env.CLIKCODE_VENDOR_IDLE_CLOSE_MS) > 0 ? Number(process.env.CLIKCODE_VENDOR_IDLE_CLOSE_MS) : 15 * 60 * 1000;

export function createIdleControl(ctx: WorkerContext) {
  const { observer, sessionId, agentSession } = ctx;
  /** Why this worker cannot be replaced right now, or undefined when it can.
   * Anything it is doing for the conversation counts -- a turn, the queue
   * being drained, vendor background work, a shell or a notification the
   * model is owed -- because replacing it would lose that work. Clients do
   * not; an idle window simply attaches to the replacement next time. */
  const retireBlocker = (): string | undefined => {
    if (ctx.turnRunning || ctx.draining) return 'a turn is running';
    if (ctx.vendorBackground.busy) return 'vendor background work is running';
    if (hasHeldVendorProcess(sessionId)) return 'a vendor is still finishing its background work';
    if (vendorWorkSince !== undefined) return 'the vendor is still running work it started';
    if (existingSessionAgents(agentSession)?.running()) return 'background agents are running';
    if (runningShellCount(agentSession) > 0) return 'a background shell is running';
    if (agentSession.notifications.length) return 'a notification is on its way to the model';
    if (agentSession.wakeups.size) return 'a scheduled wakeup is pending';
    return undefined;
  };

  /** Idle means no client, no turn, no background shell whose exit the
   * model is still owed, and no notification on its way to it. A running
   * shell instead arms the abandoned-shell ceiling (ABANDONED_SHELL_MS). */
  /** Nobody attached, nothing running, and the entry on disk is no longer
   * what this process loaded: leave now so the next open gets a fresh
   * worker. An attached window is left alone -- its own attach asks for
   * retirement; killing under a live prompt is worse. */
  const leaveIfStaleBuild = (): void => {
    if (!ctx.spawnedBuild || observer.attachedCount > 0 || retireBlocker()) return;
    const live = currentWorkerBuild();
    if (!live || live === ctx.spawnedBuild) return;
    retireIfFree();
  };
  /** Retire for a newer build unless the vendor is running work a tool call
   * left (toolCallWork): retiring closes the vendor, which stops that work
   * and owes the model a turn to say so. Checked again at every idle edge
   * and build-watch tick, so it goes once the work has ended. */
  let retireCheck: Promise<void> | undefined;
  const retireIfFree = (): void => {
    retireCheck ??= (async () => {
      const running = await persistentWorkRunning(sessionId);
      // Something started meanwhile: its own edge checks again.
      if (retireBlocker()) return;
      if (running) { noteIdle('held: retiring once the vendor\'s work ends'); return; }
      void ctx.shutdown('replaced by a newer ClikCode build');
    })().catch(() => undefined).finally(() => { retireCheck = undefined; });
  };

  let awaitingHeldVendor = false;
  /** What the worker's idle exit is doing now, logged when it changes: what
   * holds it up, or that its timer runs (runtime/lifecycle-log.ts). */
  let idleState = '';
  const noteIdle = (state: string): void => {
    if (state === idleState) return;
    idleState = state;
    lifecycle('worker.idle', { state });
  };
  const scheduleIdleExit = (): void => {
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
    ctx.idleTimer = undefined;
    noteIdle(ctx.turnRunning ? 'held: a turn is running' : ctx.vendorBackground.busy ? 'held: vendor background work'
      : observer.attachedCount > 0 ? `held: ${observer.attachedCount} window(s) attached` : existingSessionAgents(agentSession)?.running() ? `held: ${existingSessionAgents(agentSession)!.running()} background agent(s)` : agentSession.notifications.length ? 'held: a notification to deliver' : agentSession.wakeups.size ? `held: ${agentSession.wakeups.size} scheduled wakeup(s)`
        : ctx.resumeWaiter.pending ? 'held: waiting for a quota reset' : hasHeldVendorProcess(sessionId) ? 'held: a vendor finishing background work'
          : runningShellCount(agentSession) > 0 ? `held: ${runningShellCount(agentSession)} background shell(s)` : `idle: exits in ${Math.round(IDLE_EXIT_MS / 1000)}s`);
    // A newer build asked for this worker while it was busy: the moment it is
    // not, it goes, and the next window to need one starts that build.
    if (ctx.retireWhenIdle && !retireBlocker()) retireIfFree();
    else leaveIfStaleBuild();
    // A scheduled wakeup is owed to the model: the worker that holds its
    // timer must stay up to fire it (the longest is an hour).
    if (ctx.turnRunning || ctx.vendorBackground.busy || observer.attachedCount > 0 || existingSessionAgents(agentSession)?.running() || agentSession.notifications.length || agentSession.wakeups.size) return;
    // A turn parked for a quota reset: this worker is what sends it.
    if (ctx.resumeWaiter.pending) return;
    // A vendor kept running for its own background work (held-vendor.ts):
    // idling out would close it and stop that work unreported. It is
    // bounded by its own ceiling; once it is gone the idle clock starts.
    if (hasHeldVendorProcess(sessionId)) {
      if (!awaitingHeldVendor) {
        awaitingHeldVendor = true;
        void whenHeldVendorGone(sessionId).then(() => { awaitingHeldVendor = false; scheduleIdleExit(); });
      }
      return;
    }
    if (runningShellCount(agentSession) > 0) {
      const oldest = Math.min(...[...agentSession.shells.values()].filter((shell) => shell.status === 'running').map((shell) => shell.startedAt));
      ctx.idleTimer = setTimeout(stopAbandonedShells, Math.max(0, oldest + ABANDONED_SHELL_MS - Date.now()));
      ctx.idleTimer.unref();
      return;
    }
    ctx.idleTimer = setTimeout(() => { void idleReached(); }, IDLE_EXIT_MS);
    ctx.idleTimer.unref();
  };

  /** When a turn -- the user's or the vendor's own -- last ended, for the
   * vendor's idle close (VENDOR_IDLE_CLOSE_MS). */
  let vendorUsedAt = Date.now();
  let vendorIdleTimer: NodeJS.Timeout | undefined;
  const armVendorIdle = (delayMs: number): void => {
    if (vendorIdleTimer) clearTimeout(vendorIdleTimer);
    vendorIdleTimer = setTimeout(() => { vendorIdleTimer = undefined; void vendorIdleReached(); }, delayMs);
    vendorIdleTimer.unref();
  };
  const vendorUsed = (): void => {
    vendorUsedAt = Date.now();
    armVendorIdle(VENDOR_IDLE_CLOSE_MS);
  };
  const vendorIdleReached = async (): Promise<void> => {
    const work = await persistentWorkRunning(sessionId);
    // Read after the wait: a turn may have started meanwhile.
    const idleForMs = Date.now() - vendorUsedAt;
    const decision = vendorIdleDecision({
      transportOpen: hasPersistentTransport(sessionId), turnRunning: ctx.turnRunning || ctx.draining, backgroundTurn: ctx.vendorBackground.busy,
      vendorWork: work || hasHeldVendorProcess(sessionId), pendingRequests: observer.pendingRequestCount,
      idleForMs, closeAfterMs: VENDOR_IDLE_CLOSE_MS,
    });
    // A turn's end arms it again; nothing to close leaves it unarmed.
    if (decision === 'none') return;
    if (decision === 'later') { armVendorIdle(idleForMs < VENDOR_IDLE_CLOSE_MS ? VENDOR_IDLE_CLOSE_MS - idleForMs : VENDOR_WORK_RECHECK_MS); return; }
    lifecycle('vendor.idle-close', { idleMs: idleForMs, clients: observer.attachedCount });
    await closePersistentTransport(sessionId);
  };

  /** When the vendor's background work began to hold this worker up. */
  let vendorWorkSince: number | undefined;
  /** Idle time is up. A persistent vendor still running work it started (a
   * background shell under ACP, Codex items) keeps the worker -- and so the
   * vendor -- up until that work ends, then the idle clock starts again;
   * bounded like a background shell (ABANDONED_SHELL_MS). */
  const idleReached = async (): Promise<void> => {
    ctx.idleTimer = undefined;
    if (ctx.homeGone()) { void ctx.shutdown('its ClikCode home was removed'); return; }
    const running = await persistentWorkRunning(sessionId);
    // Something happened meanwhile (a turn, a window): its own edge re-arms.
    if (ctx.idleTimer || ctx.turnRunning || ctx.draining || observer.attachedCount > 0 || ctx.resumeWaiter.pending) return;
    const decision = idleDecision({ workRunning: running, workSince: vendorWorkSince, now: Date.now(), ceilingMs: ABANDONED_SHELL_MS });
    noteIdle(decision === 'recheck' ? 'held: the vendor is still running work it started' : `idle reached: ${decision}`);
    if (decision === 'recheck') {
      vendorWorkSince ??= Date.now();
      ctx.idleTimer = setTimeout(() => { void idleReached(); }, VENDOR_WORK_RECHECK_MS);
      ctx.idleTimer.unref();
      return;
    }
    vendorWorkSince = undefined;
    // Past the ceiling: shutdown tells the model the work was stopped, and why.
    if (decision === 'stop-work') { void ctx.shutdown('the work was still running 24 hours after it started, with no ClikCode window open'); return; }
    // The work just ended: a whole idle period from now, not what was left.
    if (decision === 'fresh-idle') { scheduleIdleExit(); return; }
    void ctx.shutdown('idle timeout');
  };

  /** Stops each shell past the ceiling. Each one's exit then arrives as a
   * notification like any other, and is delivered the same way. */
  const stopAbandonedShells = (): void => {
    const cutoff = Date.now() - ABANDONED_SHELL_MS;
    for (const shell of agentSession.shells.values()) {
      if (shell.status === 'running' && shell.startedAt <= cutoff) stopBackgroundShell(shell, 'still running 24 hours after it started, with no ClikCode window open');
    }
    scheduleIdleExit();
  };
  return { retireBlocker, retireIfFree, leaveIfStaleBuild, noteIdle, scheduleIdleExit, vendorUsed };
}

export type IdleControl = ReturnType<typeof createIdleControl>;
