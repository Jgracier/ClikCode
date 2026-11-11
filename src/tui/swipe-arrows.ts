/** THE RULE for telling a swipe from an arrow key, in the one place it is written down.
 *
 * A swipe (or a wheel notch) only ever scrolls the conversation. It never recalls a past prompt, never moves the draft's cursor and
 * never clears the composer. Up and Down typed as keys (a hardware keyboard, the phone's shortcut row, a terminal's own arrow keys)
 * move through the draft and recall history.
 *
 * How the two are told apart, by client:
 *   - ClikDeploy's phone page (CLIKDEPLOY_CLIENT=mobile) and CLIKCODE_MOUSE=1: wheel reporting is on (modes.ts wheelWanted), so a
 *     swipe arrives as wheel reports and an arrow key as an arrow key. Nothing to guess; this gate is off.
 *   - Every other client (third-party SSH apps, tmux, a plain terminal) keeps the client's own selection: no mouse mode, alternate
 *     scroll (`?1007`) on, and the client turns a swipe into Up/Down arrows. Those are told apart by timing: a client sends a swipe's
 *     arrows as a burst (several in one read, or each within SWIPE_BURST_MS of the last), which a person pressing a key never does.
 *     A burst is a swipe; once one is, every Up/Down within SWIPE_TAIL_MS of its last arrow is the same swipe slowing down (the
 *     momentum tail). A lone Up/Down is a key. To know it is lone, it is held for SWIPE_BURST_MS first (that is the cost: an arrow
 *     key press lands SWIPE_BURST_MS later); any other key lets a held arrow go first, so the order of keys is kept.
 *   - Inline mode: the client scrolls its own scrollback and sends no arrows for it; this gate is off.
 *
 * Consumers: the resting composer (prompt-input.ts) and the waiting band (waiting-keys.ts). Pickers read arrows as they always did. */
import { wheelWanted } from './modes.js';
import { inlineHistoryMode } from './inline.js';

export const SWIPE_BURST_MS = 25;
export const SWIPE_TAIL_MS = 400;

const UP = '\u001b[A';
const DOWN = '\u001b[B';

export type ArrowSource = 'key' | 'swipe';
type Deliver = (key: string, source: ArrowSource) => void;

/** Whether a swipe can reach this program as arrow keys at all (the second case above). */
export function swipeArrowsPossible(env: NodeJS.ProcessEnv = process.env): boolean {
  return !wheelWanted(env) && !inlineHistoryMode(env);
}

export class SwipeArrowGate {
  private held: { key: string; at: number; deliver: Deliver } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastSwipeAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly enabled: () => boolean = () => swipeArrowsPossible()) {}

  /** Routes one key. True when the gate took it: an Up/Down, delivered now or within SWIPE_BURST_MS as 'key' or 'swipe'. False for
   * anything else (after any held arrow has gone out, as a key), and for every key while the gate is off: the caller handles it. */
  route(key: string, deliver: Deliver): boolean {
    if (!this.enabled()) return false;
    if (key !== UP && key !== DOWN) { this.release(); return false; }
    const now = Date.now();
    if (now - this.lastSwipeAt <= SWIPE_TAIL_MS) {
      this.lastSwipeAt = now;
      this.release('swipe');
      deliver(key, 'swipe');
      return true;
    }
    if (this.held) {
      // A second arrow inside the burst window: both are one swipe.
      this.lastSwipeAt = now;
      this.release('swipe');
      deliver(key, 'swipe');
      return true;
    }
    this.held = { key, at: now, deliver };
    this.timer = setTimeout(() => this.release(), SWIPE_BURST_MS);
    this.timer.unref?.();
    return true;
  }

  /** A held arrow goes out now (as a key unless told otherwise). */
  release(source: ArrowSource = 'key'): void {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    held.deliver(held.key, source);
  }
}
