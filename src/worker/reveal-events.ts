/** Keep the final snapshot behind its live answer in every terminal client. */
import type { ResponseReveal } from '../tui/render/response-reveal.js';
import { REVEAL_MAX_HOLD_MS } from '../harness/protocol/reveal-pace.js';

export class RevealEvents<T> {
  private held: T[] | undefined;
  private timer?: NodeJS.Timeout;
  private unwatch?: () => void;
  constructor(private readonly reveal: ResponseReveal | undefined, private readonly handle: (event: T) => void, private readonly ends: (event: T) => boolean) {}

  push(event: T): void {
    if (this.held) { this.held.push(event); return; }
    if (!this.ends(event) || !this.reveal?.pending) { this.handle(event); return; }
    this.held = [event];
    this.timer = setTimeout(() => { this.reveal!.flush(); this.release(); }, REVEAL_MAX_HOLD_MS);
    this.timer.unref?.();
    this.unwatch = this.reveal.whenRevealed(() => this.release());
  }

  private release(): void {
    const held = this.held ?? [];
    this.clear();
    this.held = undefined;
    for (const event of held) this.handle(event);
  }

  private clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.unwatch?.();
    this.unwatch = undefined;
  }

  /** Leaving a view must not deliver its delayed end into the next chat. */
  dispose(): void { this.clear(); this.held = undefined; }
}
