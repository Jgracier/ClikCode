/** When the bridge goes away. (A newer installed ClikCode is the bridge's own
 * to notice: it says `retiring` and exits once quiet, src/ide/bridge-retire.ts,
 * and the controller reconnects at once onto the same chat.) */

/** The pause before each reconnect after a drop, the shape of the board's
 * (src/remote/connection.ts): the first is at once, then a growing wait. */
export const RECONNECT_PAUSES_MS: readonly number[] = [0, 1_000, 2_000, 5_000, 10_000, 30_000];

/** A bridge that stays ready this long was a working connection: the next
 * drop starts the pauses again. Kept because without it a bridge that dies
 * every few seconds would reconnect for ever instead of ending at the banner. */
export const STABLE_MS = 60_000;

/** A bridge that dies after it was ready (killed, crashed, the machine slept
 * through it, the link dropped) comes back on its own, onto the same
 * conversation; the worker kept the turn going meanwhile. A second drop soon
 * after is retried too, after a longer pause; only a bridge that cannot stay
 * up through every pause ends at the banner. */
export class AutoReconnect {
  private attempt = 0;
  private readySince: number | undefined;
  /** A reconnect is under way: an exit before it is ready is another drop, not a bridge that never worked. */
  private reconnecting = false;

  /** The bridge answered `ready`. */
  ready(now = Date.now()): void {
    this.readySince = now;
    this.reconnecting = false;
  }

  /** How long to wait before reconnecting after an exit, or undefined when it
   * should not (it had never been ready and none is under way, or it has dropped through every pause). */
  next(wasReady: boolean, now = Date.now()): number | undefined {
    if (!wasReady && !this.reconnecting) return undefined;
    if (this.readySince !== undefined && now - this.readySince >= STABLE_MS) this.attempt = 0;
    this.readySince = undefined;
    if (this.attempt >= RECONNECT_PAUSES_MS.length) { this.reconnecting = false; return undefined; }
    this.reconnecting = true;
    return RECONNECT_PAUSES_MS[this.attempt++];
  }
}
