/** When the bridge goes away. (A newer installed ClikCode is the bridge's own
 * to notice: it says `retiring` and exits once quiet, src/ide/bridge-retire.ts,
 * and the controller reconnects at once onto the same chat.) */

/** A bridge that dies after it was ready (killed, crashed, the machine slept
 * through it) comes back on its own, onto the same conversation; the worker
 * kept the turn going meanwhile. Once a minute at most, so a bridge that
 * cannot stay up ends at the banner instead of a loop. */
export class AutoReconnect {
  private last = 0;

  /** Whether an exit should be reconnected from now (and counts it if so). */
  take(wasReady: boolean, now = Date.now()): boolean {
    if (!wasReady || now - this.last <= 60_000) return false;
    this.last = now;
    return true;
  }
}
