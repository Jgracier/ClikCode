/** The worker process itself: one per active conversation, owning turn
 * execution and exiting on its own once genuinely idle and unwatched.
 *
 * Spawned detached (`spawnSessionWorker` in client.ts), with no TTY of its
 * own -- everything here operates on HarnessSession/HarnessState, never a
 * terminal, which is what makes "a client disconnects" an ordinary event
 * instead of something to survive with signal-ignoring tricks the way the
 * single-process design this replaces needed (see the SIGHUP/SIGINT block
 * this is meant to eventually make deletable, commands/ai/interactive.ts).
 *
 * This file builds the worker and wires its parts, which share one
 * WorkerContext (worker-context.ts): worker-io (reading the conversation),
 * worker-idle (idle exit, vendor idle close, retirement), worker-queue
 * (queued turns and `submit`), worker-turn (one turn), worker-commands and
 * worker-live-commands (what windows send), worker-server (the socket) and
 * worker-shutdown.
 */
import { lifecycle } from '../runtime/lifecycle-log.js';
import { LEGACY_INTERRUPTED_TURN_REQUEST } from '../turn/failover-prompt.js';
import { statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import Conf from 'conf';
import { readState } from '../session/state/read.js';
import { setOutOfTurnHandler, setVendorBackgroundTurnHandler } from '../turn/vendor-process.js';
import { BroadcastObserver } from './broadcast-observer.js';
import { createVendorBackgroundRunner } from './vendor-background.js';
import { createResumeWaiter } from './resume-wait.js';
import { installSystemdRunShim, separateFromForeground } from './own-scope.js';
import { startResourceGuard } from './resource-guard.js';
import { createCommandSweep } from './command-groups.js';
import { useConversationTmp } from './conversation-tmp.js';
import { startDiskWatch } from './disk-watch.js';
import { startIdleServices } from './idle-services.js';
import { startStateSweep } from './state-sweep.js';
import { startStuckWatchdog } from './stuck-watchdog.js';
import { LiveSettings } from '../turn/live-settings.js';
import { sessionState } from '../agent/session-state.js';
import { stateDirectory } from '../session/store/paths.js';
import { generateWorkerToken, socketPathFor, takeConversation, workerIsReachable, writeWorkerRecord, currentWorkerBuild, type ConversationHold, type WorkerRuntimeRecord } from './registry.js';
import type { ConnectionState, WorkerContext } from './worker-context.js';
import { createWorkerIo } from './worker-io.js';
import { BUILD_WATCH_MS, createIdleControl } from './worker-idle.js';
import { createWorkerQueue } from './worker-queue.js';
import { createTurnRunner } from './worker-turn.js';
import { createCommandHandler } from './worker-commands.js';
import { createWorkerServer } from './worker-server.js';
import { reconcileAgents } from '../agent/agent-registry.js';
import { createShutdown } from './worker-shutdown.js';
import { createOutOfTurnRelay } from './out-of-turn.js';
import { createResourceNoteDelivery } from './resource-note-delivery.js';

/** This conversation for this worker, or undefined when another worker has
 * it. A scripted turn running in-process (worker/scripted-send.ts) is waited
 * out: its conversation comes to a worker the moment it ends. */
/** A command is in a group of its own within this long of starting. */
const COMMAND_SWEEP_MS = 1_000;

async function ownConversation(sessionId: string): Promise<ConversationHold | undefined> {
  for (;;) {
    const taken = await takeConversation(sessionId, 'worker');
    if ('hold' in taken) return taken.hold;
    if (taken.holder.kind === 'worker') return undefined;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

export async function runSessionWorker(sessionId: string): Promise<void> {
  const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  const state = await readState({ transcripts: [sessionId] });
  const session = state.sessions.find((item) => item.id === sessionId);
  // Deleted (or never stored) before this worker got here: nothing to run,
  // which is not a crash.
  if (!session) { lifecycle('worker.no-session'); return; }

  // Two windows that both found no worker each spawn one: the second to get
  // here exits, and the spawning window finds the first by its record.
  const hold = await ownConversation(sessionId);
  if (!hold) return;
  // Before any vendor process exists, so all of the agent's work is born
  // outside the window that spawned this worker (own-scope.ts).
  const placement = await separateFromForeground(sessionId);
  if (process.platform === 'linux' && process.env.CLIKCODE_OWN_SCOPE !== '0') installSystemdRunShim();
  // Temp files on disk, not in RAM-backed /tmp, for everything the agent runs.
  useConversationTmp(sessionId);
  // What ClikCode leaves under its own state directory is removed when old (worker/state-sweep.ts).
  startStateSweep();
  const socketPath = socketPathFor(sessionId);
  // A worker from a build before the hold existed takes none, and still
  // answers: it keeps the conversation. Anything else at the path is left
  // over from a worker that is gone, and binding over it is safe.
  if (await workerIsReachable(socketPath)) { await hold.release(); return; }
  await unlink(socketPath).catch(() => undefined);
  const observer = new BroadcastObserver();
  observer.sessionId = sessionId;
  const token = generateWorkerToken();
  /** The state directory this worker started in, by identity. A path that
   * exists again is not the same home: the worker's own writes (a log, a
   * record) recreate a deleted one, which made a path check pass for the
   * whole idle time while the sandbox that owned it was long gone. */
  const homeIdentity = (): string | undefined => {
    try { const stat = statSync(stateDirectory()); return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; } catch { return undefined; }
  };
  const startedHome = homeIdentity();

  const ctx = {
    sessionId, config, observer, token, hold, socketPath,
    agentSession: sessionState(stateDirectory(), sessionId),
    liveSettings: new LiveSettings(session),
    connections: new Map<ConnectionState['socket'], ConnectionState>(),
    homeGone: () => homeIdentity() !== startedHome,
    spawnedBuild: currentWorkerBuild(),
    turnRunning: false, activeQueuedTurnId: undefined, draining: false, stalledQueuedTurnId: undefined,
    idleTimer: undefined, activeController: undefined, activeLiveInput: undefined, activeSubmissions: undefined,
    activeRestoreDraft: undefined, submitsInFlight: 0, pendingCancel: undefined, stopAnnounced: false, resumingTurn: false, retireWhenIdle: false, recordWrite: Promise.resolve(),
  } as Omit<WorkerContext, 'vendorBackground' | 'outOfTurn' | 'resumeWaiter' | 'io' | 'idle' | 'queue' | 'runTurn' | 'shutdown' | 'server'> as WorkerContext;
  ctx.io = createWorkerIo(ctx);

  // --- Vendor background turns (persistent transports) -------------------
  // Work a Codex app-server or ACP agent does between turns: broadcast,
  // persisted, and keeping this worker alive while it runs. See
  // worker/vendor-background.ts. Kept to this block, settled() before a
  // turn, saveSuperseded() and userTurnEnded() in the turn's end, and
  // `vendorBackground.busy` in scheduleIdleExit.
  ctx.vendorBackground = createVendorBackgroundRunner({
    sessionId, observer, userTurnRunning: () => ctx.turnRunning, changed: () => { ctx.idle.vendorUsed(); ctx.idle.scheduleIdleExit(); },
  });
  ctx.outOfTurn = createOutOfTurnRelay(ctx);
  // What the vendor was saying on its own is saved, and its live view ended, before its own turn takes the windows.
  setVendorBackgroundTurnHandler(sessionId, (turn) => { void ctx.outOfTurn.settle().then(() => ctx.vendorBackground.handle(turn)); });
  setOutOfTurnHandler(sessionId, ctx.outOfTurn.relay);
  // -------------------------------------------------------------------------
  ctx.idle = createIdleControl(ctx);

  /** A turn parked until the quota resets (worker/resume-wait.ts): sent from
   * here once it has, once. `resumingTurn` marks that turn for the turn runner. */
  ctx.resumeWaiter = createResumeWaiter({
    sessionId, turnRunning: () => ctx.turnRunning || ctx.draining, notice: ctx.io.note, changed: () => ctx.idle.scheduleIdleExit(),
    send: async (prompt) => {
      // A wait an older build parked holds its continuation line, which is
      // never sent: the turn's own request is.
      const text = prompt === LEGACY_INTERRUPTED_TURN_REQUEST
        ? (await readState({ transcripts: [sessionId] })).sessions.find((item) => item.id === sessionId)?.pendingTurn?.prompt ?? prompt
        : prompt;
      ctx.resumingTurn = true;
      if (!ctx.queue.startTurn({ type: 'submit', text, echo: true })) ctx.resumingTurn = false;
    },
  });
  ctx.queue = createWorkerQueue(ctx);
  ctx.runTurn = createTurnRunner(ctx);
  ctx.agentSession.onNotification = () => { void ctx.queue.deliverNotifications(); };
  ctx.server = createWorkerServer(ctx, createCommandHandler(ctx));
  ctx.shutdown = createShutdown(ctx);
  // A loop of its own that never yields would keep this worker -- and what it
  // holds -- forever: a thread ends it (worker/stuck-watchdog.ts).
  startStuckWatchdog(sessionId);
  // Memory: a nudge near the machine's limit, the largest command stopped
  // past it, and this conversation's agent told either way -- into the turn
  // running now, or with the next one (worker/resource-guard.ts). The same
  // channel tells it when the disk is getting full (worker/disk-watch.ts).
  {
    const deliverNote = createResourceNoteDelivery(ctx);
    // One cgroup per command the agent runs, so the guard reads and stops
    // exactly a command (worker/command-groups.ts).
    const commands = placement?.divided ? createCommandSweep(placement.scopeDir) : undefined;
    if (commands) setInterval(() => { try { commands.sweep(); } catch { /* fail-open-ok: next sweep */ } }, COMMAND_SWEEP_MS).unref();
    startResourceGuard({
      sessionId,
      ...(placement?.divided ? { sliceDir: placement.sliceDir, remembered: { scopeDir: placement.scopeDir, labels: commands!.labels } } : {}),
      deliver: deliverNote,
    });
    startDiskWatch({ sessionId, paths: [stateDirectory(), session.workspace], deliver: deliverNote });
    if (placement?.divided) startIdleServices({ sessionId, sliceDir: placement.sliceDir, deliver: deliverNote });
  }

  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      ctx.server.once('error', rejectListening);
      ctx.server.listen(socketPath, resolveListening);
    });
  } catch (error) {
    await hold.release();
    throw error;
  }
  const record = {
    pid: process.pid, sessionId, socketPath, installationId: state.installationId, startedAt: new Date().toISOString(), token,
    ...(currentWorkerBuild() ? { build: currentWorkerBuild() } : {}),
  };
  await writeWorkerRecord(record);
  // Agents a worker that died left running: their work is committed to their branches, and the model hears of it.
  void reconcileAgents(stateDirectory(), sessionId).then(async (reports) => {
    if (!reports.length) return;
    await ctx.io.recordNotifications(reports.map((entry) => ({ kind: 'agent' as const, shellId: entry.id, command: entry.label, tail: entry.report, reason: 'interrupted', at: Date.now() })));
    await ctx.queue.deliverNotifications();
  }).catch(() => undefined);
  // The record carries what a list needs to say about this conversation: an approval it waits on,
  // and background work still running. Each change rewrites the whole of it.
  let awaiting: { title: string; since: string } | undefined;
  let background: WorkerRuntimeRecord['background'];
  const rewriteRecord = (): Promise<void> => {
    ctx.recordWrite = ctx.recordWrite
      .then(() => writeWorkerRecord({ ...record, ...(awaiting ? { awaitingApproval: awaiting } : {}), ...(background ? { background } : {}) }, { existing: true }))
      .catch(() => undefined);
    return ctx.recordWrite;
  };
  observer.onAwaitingApproval = (awaitingApproval) => { awaiting = awaitingApproval; return rewriteRecord(); };
  observer.onBackgroundWork = (work) => {
    const counts = (value: { agents?: number; terminals?: number; workflows?: number } | undefined): string => `${value?.agents ?? 0}/${value?.terminals ?? 0}/${value?.workflows ?? 0}`;
    if (counts(work) === counts(background)) return undefined;
    background = work ? { ...work, since: background?.since ?? new Date().toISOString() } : undefined;
    return rewriteRecord();
  };
  process.on('SIGTERM', () => { void ctx.shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void ctx.shutdown('SIGINT'); });
  ctx.idle.scheduleIdleExit();
  // A rebuild while this worker sits idle with nobody attached: scheduleIdleExit
  // only runs on attach/detach/turn edges otherwise, so without this a stale
  // worker would wait out the full idle timeout before noticing. This checks
  // the build only: re-arming the idle timer here would restart it every
  // tick, and it would never fire.
  const buildWatch = setInterval(() => {
    // A home that is gone (a test run's, cleaned up) has no conversation to
    // serve or save: whatever this worker was waiting on, it leaves. Two
    // workers lived for days this way, each holding its MCP servers.
    if (ctx.homeGone()) { void ctx.shutdown('its ClikCode home was removed'); return; }
    ctx.idle.leaveIfStaleBuild();
  }, BUILD_WATCH_MS);
  buildWatch.unref();
  // A notification a previous worker recorded but never ran.
  void ctx.queue.drainQueue().catch(ctx.queue.reportDrainFailure);
  // A turn parked for the reset by a window, or left by a worker before this.
  void ctx.resumeWaiter.check();
}
