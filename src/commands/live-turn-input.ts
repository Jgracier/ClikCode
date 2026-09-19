import { randomUUID } from 'node:crypto';

export interface LiveTurnSubmission {
  id: string;
  text: string;
  submittedAt: string;
}

export interface LiveTurnInputResult {
  disposition: 'steered' | 'queued';
  submission: LiveTurnSubmission;
}

type QueueHandler = (submission: LiveTurnSubmission) => Promise<void>;
type SteerHandler = (text: string) => Promise<void>;
type LateSteerHandler = (submission: LiveTurnSubmission) => void;

/** How long a native steer may take before the message is queued instead. */
export const DEFAULT_STEER_TIMEOUT_MS = 5_000;

export interface LiveTurnInputBrokerOptions {
  /** Zero or negative waits for the steer handler indefinitely. */
  steerTimeoutMs?: number;
}

const STEER_TIMED_OUT = Symbol('steer-timed-out');

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

  /** Release submissions if setup failed before a durable checkpoint could
   * bind. The UI restores their text instead of waiting forever. */
  close(): void {
    this.steerHandler = undefined;
    if (!this.queueHandler) {
      this.queueHandler = async () => { throw new Error('turn ended before live input was ready'); };
      this.resolveQueueReady();
    }
  }

  async submit(raw: string): Promise<LiveTurnInputResult> {
    const text = raw.trim();
    if (!text) throw new Error('message is empty');
    const submission = { id: randomUUID(), text, submittedAt: new Date().toISOString() };
    await this.queueReady;
    const steer = this.steerHandler;
    if (steer) {
      // A transport that never answers turn/steer (wedged app-server, a
      // dropped JSON-RPC response) must not strand the message in a promise
      // nobody settles: the composer has already cleared it. Race the steer,
      // and on timeout fall through to the durable queue.
      let timer: NodeJS.Timeout | undefined;
      const attempt = Promise.resolve().then(() => steer(text));
      try {
        const outcome = await (this.steerTimeoutMs > 0
          ? Promise.race([attempt, new Promise<typeof STEER_TIMED_OUT>((resolve) => {
            timer = setTimeout(() => resolve(STEER_TIMED_OUT), this.steerTimeoutMs);
          })])
          : attempt);
        if (outcome !== STEER_TIMED_OUT) return { disposition: 'steered', submission };
        attempt.then(
          () => { try { this.lateSteerHandler?.(submission); } catch { /* fail-open-ok: de-duplication is best effort */ } },
          () => undefined, // it failed after all; the queued copy is the only one
        );
      } catch {
        // The active turn may complete between Enter and turn/steer. Falling
        // back to the durable next-turn queue is lossless and preserves the
        // user's instruction instead of surfacing a timing error.
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    await this.queueHandler!(submission);
    return { disposition: 'queued', submission };
  }
}
