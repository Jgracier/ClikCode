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

async function clientFor(sessionId: string): Promise<WorkerClient> {
  const existing = clients.get(sessionId);
  if (existing) return existing;
  const client = await WorkerClient.attach(sessionId);
  clients.set(sessionId, client);
  return client;
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
  let notice: string | undefined;
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
            pendingSubmissions.get(event.id)?.(event);
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
      client.send({ type: 'submit', text: promptText, echo: turn.echo, ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}) });
    });
  } finally {
    rl.stopWaiting();
  }
  return notice !== undefined ? { notice } : {};
}
