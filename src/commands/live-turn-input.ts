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

/** Coordinates composer input with an already-running provider turn. The
 * broker itself knows nothing about sessions or vendors: the turn checkpoint
 * supplies durable queue storage, while a richer transport may temporarily
 * publish a native steering handler. */
export class LiveTurnInputBroker {
  private queueHandler?: QueueHandler;
  private steerHandler?: SteerHandler;
  private readonly queueReady: Promise<void>;
  private resolveQueueReady!: () => void;

  constructor() {
    this.queueReady = new Promise((resolve) => { this.resolveQueueReady = resolve; });
  }

  bindQueue(handler: QueueHandler): void {
    this.queueHandler = handler;
    this.resolveQueueReady();
  }

  setSteerHandler(handler?: SteerHandler): void {
    this.steerHandler = handler;
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
      try {
        await steer(text);
        return { disposition: 'steered', submission };
      } catch {
        // The active turn may complete between Enter and turn/steer. Falling
        // back to the durable next-turn queue is lossless and preserves the
        // user's instruction instead of surfacing a timing error.
      }
    }
    await this.queueHandler!(submission);
    return { disposition: 'queued', submission };
  }
}
