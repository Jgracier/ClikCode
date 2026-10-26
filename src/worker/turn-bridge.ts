/** Running one interactive turn through a session worker instead of
 * in-process -- the actual Phase 3 cutover point. Everything before this
 * file (protocol, registry, the worker itself) was additive and provably
 * inert; this is the first thing that changes what a live terminal does.
 *
 * Deliberately narrow: this owns exactly the same sequence
 * commands/ai/interactive.ts's runInteractiveTurn already runs -- paint the
 * pending message, start waiting, run the turn, stop waiting -- translating
 * each TurnObserver-shaped WorkerEvent into the identical TerminalHarness-
 * Prompter method call the turn would have made directly in the old,
 * single-process model. rl cannot tell the difference (see turn/observer.ts
 * for why that is true by construction, not by care taken here).
 */
import { backgroundWorkOf, type BackgroundWork } from '../harness/protocol/background-agents.js';
import type { HarnessQuestionResult } from '../harness/events/question.js';
import { REVEAL_MAX_HOLD_MS } from '../harness/protocol/reveal-pace.js';
import { diagnostic, lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { randomUUID } from 'node:crypto';
import { commandDuringTurn } from '../tui/slash/queue.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';
import { WorkerClient } from './client.js';
import { workersDirectory } from './registry.js';
import { watchConversationList } from '../session/list-watch.js';
import { stateDirectory } from '../session/store/paths.js';
import { cancelOrigin, isTranscriptActivity, type CancelOrigin, type LiveActivity, type LiveThought, type WorkerEvent } from './protocol.js';
import type { PlanEntry } from '../tui/render/plan-block.js';
import type { HarnessSession, TurnMark } from '../session/model.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { joinedAnswerText } from '../turn/live-answer.js';
import { upsertMark } from '../turn/turn-marks.js';
import { drawJoinedTurn } from './joined-turn.js';
import { withSignIn } from '../commands/account.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import type { TakeBackOutcome } from '../turn/live-input.js';
import { readState } from '../session/state/read.js';
import { liveSettingsOf } from '../turn/live-settings.js';
import { sessionTranscriptMessages } from '../turn/checkpoint.js';

interface WorkerTurnRequest {
  echo: boolean;
  queuedTurnId?: string;
  /** The window's latency clock for this turn (runtime/turn-latency.ts). */
  turnId?: string;
  submittedAt?: number;
}

/** One WorkerClient per session, reused across every turn for as long as
 * this interactive process runs -- attaching fresh per turn would work (a
 * worker happily answers any number of attaches) but would re-pay the
 * snapshot round-trip on every single message for no reason. Cleared by
 * closeAllWorkerClients() when the interactive loop ends. */
const clients = new Map<string, WorkerClient>();

/** Messages typed during a turn, waiting for the worker to say what happened
 * to them. The worker always answers; losing its connection is the only other end. */
const pendingSubmissions = new Map<string, (event: Extract<WorkerEvent, { type: 'submission' }>) => void>();
const pendingSubagentReads = new Map<string, (rows: import('../harness/subagent-read.js').SubAgentRow[]) => void>();

/** The worker's answer, or `onClosed` if its connection ends first. */
async function answeredOrClosed<T>(client: WorkerClient, answered: Promise<T>, onClosed: T): Promise<T> {
  let onClose: (() => void) | undefined;
  const closed = new Promise<T>((resolveClosed) => { onClose = () => resolveClosed(onClosed); client.once('close', onClose); });
  try { return await Promise.race([answered, closed]); } finally { if (onClose) client.off('close', onClose); }
}
/** Messages being taken back (Esc), waiting for the worker's `unqueued`. */
const pendingTakeBacks = new Map<string, (outcome: TakeBackOutcome) => void>();

/** What this window knows of its worker, from a listener that stays on the
 * connection for its whole life: whether a turn is running (whoever started
 * it) and with what prompt, and a wake-up for a window sitting at its
 * prompt. The turn listener below comes and goes with each turn; this does
 * not, so nothing the worker starts on its own is missed. */
interface WorkerTracker {
  running: boolean;
  prompt?: string;
  /** The running turn as far as it has got -- text, tool rows, plan -- so a
   * window that joins it, or comes back to it, draws all of it (showLive). */
  liveText: string;
  activities: LiveActivity[];
  plan: readonly PlanEntry[];
  /** The rest of what an attached window has drawn (LiveTurn): the turn's
   * settled thoughts, notices and decisions, the thought being had, the
   * phase and the usage so far. */
  marks: TurnMark[];
  /** Marks learned of without the worker's numbering (joined-turn.ts). */
  unsequenced: string[];
  thought?: LiveThought;
  phase?: string;
  usage?: TurnUsage;
  /** What the vendor says runs in the background, by kind (a level). */
  background?: BackgroundWork;
  /** The followed turn is the vendor's own background work (waiting-start `vendorWork`). */
  vendorWork?: boolean;
  wake?: (reason: 'turn' | 'queue') => void;
  /** Counts queue-changed events, so a change that lands between the loop
   * reading the queue and its prompt opening is not missed (workerQueueMark). */
  queueVersion: number;
  /** A turn is being shown (driveWorkerTurn), which answers requests itself. */
  driving: boolean;
  /** Approvals and sign-ins asked while no turn was being shown -- re-offered
   * on attach, or asked of a window still at its prompt -- for the turn view
   * to answer once it opens. */
  unanswered: WorkerEvent[];
}
const trackers = new WeakMap<WorkerClient, WorkerTracker>();
const connecting = new Map<string, Promise<WorkerClient | undefined>>();

function track(sessionId: string, client: WorkerClient): void {
  const tracker: WorkerTracker = { running: false, liveText: '', activities: [], plan: [], marks: [], unsequenced: [], driving: false, unanswered: [], queueVersion: 0 };
  trackers.set(client, tracker);
  // A worker older than this client names no prompt and sends text only; it
  // still says a turn is live, and that is what matters most here.
  const joinLive = (live: NonNullable<Extract<WorkerEvent, { type: 'snapshot' }>['live']>, session: HarnessSession): void => {
    // The journal is written on a debounce and can lag the live text: the
    // longer copy stands, the same whichever arrived first (live-answer.ts).
    const journal = session.pendingTurn;
    const sameTurn = journal && (live.prompt === undefined || journal.prompt.trim() === live.prompt.trim());
    Object.assign(tracker, {
      running: true, prompt: live.prompt ?? tracker.prompt,
      liveText: joinedAnswerText(sameTurn ? journal.response : undefined, live.text),
      ...(live.activities ? { activities: [...live.activities] } : {}), ...(live.plan ? { plan: live.plan } : {}),
      // The snapshot is the whole truth about these: what it lacks, the turn
      // has not got.
      marks: live.marks ? [...live.marks] : [], unsequenced: [], thought: live.thought, phase: live.phase, usage: live.usage,
      background: backgroundWorkOf(live), vendorWork: live.vendorWork === true,
    });
  };
  const initial = client.initialEvent;
  if (initial?.type === 'snapshot') {
    if (initial.live) joinLive(initial.live, initial.session);
    tracker.background = initial.background ?? backgroundWorkOf(initial.live);
  }
  // Registered before any turn's own listener (driveWorkerTurn), so that one
  // always sees this record already up to date with the event it is handling.
  client.on('event', (event: WorkerEvent) => {
    if (event.type === 'waiting-start') {
      Object.assign(tracker, {
        running: true, prompt: event.prompt, liveText: '', activities: [], plan: [], marks: [], unsequenced: [],
        thought: undefined, phase: undefined, usage: undefined, background: tracker.background, vendorWork: event.vendorWork === true,
      });
      tracker.wake?.('turn');
    } else if (event.type === 'waiting-stop') {
      tracker.running = false;
      tracker.unanswered = [];
    } else if (event.type === 'approval-request' || event.type === 'question-request' || event.type === 'sign-in-request') {
      if (!tracker.driving) tracker.unanswered.push(event);
    } else if (event.type === 'request-closed') {
      // A decision leaves its row where it was asked -- for a window that was
      // not the one to answer it (one that is, drew it itself). Asked while
      // no turn view was open, it was never answered here.
      const unseen = !tracker.driving && tracker.unanswered.some((held) => 'id' in held && held.id === event.id);
      tracker.unanswered = tracker.unanswered.filter((held) => !('id' in held && held.id === event.id));
      if (unseen) recordDecision(tracker, event);
    } else if (event.type === 'snapshot') {
      if (event.live) joinLive(event.live, event.session);
      // A snapshot without `live` says nothing is running: it holds the finished turn (the worker sends
      // `live` for as long as a turn's record is unfinished). Left running until waiting-stop, this
      // window's prompt would follow the same turn again and draw it a second time.
      else tracker.running = false;
      tracker.background = event.background ?? backgroundWorkOf(event.live);
    } else if (event.type === 'delta') {
      tracker.liveText = event.mode === 'replace' ? event.text : tracker.liveText + event.text;
    } else if (event.type === 'activity') {
      if (tracker.running && isTranscriptActivity(event.event)) tracker.activities.push({ event: event.event, responseOffset: tracker.liveText.length });
    } else if (event.type === 'plan') {
      if (tracker.running) tracker.plan = event.entries;
    } else if (event.type === 'note') {
      // A notice of the turn, where the worker placed it.
      if (tracker.running && event.seq !== undefined) {
        tracker.marks = upsertMark(tracker.marks, { kind: 'notice', id: `notice:${event.seq}`, seq: event.seq, responseOffset: event.responseOffset ?? tracker.liveText.length, message: event.message });
      }
    } else if (event.type === 'phase') {
      if (tracker.running) tracker.phase = event.message;
    } else if (event.type === 'usage') {
      if (tracker.running) tracker.usage = event.usage;
    } else if (event.type === 'background') {
      if (tracker.running) tracker.background = backgroundWorkOf({ background: event.work, pendingBackground: event.pending });
    } else if (event.type === 'out-of-turn') {
      // Said with no turn open: an idle prompt reads the conversation again to show it.
      tracker.queueVersion++;
      tracker.wake?.('queue');
    } else if (event.type === 'queue-changed') {
      tracker.queueVersion++;
      tracker.wake?.('queue');
    } else if (event.type === 'subagent') {
      pendingSubagentReads.get(event.id)?.(event.rows);
    } else if (event.type === 'submission') {
      // Here, not on the turn's own listener: that one goes at waiting-stop,
      // and an answer for a message typed as the turn ended can come after
      // it -- which left the message's row waiting out the full timeout.
      pendingSubmissions.get(event.id)?.(event);
    } else if (event.type === 'unqueued') {
      pendingTakeBacks.get(event.id)?.(event.outcome);
    }
  });
  // A worker that exits (idle, retired) is attached afresh next time. A
  // window at its prompt asks again now, so it watches for the next worker
  // (askUntilWorker) instead of a connection that is gone.
  client.on('close', () => {
    if (clients.get(sessionId) === client) clients.delete(sessionId);
    tracker.wake?.('queue');
  });
}

async function connect(sessionId: string, spawn: boolean): Promise<WorkerClient | undefined> {
  const existing = clients.get(sessionId);
  if (existing) return existing;
  // One connection per session, however many callers race to make it.
  const pending = connecting.get(sessionId);
  if (pending) {
    const joined = await pending;
    if (joined || !spawn) return joined;
  }
  const attempt = (spawn ? WorkerClient.attach(sessionId) : WorkerClient.attachExisting(sessionId)).then((client) => {
    if (client) { clients.set(sessionId, client); track(sessionId, client); }
    return client;
  }).finally(() => connecting.delete(sessionId));
  connecting.set(sessionId, attempt);
  return attempt;
}

async function clientFor(sessionId: string): Promise<WorkerClient> {
  return (await connect(sessionId, true))!;
}

/** Have a conversation's worker get ready for the route it is on now -- see
 * the `prepare` command. `spawn: false` only reaches a worker this terminal
 * already has: a conversation that moved off an agent route needs its
 * servers stopped, but one that never had a worker has nothing to stop. */
export async function prepareSessionWorker(sessionId: string, options: { spawn: boolean }): Promise<void> {
  if (!options.spawn && !clients.has(sessionId)) return;
  (await clientFor(sessionId)).send({ type: 'prepare' });
}

/** This terminal changed what the conversation runs on: the worker re-sends
 * it to every window attached. Only to a worker already attached. */
export function refreshSessionWorker(sessionId: string): void {
  clients.get(sessionId)?.send({ type: 'refresh' });
}

/** This terminal changed model, effort, speed, permission mode or route (already
 * persisted): the worker holds them for the turn it may be running. Only to a
 * worker already attached. */
export function pushSessionSettings(session: HarnessSession): void {
  clients.get(session.id)?.send({ type: 'settings-changed', settings: liveSettingsOf(session) });
}

/** This terminal has left a conversation: its worker stops what it started
 * for it. The worker itself stays, so going back to it is instant. */
export function releaseSessionWorker(sessionId: string): void {
  clients.get(sessionId)?.send({ type: 'release' });
}

export async function closeAllWorkerClients(): Promise<void> {
  for (const client of clients.values()) { client.send({ type: 'detach' }); client.close(); }
  clients.clear();
}

/** The waiting band's cancel and submit callbacks, sent over the socket: the
 * worker owns the turn's AbortController and LiveTurnInputBroker.
 *
 * Returns `left` when Left was pressed to open the board. Whatever the
 * turn has to say is in the transcript already (a note of the turn). */
export async function runTurnThroughWorker(
  sessionId: string, rl: TerminalHarnessPrompter, promptText: string, turn: WorkerTurnRequest,
): Promise<{ left?: true }> {
  // The first message of a conversation waits on its worker starting; the
  // message and the spinner do not.
  if (!clients.has(sessionId)) rl.turnStarting();
  const client = await clientFor(sessionId).catch((error: unknown) => { rl.stopWaiting(); throw error; });
  return driveWorkerTurn(sessionId, client, rl, () => {
    client.send({
      type: 'submit', text: promptText, echo: turn.echo, ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}),
      ...(turn.turnId ? { turnId: turn.turnId } : {}), ...(turn.submittedAt !== undefined ? { submittedAt: turn.submittedAt } : {}),
    });
  });
}

/** What a window at its prompt should do instead of waiting for a key. */
type IdleWake = { line: string } | { woke: 'turn'; prompt?: string } | { woke: 'queue' };

/** Asks for the next line, unless the worker has something first: a turn it
 * is running that this window did not start (another window's, or a
 * follow-up for a finished background shell), or a change to the queue.
 * The window used to sit at its prompt through both, showing neither -- a
 * reopened conversation mid-turn looked idle, and a queued message waited
 * for a keypress. Attaches only to a worker that is already running. */
export async function questionOrWorker(sessionId: string, ask: (signal?: AbortSignal) => Promise<string>, queueMark?: number): Promise<IdleWake> {
  const client = await connect(sessionId, false).catch(quiet('worker/turn-bridge'));
  const tracker = client ? trackers.get(client) : undefined;
  if (!tracker) return askUntilWorker(sessionId, ask);
  if (tracker.running) return { woke: 'turn', ...(tracker.prompt !== undefined ? { prompt: tracker.prompt } : {}) };
  // The queue changed after the caller read it: read it again first. A mark
  // taken with no connection says nothing of what happened before this one
  // was made (a worker started since, by another window), so that queue is
  // read again too -- once: the next pass's mark is this connection's.
  if (queueMark !== undefined && tracker.queueVersion !== queueMark) return { woke: 'queue' };
  const controller = new AbortController();
  let reason: 'turn' | 'queue' | undefined;
  tracker.wake = (why) => { reason ??= why; controller.abort(); };
  try {
    return { line: await ask(controller.signal) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_PROMPT_INTERRUPTED' || !reason) throw error;
    return reason === 'turn' ? { woke: 'turn', ...(tracker.prompt !== undefined ? { prompt: tracker.prompt } : {}) } : { woke: 'queue' };
  } finally {
    tracker.wake = undefined;
  }
}

/** The prompt, while the conversation has no worker. Another window's
 * message starts one, and its turn must show here as well: the worker
 * registry is watched, and once this conversation's worker can be attached
 * the prompt ends (its draft kept) for the loop to ask again, attached --
 * following the turn from there. Without this, a window with no worker never
 * saw a turn another window started, nor any after a rebuild retired its
 * worker. */
async function askUntilWorker(sessionId: string, ask: (signal?: AbortSignal) => Promise<string>): Promise<IdleWake> {
  const controller = new AbortController();
  const watch = watchConversationList(() => {
    if (controller.signal.aborted) return;
    void connect(sessionId, false).catch(quiet('worker/turn-bridge')).then((client) => {
      if (client && !controller.signal.aborted) controller.abort();
    });
  }, { directories: [stateDirectory(), workersDirectory()] });
  try {
    return { line: await ask(controller.signal) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_PROMPT_INTERRUPTED' || !controller.signal.aborted) throw error;
    return { woke: 'queue' };
  } finally {
    watch.stop();
  }
}

/** Taken BEFORE reading the queue from state, and handed to questionOrWorker.
 * Attaches to a running worker first: a mark from no connection could not
 * count a change made while a window's first prompt was still connecting,
 * and that prompt then sat there with something queued. With no worker
 * running, UNATTACHED -- which questionOrWorker treats as already stale if
 * it does find one. */
export async function workerQueueMark(sessionId: string): Promise<number> {
  const client = await connect(sessionId, false).catch(quiet('worker/turn-bridge'));
  return (client ? trackers.get(client)?.queueVersion : undefined) ?? UNATTACHED;
}
const UNATTACHED = -1;

/** The settled row of a request another window decided, kept for any window
 * that draws this turn later. The worker's number for it is not in the
 * event, so it is kept unsequenced and read in arrival order. */
function recordDecision(tracker: WorkerTracker, event: Extract<WorkerEvent, { type: 'request-closed' }>): TurnMark | undefined {
  if (!tracker.running || !event.outcome || !event.label) return undefined;
  const id = `outcome:${event.id}`;
  const existing = tracker.marks.find((mark) => mark.id === id);
  if (existing) return undefined;
  const mark: TurnMark = { kind: 'outcome', id, seq: 0, responseOffset: tracker.liveText.length, outcome: event.outcome, label: event.label, ...(event.callId ? { callId: event.callId } : {}) };
  tracker.marks = [...tracker.marks, mark];
  tracker.unsequenced.push(id);
  return mark;
}

/** Draws the running turn as far as it has got. Safe to repeat: the text is
 * replaced, an activity the window already shows is skipped by its index,
 * and the plan is the latest. So a join, a return from the board and a
 * mid-turn snapshot all come to the same screen, whatever order they came in. */
function showLive(rl: TerminalHarnessPrompter, tracker: WorkerTracker): void {
  drawJoinedTurn(rl, tracker);
}

/** Whether the conversation's worker is running a turn right now, and with
 * what prompt (`{}` from a worker too old to name it) -- the worker's own
 * answer. The journal alone cannot say: a crashed worker leaves one behind on
 * purpose. Attaches to a running worker; never starts one. */
export async function workerTurn(sessionId: string): Promise<{ prompt?: string } | undefined> {
  const client = await connect(sessionId, false).catch(quiet('worker/turn-bridge'));
  const tracker = client ? trackers.get(client) : undefined;
  if (!tracker?.running) return undefined;
  return tracker.prompt !== undefined ? { prompt: tracker.prompt } : {};
}

/** Follows the turn the worker is running to its end, exactly as if this
 * window had sent it: what has streamed so far, then every event, with
 * cancel and typed messages going to the worker. */
export async function followWorkerTurn(
  sessionId: string, rl: TerminalHarnessPrompter,
  /** Where the turn already is when this window joins it: its real start, so
   * the timer is not reset to zero, and the call it is running now. */
  joined?: { startedAt?: number; activity?: string },
): Promise<{ left?: true }> {
  const client = clients.get(sessionId);
  const tracker = client ? trackers.get(client) : undefined;
  if (!client || !tracker?.running) return {};
  return driveWorkerTurn(sessionId, client, rl, () => {
    if (joined) rl.joinedWaiting(joined.startedAt, joined.activity);
    showLive(rl, tracker);
    // The first frame of a joined turn is the whole of it.
    rl.releasePaints?.();
  }, () => tracker.running);
}

async function driveWorkerTurn(
  sessionId: string, client: WorkerClient, rl: TerminalHarnessPrompter, begin: () => void, stillRunning?: () => boolean,
): Promise<{ left?: true }> {
  let left = false;
  /** The account the worker last named, for a render of this window's own. */
  let account: string | undefined;
  const tracker = trackers.get(client)!;
  tracker.driving = true;
  try {
    await new Promise<void>((resolveTurn, rejectTurn) => {
      let settled = false;
      // A caught turn failure is not, on its own, the end of the sequence:
      // the worker still sends a final render() and then waiting-stop after
      // it (see worker-turn.ts's runTurn `finally`), and tearing this
      // listener down the instant turn-error arrived meant that render
      // never reached here -- confirmed by a real test that failed on
      // exactly this ordering the first time this shipped, the same class
      // of bug as the render-vs-stopWaiting ordering fixed in the worker
      // itself moments earlier. waiting-stop is the one true end-of-turn
      // signal; a recorded error is only ever surfaced once it arrives.
      let pendingError: Error | undefined;
      const finish = (why: string, fn: () => void): void => {
        if (settled) return;
        settled = true;
        lifecycle('window.follow.end', { why });
        client.off('event', onEvent);
        client.off('close', onClose);
        fn();
      };
      /** Approvals and questions this window has open, closed by `request-closed`. */
      const openPrompts = new Map<string, AbortController>();
      const handle = (event: WorkerEvent): void => {
        if (settled) return;
        switch (event.type) {
          case 'snapshot':
            account = event.account;
            if (event.stopped) rl.turnStopped();
            // `live` says the worker still runs this turn, so its journal is
            // the live view's and is never drawn as ended; a snapshot without
            // it (the one that closes a turn) holds an interrupted one.
            rl.render(event.session, event.account, event.live ? { running: true, ...(event.live.prompt !== undefined ? { prompt: event.live.prompt } : {}) } : { running: false });
            rl.setSteerable(Boolean(event.live?.steerable));
            rl.setBackgroundWork?.(event.background ?? backgroundWorkOf(event.live));
            // The turn as far as it has got -- one this window did not start
            // (a queued message it is behind) included.
            if (event.live) showLive(rl, tracker);
            return;
          case 'delta':
            rl.response(event.text, event.mode);
            return;
          case 'activity': {
            // Numbered as the tracker (updated first) recorded it.
            const index = tracker.running && isTranscriptActivity(event.event) ? tracker.activities.length - 1 : -1;
            const live = tracker.activities[index];
            rl.activityEvent(event.event, live ? { index, responseOffset: live.responseOffset } : undefined);
            return;
          }
          case 'note':
            // Its number is the worker's mark id: a snapshot listing it is not a second row.
            rl.activity(event.message, event.seq !== undefined ? `notice:${event.seq}` : undefined);
            return;
          case 'phase':
            rl.phase(event.message);
            return;
          case 'plan':
            rl.setPlan(event.entries);
            return;
          // The status line's `↓ N tokens` meter reads the turn's usage so
          // far; the worker records it on the session (lastUsage) too.
          case 'usage':
            rl.setTurnUsage(event.usage);
            return;
          // The end line says agents and workflows from the saved turn
          // (turnEnd.background); a background terminal is a footer
          // indicator, drawn from here while any runs.
          case 'background':
            rl.setBackgroundWork?.(backgroundWorkOf({ background: event.work, pendingBackground: event.pending }));
            return;
          case 'approval-request': {
            const closing = new AbortController();
            openPrompts.set(event.id, closing);
            void rl.approval(event.title, event.detail, event.preview, event.rule, closing.signal, event.callId).then((approved) => {
              openPrompts.delete(event.id);
              // Decided here: the row is drawn by this window, not again from a snapshot.
              if (!closing.signal.aborted) { rl.markDrawn?.(`outcome:${event.id}`); client.send({ type: 'approval-response', id: event.id, approved }); }
            });
            return;
          }
          case 'question-request': {
            const closing = new AbortController();
            openPrompts.set(event.id, closing);
            // A terminal with no question surface cancels it, visibly: the worker's vendor never waits.
            const asked = rl.askQuestions ? rl.askQuestions(event.request, closing.signal)
              : Promise.resolve<HarnessQuestionResult>({ kind: 'cancelled' }).then((result) => { diagnostic('terminal.question-declined', event.request.title); return result; });
            void asked.catch((): HarnessQuestionResult => ({ kind: 'cancelled' })).then((result) => {
              openPrompts.delete(event.id);
              if (!closing.signal.aborted) { rl.markDrawn?.(`outcome:${event.id}`); client.send({ type: 'question-response', id: event.id, result }); }
            });
            return;
          }
          case 'request-closed': {
            // Answered in another window, withdrawn by the vendor, or the turn ended.
            // Still open here means this window did not answer it: it draws the
            // decision as the one that did, where the worker placed it.
            if (openPrompts.has(event.id)) {
              const decided = recordDecision(tracker, event);
              if (decided) rl.joinMark(decided);
            }
            openPrompts.get(event.id)?.abort();
            openPrompts.delete(event.id);
            return;
          }
          case 'sign-in-request': {
            // The worker has no terminal; this window does. The vendor's own
            // sign-in runs here, and the worker retries the turn after.
            const harness = localHarnessForCommand(event.command);
            const signIn = harness ? { ...harness, loginArgv: event.argv } : undefined;
            void (signIn
              ? withSignIn(rl, event.name, () => loginNativeHarness(signIn, event.environment))
              : Promise.reject(new Error(`unknown harness ${event.command}`)))
              .then(() => client.send({ type: 'sign-in-response', id: event.id }),
                (error: unknown) => client.send({ type: 'sign-in-response', id: event.id, error: error instanceof Error ? error.message : String(error) }));
            return;
          }
          case 'restore-draft':
            rl.restoreDraft(event.text);
            return;
          case 'submission':
            // Answered by the connection's own listener (track).
            return;
          case 'turn-error':
            pendingError = Object.assign(new Error(event.message), event.said ? { said: true } : {});
            return;
          case 'waiting-stop':
            // Stopped from another window too: ended here as stopped.
            if (event.stopped) rl.turnStopped();
            finish('waiting-stop', () => (pendingError ? rejectTurn(pendingError) : resolveTurn()));
            return;
          case 'attach-rejected':
            // Unreachable through this listener in practice: WorkerClient's
            // own attach() already consumes this event type and throws
            // before clientFor() could ever hand back a client for
            // runTurnThroughWorker to reach this switch with. Handled
            // anyway so this remains an exhaustive match on WorkerEvent,
            // not a silent fallthrough if that guarantee ever changes.
            finish('attach-rejected', () => rejectTurn(new Error(`worker rejected this connection: ${event.reason}`)));
            return;
          case 'shutdown':
            finish('shutdown', () => rejectTurn(new Error(`session worker exited mid-turn: ${event.reason}`)));
            return;
          case 'submit-queued':
            // Another turn was already running; this message waits behind it
            // and the loop sends it when its turn comes.
            // That turn is shown here until it ends -- the snapshot the worker
            // sends next brings up what it has streamed. Returning at once
            // sent the loop straight back with the queued message, to be
            // queued again: a tight loop for the whole of the other turn, and
            // the turn itself never shown. A turn that already ended (its
            // waiting-stop came first) leaves nothing to follow.
            if (tracker.running) { rl.submitted?.(tracker.prompt); return; }
            finish('queued-after-end', () => resolveTurn());
            return;
          case 'steerable':
            rl.setSteerable(event.value);
            return;
          case 'stopping':
            rl.turnStopping(event.restoreDraft === true);
            return;
          case 'stop-done':
            rl.stopSettled();
            return;
          case 'submit-rejected':
            // The turn-error and waiting-stop that follow carry it.
            return;
          case 'queue-changed':
          case 'retire-declined':
            return;
          case 'waiting-start':
            // Already reflected: the caller calls rl.startWaiting() itself,
            // below, before this event could possibly arrive.
            return;
        }
      };
      // A turn that ends while its answer is still being revealed (a model that hands over its whole answer
      // at once) waits for the reveal: its end, and anything after, is held and delivered in order.
      let held: WorkerEvent[] | undefined;
      const release = (): void => {
        const events = held ?? [];
        held = undefined;
        for (const event of events) handle(event);
      };
      const onEvent = (event: WorkerEvent): void => {
        if (held) { held.push(event); return; }
        const ends = (event.type === 'snapshot' && !event.live) || event.type === 'waiting-stop';
        if (ends && !settled && rl.reveal.pending) {
          held = [event];
          const stop = rl.reveal.whenRevealed(() => { clearTimeout(cap); release(); });
          const cap = setTimeout(() => { stop(); rl.reveal.flush(); release(); }, REVEAL_MAX_HOLD_MS);
          cap.unref?.();
          return;
        }
        handle(event);
      };
      const onClose = (): void => {
        if (settled) return;
        // The worker is gone mid-turn (killed, crashed): nothing more of
        // this turn comes. It ends here as a stopped one -- its running calls
        // settle as stopped -- drawn from what the worker saved of it, while
        // the live view is still this turn's, so the answer is retired in
        // its place under its prompt rather than above it.
        rl.turnStopped();
        void readState({ transcripts: [sessionId] }).then((state) => {
          const saved = state.sessions.find((item) => item.id === sessionId);
          if (saved && !settled) rl.render({ ...saved, messages: sessionTranscriptMessages(saved), pendingTurn: undefined }, account, { running: false });
        }).catch(quiet('worker/turn-bridge')).finally(() => finish('closed', () => resolveTurn()));
      };
      client.on('event', onEvent);
      client.on('close', onClose);
      // A Stop pressed before the message was sent (startWaiting replays it
      // at once) goes after the submit: ahead of it, the worker answered
      // "nothing to stop" and then ran the turn anyway.
      let submitSent = false;
      let earlyStop: { restoreDraft: boolean; origin: CancelOrigin } | undefined;
      rl.startWaiting(
        'thinking',
        (restoreDraft, trigger) => { const origin = cancelOrigin('window', trigger ?? 'esc'); if (submitSent) client.send({ type: 'cancel', restoreDraft, origin }); else earlyStop = { restoreDraft, origin }; },
        async (text, typedId) => {
          // The worker decides steered vs. queued -- it owns the broker the
          // steer races -- and now says which, on a `submission` event
          // carrying this id. The client used to assume "queued" and never
          // learn otherwise, so a message steered into the answer read
          // "queued for next turn" for the rest of the turn.
          const id = typedId ?? randomUUID();
          const submission = { id, text, submittedAt: new Date().toISOString() };
          const answered = new Promise<Extract<WorkerEvent, { type: 'submission' }>>((resolveAnswer) => {
            pendingSubmissions.set(id, resolveAnswer);
          });
          client.send({ type: 'steer', text, id });
          // The worker answers every steer; a lost connection is the only other
          // end, and is an error: nothing is known to be queued, so the text is restored.
          const outcome = await answeredOrClosed<Extract<WorkerEvent, { type: 'submission' }> | undefined>(client, answered, undefined);
          pendingSubmissions.delete(id);
          if (!outcome) throw new Error('connection to the worker was lost');
          if (outcome.disposition === 'error') throw new Error(outcome.message ?? 'message not sent');
          return { disposition: outcome.disposition, submission };
        },
        // A slash line is never the worker's business: it is ClikCode's own
        // command, and it runs here when the turn ends.
        async (text) => {
          const result = await commandDuringTurn(sessionId, text);
          // /model, /effort, /permissions applied now: the turn learns of it from the worker.
          if (result.commandOutcome === 'applied') {
            const changed = (await readState({ transcripts: [] })).sessions.find((item) => item.id === sessionId);
            if (changed) client.send({ type: 'settings-changed', settings: liveSettingsOf(changed) });
          }
          return result;
        },
        // Stepping away ends this window's following, not the turn: the
        // worker runs it to the end either way, and the connection stays
        // open, so coming back (or another window) picks it up mid-stream.
        () => { left = true; finish('left', () => resolveTurn()); },
        // Esc on a waiting message: the worker owns the queue and the hold,
        // and says whether it was still the user's to take.
        async (id) => {
          const answered = new Promise<TakeBackOutcome>((resolveAnswer) => { pendingTakeBacks.set(id, resolveAnswer); });
          client.send({ type: 'unqueue', id });
          try {
            return await answeredOrClosed<TakeBackOutcome>(client, answered, 'error');
          } finally { pendingTakeBacks.delete(id); }
        },
        // Enter again: into the chat at the next pause. The worker does not
        // cancel the turn, so a sub-agent it started keeps running.
        () => { client.send({ type: 'send-queued' }); },
      );
      // A message typed into a sub-agent's own view: the worker decides what the harness allows
      // (relay, or exactly why not) and answers on a `submission` event, as for a steer.
      rl.subAgentSteer = async (ref, text) => {
        const id = randomUUID();
        const answered = new Promise<Extract<WorkerEvent, { type: 'submission' }>>((resolveAnswer) => { pendingSubmissions.set(id, resolveAnswer); });
        client.send({ type: 'steer-subagent', parentId: ref.id, text, label: ref.label, ...(ref.agentId ? { agentId: ref.agentId } : {}), id });
        const outcome = await answeredOrClosed<Extract<WorkerEvent, { type: 'submission' }> | undefined>(client, answered, undefined);
        pendingSubmissions.delete(id);
        if (!outcome) return 'The connection to the worker was lost; nothing was sent.';
        return outcome.disposition === 'error' ? outcome.message ?? 'Not sent.' : undefined;
      };
      rl.subAgentRead = async (parentId) => {
        const id = randomUUID();
        let timer: ReturnType<typeof setTimeout>;
        const answered = new Promise<import('../harness/subagent-read.js').SubAgentRow[]>((resolve) => {
          pendingSubagentReads.set(id, resolve);
          timer = setTimeout(() => resolve([]), 10_000);
          timer.unref?.();
        });
        try {
          client.send({ type: 'read-subagent', parentId, id });
          return await answeredOrClosed(client, answered, []);
        } finally { clearTimeout(timer!); pendingSubagentReads.delete(id); }
      };
      // This follow lasts exactly as long as the display it drives: ended
      // by anything else, the loop asks the worker again -- it follows the
      // turn afresh or opens the prompt, and is never left with neither.
      rl.onWaitingEnded?.(() => finish('display-ended', () => resolveTurn()));
      begin();
      submitSent = true;
      if (earlyStop) client.send({ type: 'cancel', restoreDraft: earlyStop.restoreDraft, origin: earlyStop.origin });
      for (const event of tracker.unanswered.splice(0)) onEvent(event);
      // Following a turn that ended while this was being set up: its
      // waiting-stop has already gone by.
      if (stillRunning && !stillRunning()) finish('already-ended', () => resolveTurn());
    });
  } finally {
    tracker.driving = false;
    // Messages typed during the turn are placed before it is let go of, as
    // the in-process path does (interactive.ts).
    await rl.flushWaitingSubmissions?.();
    // Stepping away is not the turn's end: it goes on in the worker.
    if (left) rl.leaveTurn();
    else rl.stopWaiting();
  }
  return left ? { left: true as const } : {};
}
