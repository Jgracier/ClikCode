/** When the bridge goes away or the installed ClikCode changes under it. */
import { unwatchFile, watchFile } from 'node:fs';

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

/** Watches the ClikCode entry file: a build is several files written in turn,
 * so a change is reported once it has settled. */
export class BuildWatcher {
  private entry: string | undefined;
  private settle: NodeJS.Timeout | undefined;

  constructor(private readonly onSettled: () => void) {}

  watch(entry: string): void {
    if (this.entry === entry) return;
    this.stop();
    this.entry = entry;
    watchFile(entry, { interval: 2_000 }, this.changed);
  }

  stop(): void {
    if (this.entry) unwatchFile(this.entry, this.changed);
    this.entry = undefined;
    if (this.settle) clearTimeout(this.settle);
    this.settle = undefined;
  }

  private readonly changed = (): void => {
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => { this.settle = undefined; this.onSettled(); }, 1_500);
  };
}
