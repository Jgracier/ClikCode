import { quiet } from '../runtime/lifecycle-log.js';
import { randomUUID } from 'node:crypto';

export interface LiveTurnSubmission {
  id: string;
  text: string;
  submittedAt: string;
  /** A ClikCode slash command typed while the turn was running. It is queued
   * like a message but is NOT one: it runs as the command it is when the turn
   * ends, with the screen to itself. See tui/waiting-slash.ts.
   * `notification`: not typed by anyone -- background shells the agent
   * started have finished, and this tells the model (session-worker.ts).
   * Sent as a message like any other; the worker runs it on its own.
   * `note`: ClikCode's own word to the model, steered in (steerNote) and
   * never journaled, queued or shown. */
  kind?: 'command' | 'notification' | 'note';
}

/** What became of a waiting message the user took back: `removed` -- it is
 * theirs again; `running` -- already on its way into the turn, so it stays;
 * `gone` -- its turn already took it. */
export type TakeBackOutcome = 'removed' | 'running' | 'gone' | 'error';

export interface LiveTurnInputResult {
  /** `steered`: the running turn took it. `queued`: it waits in the saved queue -- for the turn's
   * next opening if it is to be steered in, else for the turn to end. */
  disposition: 'steered' | 'queued' | 'command';
  submission: LiveTurnSubmission;
  /** For a `command`: it took effect at once (`applied`) or waits for the
   * turn boundary (`later`). The composer acknowledges it either way. */
  commandOutcome?: 'applied' | 'later';
  /** Steering was asked for and nothing running can take a message (an agent
   * that has no steering). It waits for the turn to end, and the row says so. */
  unsteered?: true;
}

/** What a running turn offers for taking a message into itself. ClikCode only passes the message on
 * through the way the vendor gives; it never decides for the vendor, and never interrupts to do it. */
export interface SteerPort {
  /** Take `text` into the running turn now. True once it is in; false when this is not a moment
   * it can be taken without interrupting something (a tool call is open, a question is being asked):
   * the message stays queued and the port calls `onWindow` when a moment comes. Rejects when the turn is over. */
  offer(text: string, submission: LiveTurnSubmission): Promise<boolean>;
  /** Set by the broker. The port calls it whenever a moment that may take a message begins. */
  onWindow?: () => void;
}

/** The turn's saved record of its queue and its steers. The saved queue is the only place a waiting message lives. */
export interface LiveTurnLedger {
  /** Writes the message to the queue behind this turn, marked to go into it (`steer`) or not. Rejects if it could not be written. */
  queue(submission: LiveTurnSubmission, steer: boolean): Promise<void>;
  /** The oldest waiting message marked to go into the running turn. */
  nextSteer(): LiveTurnSubmission | undefined;
  /** The oldest message the user queued (not a command or notice), marked or not. */
  oldestMessage(): LiveTurnSubmission | undefined;
  /** It is in the turn: recorded on the turn and gone from the queue, in one write. Rejects when the turn is finishing. */
  delivered(submission: LiveTurnSubmission): Promise<void>;
  /** Marks a waiting message to go into the running turn. False if it is not waiting. */
  mark(id: string): Promise<boolean>;
  /** Takes a waiting message out of the queue. False if it is not waiting. */
  remove(id: string): Promise<boolean>;
}

/** Coordinates composer input with an already-running provider turn. It knows nothing of sessions or vendors:
 * the turn's ledger is the saved queue, the turn's port is the vendor's way of taking a message in. A message
 * is in exactly one place at a time -- the queue, or the turn. */
export class LiveTurnInputBroker {
  private ledger?: LiveTurnLedger;
  private readonly ledgerReady: Promise<void>;
  private resolveLedgerReady!: () => void;
  private port?: SteerPort;
  /** Settles when the port goes away, so an offer nobody answers cannot hold the broker. */
  private portGone = new Promise<'gone'>(() => undefined);
  private resolvePortGone?: () => void;
  /** One thing at a time: a submit, a delivery pass, a take-back's check. */
  private tail: Promise<unknown> = Promise.resolve();
  /** The message being offered to the turn now: too late to take back. */
  private delivering: string | undefined;
  private readonly delivered = new Set<string>();
  private afterDelivery?: () => void;

  constructor() {
    this.ledgerReady = new Promise((resolve) => { this.resolveLedgerReady = resolve; });
  }

  bindLedger(ledger: LiveTurnLedger): void {
    this.ledger = ledger;
    this.resolveLedgerReady();
  }

  /** Told when a waiting message later goes into the turn (not on the submit that queued it), so every
   * window can redraw the queue and the turn. */
  onLaterDelivery(handler?: () => void): void {
    this.afterDelivery = handler;
  }

  /** The turn's way of taking a message in, or none (the turn ended, or its agent has none). */
  setSteerPort(port?: SteerPort): void {
    this.resolvePortGone?.();
    this.port = port;
    if (!port) return;
    this.portGone = new Promise<'gone'>((resolve) => { this.resolvePortGone = () => resolve('gone'); });
    port.onWindow = () => { void this.run(() => this.deliver(true)); };
    void this.run(() => this.deliver(true));
  }

  /** Whether the running turn has a way to take a message in. */
  get steerable(): boolean {
    return this.port !== undefined;
  }

  /** A note from ClikCode itself for the model only (turn/resource-notes.ts): offered like a message, never
   * journaled, queued or shown. True once it is in the turn; false when it is not a moment it can be or
   * nothing running could take it, and the caller keeps it for the next turn. */
  async steerNote(text: string): Promise<boolean> {
    const submission: LiveTurnSubmission = { id: randomUUID(), text, submittedAt: new Date().toISOString(), kind: 'note' };
    return this.run(async () => (this.port ? this.offer(this.port, submission) : false));
  }

  /** Every pass that was running has finished. Awaited before the turn's journal is completed, so a message
   * is either in this turn or still queued for the next. */
  async settled(): Promise<void> {
    await this.tail.catch(quiet('turn/live-input'));
  }

  /** Release submissions if setup failed before the ledger could bind. The UI restores their text instead of waiting forever. */
  close(): void {
    this.setSteerPort(undefined);
    if (!this.ledger) {
      this.ledger = {
        queue: () => Promise.reject(new Error('turn ended before live input was ready')),
        nextSteer: () => undefined, oldestMessage: () => undefined,
        delivered: () => Promise.reject(new Error('turn ended before live input was ready')),
        mark: () => Promise.resolve(false), remove: () => Promise.resolve(false),
      };
      this.resolveLedgerReady();
    }
  }

  /** The user is taking a waiting message back. `running`: it is being put into the turn this moment, so it stays. */
  async takeBack(id: string): Promise<TakeBackOutcome> {
    if (this.delivering === id) return 'running';
    await this.ledgerReady;
    return (await this.ledger!.remove(id)) ? 'removed' : 'gone';
  }

  /** Enter again, nothing typed: the oldest message waiting goes into the turn now if the turn can take it now.
   * It is never forced: a call in the way is waited for, not cut. */
  async sendNow(): Promise<{ submission: LiveTurnSubmission; steered: boolean } | undefined> {
    await this.ledgerReady;
    return this.run(async () => {
      const next = this.ledger!.oldestMessage();
      if (!next) return undefined;
      if (!this.port) return { submission: next, steered: false };
      if (!(await this.ledger!.mark(next.id))) return { submission: next, steered: false };
      await this.deliver(false);
      return { submission: next, steered: this.delivered.has(next.id) };
    });
  }

  /** `id` is the one the composer already shows the message under, so the saved copy -- a queued turn, or a
   * steer recorded on the turn -- is matched to that row by identity instead of by its words.
   * `steer`: into the running turn when it can take it, else at its next opening; false waits for the turn to end. */
  async submit(raw: string, id: string = randomUUID(), options: { steer: boolean }): Promise<LiveTurnInputResult> {
    const text = raw.trim();
    if (!text) throw new Error('message is empty');
    const submission = { id, text, submittedAt: new Date().toISOString() };
    await this.ledgerReady;
    return this.run(async () => {
      const ledger = this.ledger!;
      // Nothing waiting ahead of it and the turn can take it now: in, without ever being queued.
      if (options.steer && this.port && !ledger.nextSteer()) {
        this.delivering = id;
        let taken = false;
        try { taken = await this.offer(this.port, submission); } finally { this.delivering = undefined; }
        if (taken) {
          try { await ledger.delivered(submission); this.delivered.add(id); return { disposition: 'steered' as const, submission }; } catch { /* the turn is finishing: queued below */ }
        }
      }
      await ledger.queue(submission, options.steer);
      if (options.steer) await this.deliver(false);
      if (this.delivered.has(id)) return { disposition: 'steered' as const, submission };
      return { disposition: 'queued' as const, submission, ...(options.steer && !this.port ? { unsteered: true as const } : {}) };
    });
  }

  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(quiet('turn/live-input'));
    return next;
  }

  /** Offers one message; a refusal, an error or the port going away all leave it where it is. */
  private async offer(port: SteerPort, submission: LiveTurnSubmission): Promise<boolean> {
    try {
      const taken = await Promise.race([port.offer(submission.text, submission), this.portGone]);
      return taken === true;
    } catch {
      return false;
    }
  }

  /** Puts waiting messages into the turn, oldest first, until one is refused. `later`: not the submit that queued them. */
  private async deliver(later: boolean): Promise<void> {
    const ledger = this.ledger;
    const port = this.port;
    if (!ledger || !port) return;
    let any = false;
    for (;;) {
      const next = ledger.nextSteer();
      if (!next) break;
      this.delivering = next.id;
      let taken = false;
      try { taken = await this.offer(port, next); } finally { this.delivering = undefined; }
      if (!taken) break;
      try { await ledger.delivered(next); } catch (error) { quiet('turn/live-input')(error); break; }
      this.delivered.add(next.id);
      any = true;
    }
    if (later && any) try { this.afterDelivery?.(); } catch { /* fail-open-ok: presentation only */ }
  }
}
