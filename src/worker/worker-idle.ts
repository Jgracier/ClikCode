/** The worker's idle exit, vendor idle close and build-watch retirement: the
 * timers and the rules for when each lets the worker go. */
import { lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { existingSessionAgents } from '../agent/background-agents.js';
import { idleDecision, vendorIdleDecision } from './idle-decisions.js';
import { hasHeldVendorProcess, whenHeldVendorGone } from '../harness/transport/native/held-vendor.js';
import { ABANDONED_WORK_MS } from '../harness/transport/persistent-session.js';
import { closePersistentTransport, hasPersistentTransport, persistentWorkRunning } from '../turn/vendor-process.js';
import { runningShellCount } from '../agent/session-state.js';
import { stopBackgroundShell } from '../agent/tools/bash.js';
import { currentWorkerBuild } from './registry.js';
import { BUILD_WATCH_MS, RETIRE_QUIET_MS } from './build-retire.js';
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
/** How often an idle worker looks for a newer build, and how long it must be quiet before one
 * replaces it: build-retire.ts, as the editor's bridge uses the same two. */
export { BUILD_WATCH_MS, RETIRE_QUIET_MS };

/** A background shell keeps an otherwise idle worker alive -- its exit is
 * owed to the model -- but not for ever: this long after it started, with
 * nobody attached and no turn running, it is stopped, and the model is told
 * so like any other exit. The same ceiling as work a retired vendor process
 * runs on (persistent-session.ts). */
const ABANDONED_SHELL_MS = ABANDONED_WORK_MS;
/** How often a worker that reached its idle time looks again at vendor work
 * still running between turns (a process's exit gives no event to another
 * process's parent). */
const VENDOR_WORK_RECHECK_MS = 30 * 1000;
/** No turn for this long: the persistent vendor (Codex app-server, an ACP
 * agent) and the MCP servers it started are closed, even with a window
 * open -- they are most of a conversation's memory. The worker stays; the
 * next turn starts the vendor again and resumes its thread natively.
 */
const VENDOR_IDLE_CLOSE_MS = 15 * 60 * 1000;

/** What can hold a worker (heldReason). */
const HELD = {
  turn: 'a turn is running', vendorBackground: 'vendor background work is running', vendorWork: 'the vendor is still running work it started',
  agents: 'background agents are running', notification: 'a notification is on its way to the model', wakeup: 'a scheduled wakeup is pending',
  quotaWait: 'waiting for a quota reset', heldVendor: 'a vendor is still finishing its background work', shell: 'a background shell is running',
  cacheWarm: 'keeping the prompt cache warm', queuedTurn: 'a queued message is about to be sent',
} as const;

export function createIdleControl(ctx: WorkerContext) {
  const { observer, sessionId, agentSession } = ctx;
  /** The ONE list of what holds this worker: the first reason, or undefined
   * when nothing does. Anything it is doing for the conversation counts -- a
   * turn, vendor background work, a shell, a notification or a wakeup the
   * model is owed -- because replacing it or exiting would lose that work.
   * The two callers differ in exactly three entries, each deliberately:
   *  - 'retire' (replacing for a newer build): the queue being drained counts
   *    (a notification turn is about to start); windows do not (an idle window
   *    attaches to the replacement); a parked quota-reset wait does not (the
   *    successor sends it, startsSuccessor); vendor work the idle check found
   *    still running (vendorWorkSince) counts, as the vendor would be closed.
   *  - 'idle' (the idle exit): windows and the quota-reset wait count; the
   *    queue being drained does not (idleReached re-checks it after its wait
   *    and a finished drain that starts no turn would leave no timer armed);
   *    vendorWorkSince does not (the recheck timer it describes is the one
   *    scheduleIdleExit is about to replace).
   * Held vendor and shells come last: the idle caller arms special waits for
   * exactly those two once nothing earlier holds the worker. */
  const heldReason = (scope: 'retire' | 'idle'): string | undefined => {
    const retire = scope === 'retire';
    // A submit accepted and not yet answered is a turn about to start: retiring now would drop it.
    if (ctx.turnRunning || ctx.submitsInFlight > 0 || (retire && ctx.draining)) return HELD.turn;
    if (ctx.vendorBackground.busy || ctx.outOfTurn.active) return HELD.vendorBackground;
    if (!retire && observer.attachedCount > 0) return `${observer.attachedCount} window(s) attached`;
    if (retire && vendorWorkSince !== undefined) return HELD.vendorWork;
    if (existingSessionAgents(agentSession)?.running()) return HELD.agents;
    if (agentSession.notifications.length) return HELD.notification;
    // A message queued for this worker to send (worker-queue.ts drainQueue): exiting would strand it until someone reopens the chat. A successor sends it when this worker is replaced.
    if (!retire && ctx.queuedUserTurn) return HELD.queuedTurn;
    if (agentSession.wakeups.size) return HELD.wakeup;
    if (!retire && ctx.resumeWaiter.pending) return HELD.quotaWait;
    if (hasHeldVendorProcess(sessionId)) return HELD.heldVendor;
    if (runningShellCount(agentSession) > 0) return HELD.shell;
    // Pings are pending (cache-keepwarm.ts): this worker sends them. Only the idle exit waits for them; a rebuild may replace the worker (its successor takes them up).
    if (!retire && ctx.keepWarm?.active()) return HELD.cacheWarm;
    return undefined;
  };
  const retireBlocker = (): string | undefined => heldReason('retire');

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
  let quietTimer: NodeJS.Timeout | undefined;
  /** How much longer until this worker has been quiet for RETIRE_QUIET_MS (0: it has). */
  const quietLeft = (): number => Math.max(0, observer.lastActivityAt + RETIRE_QUIET_MS - Date.now());
  const retireIfFree = (): void => {
    const left = quietLeft();
    if (left > 0) {
      // Not yet quiet: looked at again once it could be. Whatever happens meanwhile pushes it on.
      noteIdle('held: replacing for the newer build once it is quiet');
      if (!quietTimer) {
        quietTimer = setTimeout(() => { quietTimer = undefined; if (ctx.retireWhenIdle) retireIfFree(); else leaveIfStaleBuild(); }, left);
        quietTimer.unref();
      }
      return;
    }
    retireCheck ??= (async () => {
      const running = await persistentWorkRunning(sessionId);
      // Something started meanwhile: its own edge checks again.
      if (retireBlocker() || quietLeft() > 0) return;
      if (running) { noteIdle('held: retiring once the vendor\'s work ends'); return; }
      void ctx.shutdown('replaced by a newer ClikCode build');
    })().catch(quiet('worker/worker-idle')).finally(() => { retireCheck = undefined; });
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
  /** Idle means no client, no turn, no background shell whose exit the
   * model is still owed, and no notification on its way to it. A running
   * shell instead arms the abandoned-shell ceiling (ABANDONED_SHELL_MS). */
  const scheduleIdleExit = (): void => {
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
    ctx.idleTimer = undefined;
    const held = heldReason('idle');
    noteIdle(held ? `held: ${held}` : `idle: exits in ${Math.round(IDLE_EXIT_MS / 1000)}s`);
    // A newer build asked for this worker while it was busy: the moment it is
    // not, it goes, and the next window to need one starts that build.
    if (ctx.retireWhenIdle && !retireBlocker()) retireIfFree();
    else leaveIfStaleBuild();
    // A vendor kept running for its own background work (held-vendor.ts):
    // idling out would close it and stop that work unreported. It is
    // bounded by its own ceiling; once it is gone the idle clock starts.
    if (held === HELD.heldVendor) {
      if (!awaitingHeldVendor) {
        awaitingHeldVendor = true;
        void whenHeldVendorGone(sessionId).then(() => { awaitingHeldVendor = false; scheduleIdleExit(); });
      }
      return;
    }
    // A running shell instead arms the abandoned-shell ceiling. (Not covered by
    // idleDecision's ceiling, which only bounds the vendor's own work.)
    if (held === HELD.shell) {
      const oldest = Math.min(...[...agentSession.shells.values()].filter((shell) => shell.status === 'running').map((shell) => shell.startedAt));
      ctx.idleTimer = setTimeout(stopAbandonedShells, Math.max(0, oldest + ABANDONED_SHELL_MS - Date.now()));
      ctx.idleTimer.unref();
      return;
    }
    // Everything else (a turn, windows, agents, a notification or wakeup owed
    // to the model, a parked quota reset this worker sends) just holds it.
    if (held) return;
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
  return { heldReason, retireBlocker, retireIfFree, leaveIfStaleBuild, noteIdle, scheduleIdleExit, vendorUsed };
}

export type IdleControl = ReturnType<typeof createIdleControl>;
