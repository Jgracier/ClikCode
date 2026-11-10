/** A small terminal screen for tests: the escape sequences the inline painter emits, with
 * scrollback, so a test can read where rows landed. Not a general emulator. */
export class TestScreen {
  rows: string[][];
  scrollback: string[] = [];
  x = 0;
  y = 0;
  /** The scroll region (`CSI t;b r`), rows 0-based inclusive; the whole screen when unset. */
  private region: [number, number] | undefined;
  /** The alternate screen (`?1049h`): no saved lines, the main screen and its cursor kept for `?1049l`. */
  alt = false;
  private main: { rows: string[][]; x: number; y: number } | undefined;
  /** Every `?1049h` seen: a page is drawn on the alternate screen, and a test asks that it was. */
  entered = 0;
  constructor(readonly height: number, readonly width: number) {
    this.rows = Array.from({ length: height }, () => this.blank());
  }
  private blank(): string[] { return Array<string>(this.width).fill(' '); }
  private lineFeed(): void {
    if (this.y < this.height - 1) { this.y += 1; return; }
    if (this.alt) { this.rows.shift(); this.rows.push(this.blank()); return; }
    this.scrollback.push(this.rows[0]!.join('').trimEnd());
    this.rows.shift();
    this.rows.push(this.blank());
  }
  /** What a terminal does with its own screen when the window changes height. A shorter one drops the rows below the
   * cursor first, whatever they hold, and then pushes the top rows into the saved lines. A taller one pulls saved lines
   * back in above the screen and, once there are none, adds blank rows at the bottom. xterm.js pulls only while the
   * cursor is on the last row (`pullsAnywhere` false): a program whose cursor is parked on its composer, with its
   * footer below, gets blank rows added below instead. tmux pulls whatever the cursor does (`pullsAnywhere` true). A client
   * that keeps its content top-aligned never pulls (`pullsAnywhere` 'never'): the new rows are always blank, below. */
  resize(height: number, pullsAnywhere: boolean | 'never' = false): void {
    if (this.alt && this.main) {
      // The main screen changes size under the alternate one, by its own rules; the alternate screen only gets more or fewer rows.
      const page = { rows: this.rows, x: this.x, y: this.y };
      this.rows = this.main.rows; this.x = this.main.x; this.y = this.main.y; this.alt = false;
      this.resize(height, pullsAnywhere);
      this.main = { rows: this.rows, x: this.x, y: this.y };
      this.alt = true; this.rows = page.rows; this.x = page.x; this.y = page.y;
      while (this.rows.length > height) this.rows.pop();
      while (this.rows.length < height) this.rows.push(this.blank());
      this.y = Math.min(this.y, height - 1);
      return;
    }
    const cursorOnLastRow = this.y === this.rows.length - 1;
    while (this.rows.length > height) {
      if (this.y < this.rows.length - 1) this.rows.pop();
      else { this.scrollback.push(this.rows.shift()!.join('').trimEnd()); this.y -= 1; }
    }
    while (this.rows.length < height) {
      const pulled = pullsAnywhere === 'never' ? undefined : pullsAnywhere || cursorOnLastRow ? this.scrollback.pop() : undefined;
      if (pulled === undefined) this.rows.push(this.blank());
      else { this.rows.unshift([...pulled.padEnd(this.width)]); this.y += 1; }
    }
    (this as { height: number }).height = height;
  }
  write(data: string): void {
    // eslint-disable-next-line no-control-regex
    const token = /\u001b\[([?0-9;]*)([A-Za-z])|\u001b\][^\u0007]*\u0007|\r|\n|[^\u001b\r\n]/gu;
    for (const match of data.matchAll(token)) {
      const [all, args, final] = match;
      if (final) this.csi(args ?? '', final);
      else if (all === '\r') this.x = 0;
      else if (all === '\n') this.lineFeed();
      else if (!all.startsWith('\u001b')) {
        if (this.x >= this.width) continue; // wrap is off
        this.rows[this.y]![this.x] = all;
        this.x += 1;
      }
    }
  }
  private csi(args: string, final: string): void {
    const n = Number.parseInt(args, 10);
    const count = Number.isFinite(n) && n > 0 ? n : 1;
    switch (final) {
      case 'A': this.y = Math.max(0, this.y - count); break;
      case 'B': this.y = Math.min(this.height - 1, this.y + count); break;
      case 'G': this.x = Math.min(this.width - 1, count - 1); break;
      case 'h': case 'l':
        if (args === '?1049') {
          if (final === 'h' && !this.alt) {
            this.entered += 1;
            this.main = { rows: this.rows, x: this.x, y: this.y };
            this.rows = Array.from({ length: this.height }, () => this.blank());
            this.alt = true;
          } else if (final === 'l' && this.alt && this.main) {
            this.rows = this.main.rows; this.x = this.main.x; this.y = this.main.y;
            this.main = undefined; this.alt = false;
          }
        }
        break;
      case 'r': {
        const [top, bottom] = args.split(';').map((v) => Number.parseInt(v, 10));
        this.region = Number.isFinite(top) && Number.isFinite(bottom) ? [Math.max(0, top! - 1), Math.min(this.height - 1, bottom! - 1)] : undefined;
        this.x = 0; this.y = 0;
        break;
      }
      // SU / SD inside the region: the rows move, the ones pushed out are gone (no saved lines for a region scroll).
      case 'S': case 'T': {
        const [top, bottom] = this.region ?? [0, this.height - 1];
        for (let i = 0; i < count; i += 1) {
          if (final === 'S') { this.rows.splice(top, 1); this.rows.splice(bottom, 0, this.blank()); }
          else { this.rows.splice(bottom, 1); this.rows.splice(top, 0, this.blank()); }
        }
        break;
      }
      case 'H': {
        const [r, c] = args.split(';').map((v) => Number.parseInt(v, 10));
        this.y = Math.min(this.height - 1, Math.max(0, (r || 1) - 1));
        this.x = Math.min(this.width - 1, Math.max(0, (c || 1) - 1));
        break;
      }
      case 'J':
        if (args === '2') this.rows = this.rows.map(() => this.blank());
        else if (args === '3') { if (!this.alt) this.scrollback = []; }
        else {
          this.rows[this.y]!.fill(' ', this.x);
          for (let r = this.y + 1; r < this.height; r += 1) this.rows[r] = this.blank();
        }
        break;
      case 'K': this.rows[this.y]!.fill(' ', this.x); break;
      case 'L': for (let i = 0; i < count; i += 1) { this.rows.splice(this.y, 0, this.blank()); this.rows.pop(); } break;
      case 'M': for (let i = 0; i < count; i += 1) { this.rows.splice(this.y, 1); this.rows.push(this.blank()); } break;
      default: break;
    }
  }
  screen(): string[] { return this.rows.map((r) => r.join('').trimEnd()); }
  /** The main screen, whichever is showing. */
  mainScreen(): string[] { return (this.alt && this.main ? this.main.rows : this.rows).map((r) => r.join('').trimEnd()); }
}
