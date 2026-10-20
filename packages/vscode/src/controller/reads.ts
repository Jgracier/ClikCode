/** Which of several overlapping asynchronous reads of one thing may still land.
 * Each read takes a ticket when it starts; only the newest ticket's answer is
 * current, so an older read finishing late cannot put older data back. */
export class LatestRead {
  private newest = 0;

  begin(): number { return ++this.newest; }

  current(ticket: number): boolean { return ticket === this.newest; }
}

/** A draft handed back to the composer once per failure. The bridge reports one
 * failed send both as its own `restore-draft` and as the worker's, and the
 * composer prepends what it is given, so the same words twice would double the
 * draft. The same text inside the window is the same failure. */
export class DraftRestores {
  private last: { text: string; at: number } | undefined;

  constructor(private readonly windowMs = 3_000) {}

  /** Whether `text` should be handed to the composer now. */
  take(text: string, now = Date.now()): boolean {
    if (this.last && this.last.text === text && now - this.last.at <= this.windowMs) return false;
    this.last = { text, at: now };
    return true;
  }
}
