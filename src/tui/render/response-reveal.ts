/** The terminal's live answer, revealed at a pace (harness/protocol/reveal-pace.ts): what the harness has
 * sent is `full`; what is drawn is as much of it as has been revealed. */
import { nextRevealed, revealedPrefix, REVEAL_FRAME_MS, REVEAL_IMMEDIATE_CHARS } from '../../harness/protocol/reveal-pace.js';

export class ResponseReveal {
  private revealed = 0;
  private total = 0;
  private timer: NodeJS.Timeout | undefined;
  private last = 0;
  private readonly waiting = new Set<() => void>();

  /** `paint` redraws the live answer after a step. */
  constructor(private readonly paint: () => void) {}

  /** Whether some of the answer is still to be revealed. */
  get pending(): boolean { return this.revealed < this.total; }

  /** The answer as far as it is revealed. */
  shown(full: string): string { return revealedPrefix(full, Math.min(this.revealed, full.length)); }

  /** The answer is now `length` characters (it grew, or was replaced). */
  update(length: number): void {
    this.total = length;
    if (this.revealed > length) this.revealed = length;
    // Ordinary streaming leaves a few words between frames: drawn now.
    if (!this.timer && length - this.revealed <= REVEAL_IMMEDIATE_CHARS) { this.revealed = length; return; }
    if (this.timer) return;
    this.last = Date.now();
    this.timer = setInterval(() => this.step(), REVEAL_FRAME_MS);
    this.timer.unref?.();
  }

  private step(): void {
    const now = Date.now();
    this.revealed = nextRevealed(this.revealed, this.total, now - this.last);
    this.last = now;
    this.paint();
    if (this.revealed >= this.total) this.settle();
  }

  private settle(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const done of [...this.waiting]) done();
    this.waiting.clear();
  }

  /** Calls `done` once everything is revealed (at once if it is); returns how to stop waiting. */
  whenRevealed(done: () => void): () => void {
    if (!this.pending) { done(); return () => undefined; }
    this.waiting.add(done);
    return () => { this.waiting.delete(done); };
  }

  /** All of it, now: the turn ended, or another began. */
  flush(): void {
    this.revealed = this.total;
    this.settle();
  }

  /** A new answer begins. */
  reset(): void {
    this.revealed = 0;
    this.total = 0;
    this.settle();
  }
}
