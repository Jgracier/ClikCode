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
   * Sent as a message like any other; the worker runs it on its own. */
  kind?: 'command' | 'notification';
}

export interface LiveTurnInputResult {
  disposition: 'steered' | 'queued' | 'command';
  submission: LiveTurnSubmission;
  /** Queued while its steer is still running (held for a safe moment, or
   * slow): true once it was steered in after all and its queued copy is gone,
   * false if the queued copy stands. */
  landed?: Promise<boolean>;
  /** Queued though steering was asked for: nothing running could take a
   * steer (an agent that takes none, or a turn not yet able to). The row
   * says so rather than leaving it to look like the user's choice. */
  unsteered?: true;
}

/** `held`: the message is queued only as a fallback -- the running turn's
 * transport is holding it to steer in at its next safe moment (see
 * SteerHold), and it runs as the next turn only if that moment never comes. */
type QueueHandler = (submission: LiveTurnSubmission, options?: { held?: boolean }) => Promise<void>;
/** Called by a steer handler that cannot steer yet but will at the turn's
 * next safe moment (ACP: no tool call open). The message is queued durably at
 * once, as the fallback; `withdraw` drops the hold if the user takes that
 * queued copy back (edit, remove) before it was sent; the returned promise settles when that copy is
 * written (or rejects if it could not be, in which case the hold must be
 * dropped: the message has gone back to the composer). The handler's own
 * promise then resolves if the message was steered in after all -- the
 * queued copy is dropped -- or rejects, leaving the queued copy to run. */
export type SteerHold = (withdraw: () => boolean) => Promise<void>;
type SteerHandler = (text: string, submission: LiveTurnSubmission, hold: SteerHold) => Promise<void>;
type LateSteerHandler = (submission: LiveTurnSubmission) => void;

/** How long a native steer may take before the message is queued instead. */
const DEFAULT_STEER_TIMEOUT_MS = 5_000;

interface LiveTurnInputBrokerOptions {
  /** Zero or negative waits for the steer handler indefinitely. */
  steerTimeoutMs?: number;
}

const STEER_TIMED_OUT = Symbol('steer-timed-out');
const STEER_HELD = Symbol('steer-held');
const STEERED = Symbol('steered');

/** Coordinates composer input with an already-running provider turn. The
 * broker itself knows nothing about sessions or vendors: the turn checkpoint
 * supplies durable queue storage, while a richer transport may temporarily
 * publish a native steering handler. */
export class LiveTurnInputBroker {
  private queueHandler?: QueueHandler;
  private steerHandler?: SteerHandler;
  private lateSteerHandler?: LateSteerHandler;
  private readonly steerTimeoutMs: number;
  private readonly queueReady: Promise<void>;
  private resolveQueueReady!: () => void;
  /** Steers still running after their message was queued (a timed-out or a
   * held one), each with what follows it landing. */
  private readonly late = new Set<Promise<void>>();
  /** How to drop each held message, by id, until it is sent or released. */
  private readonly holds = new Map<string, () => boolean>();

  constructor(options: LiveTurnInputBrokerOptions = {}) {
    this.steerTimeoutMs = options.steerTimeoutMs ?? DEFAULT_STEER_TIMEOUT_MS;
    this.queueReady = new Promise((resolve) => { this.resolveQueueReady = resolve; });
  }

  bindQueue(handler: QueueHandler): void {
    this.queueHandler = handler;
    this.resolveQueueReady();
  }

  setSteerHandler(handler?: SteerHandler): void {
    this.steerHandler = handler;
  }

  /** Called when a steer that timed out (and was therefore queued) turns out
   * to have been accepted after all. The message is then in both places; the
   * owner of the queue can drop the queued copy (consumeSessionTurn) so it is
   * not sent a second time as the next turn. */
  setLateSteerHandler(handler?: LateSteerHandler): void {
    this.lateSteerHandler = handler;
  }

  /** Every steer still running after its message was queued has landed or
   * failed. Awaited before the turn's journal is completed, so a message is
   * either a steer in this turn or a queued next turn -- never both. */
  async settled(): Promise<void> {
    while (this.late.size) await Promise.allSettled([...this.late]);
  }

  /** The user is taking a queued message back. One the turn is holding to
   * steer in must then never be sent: true if it was held and now is not,
   * false if it is already on its way into the turn (too late -- taking its
   * queued copy back too would send it twice), undefined if it was not held. */
  withdraw(id: string): boolean | undefined {
    const withdraw = this.holds.get(id);
    if (!withdraw) return undefined;
    this.holds.delete(id);
    return withdraw();
  }

  /** Release submissions if setup failed before a durable checkpoint could
   * bind. The UI restores their text instead of waiting forever. */
  close(): void {
    this.steerHandler = undefined;
    if (!this.queueHandler) {
      this.queueHandler = async () => { throw new Error('turn ended before live input was ready'); };
      this.resolveQueueReady();
    }
  }

  /** `id` is the one the composer already shows the message under, so the
   * durable copy -- a queued turn, or a steer recorded on the turn -- can be
   * matched to that row by identity instead of by its words. Two messages
   * that say the same thing are still two messages. */
  async submit(raw: string, id: string = randomUUID(), options: { queue?: boolean } = {}): Promise<LiveTurnInputResult> {
    const text = raw.trim();
    if (!text) throw new Error('message is empty');
    const submission = { id, text, submittedAt: new Date().toISOString() };
    await this.queueReady;
    // `/send queue`: never into the running turn, whatever it could take.
    const steer = options.queue ? undefined : this.steerHandler;
    if (steer) {
      // A transport that never answers turn/steer (wedged app-server, a
      // dropped JSON-RPC response) must not strand the message in a promise
      // nobody settles: the composer has already cleared it. Race the steer,
      // and on timeout fall through to the durable queue. A transport that
      // HOLDS the message (SteerHold) is not slow: it is queued at once.
      let timer: NodeJS.Timeout | undefined;
      let signalHeld!: () => void;
      const held = new Promise<typeof STEER_HELD>((resolve) => { signalHeld = () => resolve(STEER_HELD); });
      let resolveQueued!: () => void;
      let rejectQueued!: (error: unknown) => void;
      const queued = new Promise<void>((resolve, reject) => { resolveQueued = resolve; rejectQueued = reject; });
      queued.catch(() => undefined);
      const hold: SteerHold = (withdraw) => { this.holds.set(id, withdraw); signalHeld(); return queued; };
      const attempt = Promise.resolve().then(() => steer(text, submission, hold));
      let outcome: symbol | undefined;
      try {
        outcome = await Promise.race([attempt.then(() => STEERED), held, ...(this.steerTimeoutMs > 0
          ? [new Promise<typeof STEER_TIMED_OUT>((resolve) => {
            timer = setTimeout(() => resolve(STEER_TIMED_OUT), this.steerTimeoutMs);
          })]
          : [])]);
      } catch {
        // The active turn may complete between Enter and turn/steer. Falling
        // back to the durable next-turn queue is lossless and preserves the
        // user's instruction instead of surfacing a timing error.
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (outcome === STEERED) return { disposition: 'steered', submission };
      if (outcome === STEER_HELD) {
        // Queued now, once: the fallback copy, not a second send. If it
        // cannot be written the message goes back to the composer, and the
        // rejected `queued` tells the transport to drop its hold.
        try { await this.queueHandler!(submission, { held: true }); }
        catch (error) { rejectQueued(error); throw error; }
        resolveQueued();
      }
      if (outcome === STEER_HELD || outcome === STEER_TIMED_OUT) {
        const landed = attempt.then(
          () => { try { this.lateSteerHandler?.(submission); } catch { /* fail-open-ok: de-duplication is best effort */ } return true; },
          () => false, // it failed after all; the queued copy is the only one
        );
        const tracked = landed.then(() => { this.holds.delete(id); });
        this.late.add(tracked);
        void tracked.finally(() => this.late.delete(tracked));
        if (outcome === STEER_HELD) return { disposition: 'queued', submission, landed };
      }
    }
    await this.queueHandler!(submission);
    return { disposition: 'queued', submission, ...(!steer && !options.queue ? { unsteered: true as const } : {}) };
  }
}
