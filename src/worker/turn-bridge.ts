/** Running one interactive turn through a session worker instead of
 * in-process -- the actual Phase 3 cutover point. Everything before this
 * file (protocol, registry, the worker itself) was additive and provably
 * inert; this is the first thing that changes what a live terminal does.
 *
 * Deliberately narrow: this owns exactly the same sequence
 * commands/ai/interactive.ts's runInteractiveTurn already runs -- paint the
 * pending message, start waiting, run the turn, stop waiting -- translating
 * each TurnObserver-shaped WorkerEvent into the identical TerminalHarness-
 * Prompter method call drive.ts would have made directly in the old,
 * single-process model. rl cannot tell the difference (see turn/observer.ts
 * for why that is true by construction, not by care taken here).
 */
import { randomUUID } from 'node:crypto';
import { commandDuringTurn } from '../tui/slash/queue.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';
import { WorkerClient } from './client.js';
import type { WorkerEvent } from './protocol.js';
import { withVendorTerminal } from '../commands/account.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';

export interface WorkerTurnRequest {
  echo: boolean;
  queuedTurnId?: string;
}

/** One WorkerClient per session, reused across every turn for as long as
 * this interactive process runs -- attaching fresh per turn would work (a
 * worker happily answers any number of attaches) but would re-pay the
 * snapshot round-trip on every single message for no reason. Cleared by
 * closeAllWorkerClients() when the interactive loop ends. */
const clients = new Map<string, WorkerClient>();

/** Messages typed during a turn, waiting for the worker to say what happened
 * to them. Longer than the broker's own 5s steer timeout, so a slow steer is
 * answered rather than guessed. */
const pendingSubmissions = new Map<string, (event: Extract<WorkerEvent, { type: 'submission' }>) => void>();
const SUBMISSION_ANSWER_MS = 8_000;

/** What this window knows of its worker, from a listener that stays on the
 * connection for its whole life: whether a turn is running (whoever started
 * it) and with what prompt, and a wake-up for a window sitting at its
 * prompt. The turn listener below comes and goes with each turn; this does
 * not, so nothing the worker starts on its own is missed. */
interface WorkerTracker {
  running: boolean;
  prompt?: string;
  liveText: string;
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
  const tracker: WorkerTracker = { running: false, liveText: '', driving: false, unanswered: [], queueVersion: 0 };
  trackers.set(client, tracker);
  const initial = client.initialEvent;
  if (initial?.type === 'snapshot' && initial.live) Object.assign(tracker, { running: true, prompt: initial.live.prompt, liveText: initial.live.text });
  client.on('event', (event: WorkerEvent) => {
    if (event.type === 'waiting-start') {
      Object.assign(tracker, { running: true, prompt: event.prompt, liveText: '' });
      tracker.wake?.('turn');
    } else if (event.type === 'waiting-stop') {
      tracker.running = false;
      tracker.unanswered = [];
    } else if (event.type === 'approval-request' || event.type === 'sign-in-request') {
      if (!tracker.driving) tracker.unanswered.push(event);
    } else if (event.type === 'snapshot') {
      // A worker older than this client names no prompt; it still says a
      // turn is live, and that is what matters here.
      if (event.live) Object.assign(tracker, { running: true, prompt: event.live.prompt ?? tracker.prompt, liveText: event.live.text });
    } else if (event.type === 'delta') {
      tracker.liveText = event.mode === 'replace' ? event.text : tracker.liveText + event.text;
    } else if (event.type === 'queue-changed') {
      tracker.queueVersion++;
      tracker.wake?.('queue');
    } else if (event.type === 'submission') {
      // Here, not on the turn's own listener: that one goes at waiting-stop,
      // and an answer for a message typed as the turn ended can come after
      // it -- which left the message's row waiting out the full timeout.
      pendingSubmissions.get(event.id)?.(event);
    }
  });
  // A worker that exits (idle, retired) is attached afresh next time.
  client.on('close', () => { if (clients.get(sessionId) === client) clients.delete(sessionId); });
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

/** This terminal has left a conversation: its worker stops what it started
 * for it. The worker itself stays, so going back to it is instant. */
export function releaseSessionWorker(sessionId: string): void {
  clients.get(sessionId)?.send({ type: 'release' });
}

export async function closeAllWorkerClients(): Promise<void> {
  for (const client of clients.values()) { client.send({ type: 'detach' }); client.close(); }
  clients.clear();
}

/** Mirrors runInteractiveTurn's own cancel/onSubmit callbacks, wired to send
 * over the socket instead of touching an in-process AbortController/
 * LiveTurnInputBroker directly -- the worker owns both of those now.
 *
 * Returns whatever notice the worker reported (a cancellation's "Stopped",
 * for instance) so the caller can fold it into the SAME `notice` local
 * variable its own next loop iteration already shows on the following
 * render -- there is no separate "show a notice" method on the interface
 * to call here directly, by design: a notice belongs to the next render,
 * not a side channel of its own (see prompter.ts's own render(session,
 * account, notice) signature). */
export async function runTurnThroughWorker(
  sessionId: string, rl: TerminalHarnessPrompter, promptText: string, turn: WorkerTurnRequest,
): Promise<{ notice?: string }> {
  const client = await clientFor(sessionId);
  return driveWorkerTurn(sessionId, client, rl, () => {
    client.send({ type: 'submit', text: promptText, echo: turn.echo, ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}) });
  });
}

/** What a window at its prompt should do instead of waiting for a key. */
export type IdleWake = { line: string } | { woke: 'turn'; prompt?: string } | { woke: 'queue' };

/** Asks for the next line, unless the worker has something first: a turn it
 * is running that this window did not start (another window's, or a
 * follow-up for a finished background shell), or a change to the queue.
 * The window used to sit at its prompt through both, showing neither -- a
 * reopened conversation mid-turn looked idle, and a queued message waited
 * for a keypress. Attaches only to a worker that is already running. */
export async function questionOrWorker(sessionId: string, ask: (signal?: AbortSignal) => Promise<string>, queueMark?: number): Promise<IdleWake> {
  const client = await connect(sessionId, false).catch(() => undefined);
  const tracker = client ? trackers.get(client) : undefined;
  if (!tracker) return { line: await ask() };
  if (tracker.running) return { woke: 'turn', ...(tracker.prompt !== undefined ? { prompt: tracker.prompt } : {}) };
  // The queue changed after the caller read it: read it again first.
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

/** Taken BEFORE reading the queue from state, and handed to questionOrWorker. */
export function workerQueueMark(sessionId: string): number | undefined {
  const client = clients.get(sessionId);
  return client ? trackers.get(client)?.queueVersion : undefined;
}

/** The prompt of the turn this window's worker is running, when one is --
 * `{}` for a worker too old to name it -- so the loop follows that turn
 * instead of sending the queue's head into it. */
export function workerRunningTurn(sessionId: string): { prompt?: string } | undefined {
  const client = clients.get(sessionId);
  const tracker = client ? trackers.get(client) : undefined;
  if (!tracker?.running) return undefined;
  return tracker.prompt !== undefined ? { prompt: tracker.prompt } : {};
}

/** Follows the turn the worker is running to its end, exactly as if this
 * window had sent it: what has streamed so far, then every event, with
 * cancel and typed messages going to the worker. */
export async function followWorkerTurn(sessionId: string, rl: TerminalHarnessPrompter): Promise<{ notice?: string }> {
  const client = clients.get(sessionId);
  const tracker = client ? trackers.get(client) : undefined;
  if (!client || !tracker?.running) return {};
  return driveWorkerTurn(sessionId, client, rl, () => {
    if (tracker.liveText) rl.response(tracker.liveText, 'replace');
  }, () => tracker.running);
}

async function driveWorkerTurn(
  sessionId: string, client: WorkerClient, rl: TerminalHarnessPrompter, begin: () => void, stillRunning?: () => boolean,
): Promise<{ notice?: string }> {
  let notice: string | undefined;
  const tracker = trackers.get(client);
  if (tracker) tracker.driving = true;
  try {
    await new Promise<void>((resolveTurn, rejectTurn) => {
      let settled = false;
      // A caught turn failure is not, on its own, the end of the sequence:
      // the worker still sends a final render() and then waiting-stop after
      // it (see session-worker.ts's runTurn `finally`), and tearing this
      // listener down the instant turn-error arrived meant that render
      // never reached here -- confirmed by a real test that failed on
      // exactly this ordering the first time this shipped, the same class
      // of bug as the render-vs-stopWaiting ordering fixed in the worker
      // itself moments earlier. waiting-stop is the one true end-of-turn
      // signal; a recorded error is only ever surfaced once it arrives.
      let pendingError: Error | undefined;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        client.off('event', onEvent);
        client.off('close', onClose);
        fn();
      };
      const onEvent = (event: WorkerEvent): void => {
        switch (event.type) {
          case 'snapshot':
            rl.render(event.session, event.account);
            // The worker was already running this turn (a queued message it
            // started first): what has streamed so far.
            if (event.live?.text) rl.response(event.live.text, 'replace');
            return;
          case 'delta':
            rl.response(event.text, event.mode);
            return;
          case 'activity':
            rl.activityEvent(event.event);
            return;
          case 'phase':
            rl.phase(event.message);
            return;
          case 'plan':
            rl.setPlan(event.entries);
            return;
          case 'usage':
            rl.setTurnUsage(event.usage);
            return;
          case 'approval-request':
            void rl.approval(event.title, event.detail, event.preview, event.rule).then((approved) => {
              client.send({ type: 'approval-response', id: event.id, approved });
            });
            return;
          case 'sign-in-request': {
            // The worker has no terminal; this window does. The vendor's own
            // sign-in runs here, and the worker retries the turn after.
            const harness = localHarnessForCommand(event.command);
            const signIn = harness ? { ...harness, loginArgv: event.argv } : undefined;
            void (signIn
              ? withVendorTerminal(rl, signIn, () => loginNativeHarness(signIn, event.environment), event.name)
              : Promise.reject(new Error(`unknown harness ${event.command}`)))
              .then(() => client.send({ type: 'sign-in-response', id: event.id }),
                (error: unknown) => client.send({ type: 'sign-in-response', id: event.id, error: error instanceof Error ? error.message : String(error) }));
            return;
          }
          case 'suspend':
            // A worker has no terminal to actually hand over (see
            // BroadcastObserver.suspend's own comment) -- reflecting the
            // state visually is all a client can do with this.
            void rl.suspend();
            return;
          case 'resume':
            rl.resume();
            return;
          case 'restore-draft':
            rl.restoreDraft(event.text);
            return;
          case 'notice':
            notice = event.message;
            return;
          case 'submission':
            // Answered by the connection's own listener (track).
            return;
          case 'turn-error':
            pendingError = new Error(event.message);
            return;
          case 'waiting-stop':
            finish(() => (pendingError ? rejectTurn(pendingError) : resolveTurn()));
            return;
          case 'attach-rejected':
            // Unreachable through this listener in practice: WorkerClient's
            // own attach() already consumes this event type and throws
            // before clientFor() could ever hand back a client for
            // runTurnThroughWorker to reach this switch with. Handled
            // anyway so this remains an exhaustive match on WorkerEvent,
            // not a silent fallthrough if that guarantee ever changes.
            finish(() => rejectTurn(new Error(`worker rejected this connection: ${event.reason}`)));
            return;
          case 'shutdown':
            finish(() => rejectTurn(new Error(`session worker exited mid-turn: ${event.reason}`)));
            return;
          case 'submit-queued':
            // Another turn was already running; this message waits behind it
            // and the loop sends it when its turn comes.
            notice = 'Queued behind the turn already running';
            // That turn is shown here until it ends -- the snapshot the worker
            // sends next brings up what it has streamed. Returning at once
            // sent the loop straight back with the queued message, to be
            // queued again: a tight loop for the whole of the other turn, and
            // the turn itself never shown. A turn that already ended (its
            // waiting-stop came first) leaves nothing to follow.
            if (tracker?.running) { rl.submitted?.(tracker.prompt); return; }
            finish(() => resolveTurn());
            return;
          case 'queue-changed':
            return;
          case 'waiting-start':
            // Already reflected: the caller calls rl.startWaiting() itself,
            // below, before this event could possibly arrive.
            return;
        }
      };
      const onClose = (): void => {
        finish(() => rejectTurn(new Error('session worker connection closed unexpectedly')));
      };
      client.on('event', onEvent);
      client.on('close', onClose);
      rl.startWaiting(
        'thinking',
        (restoreDraft) => client.send({ type: 'cancel', restoreDraft }),
        async (text) => {
          // The worker decides steered vs. queued -- it owns the broker the
          // steer races -- and now says which, on a `submission` event
          // carrying this id. The client used to assume "queued" and never
          // learn otherwise, so a message steered into the answer read
          // "queued for next turn" for the rest of the turn.
          const id = randomUUID();
          const submission = { id, text, submittedAt: new Date().toISOString() };
          const answered = new Promise<Extract<WorkerEvent, { type: 'submission' }>>((resolveAnswer) => {
            pendingSubmissions.set(id, resolveAnswer);
          });
          client.send({ type: 'steer', text, id });
          // A worker too old to answer (the one still running when this
          // client updated) is the only reason no answer comes. Queued is the
          // safe assumption for that: it never claims a delivery that did not
          // happen.
          const outcome = await Promise.race([
            answered,
            new Promise<undefined>((resolveLate) => { setTimeout(() => resolveLate(undefined), SUBMISSION_ANSWER_MS).unref(); }),
          ]);
          pendingSubmissions.delete(id);
          if (outcome?.disposition === 'error') throw new Error(outcome.message ?? 'message not sent');
          return { disposition: outcome?.disposition ?? 'queued', submission };
        },
        // A slash line is never the worker's business: it is ClikCode's own
        // command, and it runs here when the turn ends.
        (text) => commandDuringTurn(sessionId, text),
      );
      begin();
      for (const event of tracker?.unanswered.splice(0) ?? []) onEvent(event);
      // Following a turn that ended while this was being set up: its
      // waiting-stop has already gone by.
      if (stillRunning && !stillRunning()) finish(() => resolveTurn());
    });
  } finally {
    if (tracker) tracker.driving = false;
    // Messages typed during the turn are placed before it is let go of, as
    // the in-process path does (interactive.ts).
    await rl.flushWaitingSubmissions?.();
    rl.stopWaiting();
  }
  return notice !== undefined ? { notice } : {};
}
