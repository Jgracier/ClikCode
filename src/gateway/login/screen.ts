/**
 * What a vendor's sign-in shows, as a terminal would show it.
 *
 * Reading its output as lines works for a vendor that prints line by line,
 * and for nothing that draws: a full-screen menu (Hermes's at a real
 * terminal size) puts every option at an absolute position, and an Ink or
 * clack prompt redraws itself in place. This keeps the grid a terminal
 * would: text at the cursor, cursor moves, erases, scrolling, the alternate
 * screen. Only what sign-in screens use; colours and modes are ignored.
 */

export interface ScreenState {
  /** The rows, trailing spaces trimmed. */
  lines: string[];
  row: number;
  column: number;
}

export class Screen {
  private grid: string[][];
  private row = 0;
  private column = 0;
  private saved = { row: 0, column: 0 };
  private pending = '';

  constructor(private readonly rows: number, private readonly columns: number) {
    this.grid = Array.from({ length: rows }, () => this.blank());
  }

  private blank(): string[] { return Array.from({ length: this.columns }, () => ' '); }

  private lineFeed(): void {
    if (this.row === this.rows - 1) { this.grid.shift(); this.grid.push(this.blank()); } else this.row += 1;
  }

  private put(char: string): void {
    if (this.column >= this.columns) { this.column = 0; this.lineFeed(); }
    this.grid[this.row]![this.column] = char;
    this.column += 1;
  }

  private clamp(): void {
    this.row = Math.max(0, Math.min(this.rows - 1, this.row));
    this.column = Math.max(0, Math.min(this.columns - 1, this.column));
  }

  private eraseLine(mode: number, row = this.row): void {
    const line = this.grid[row]!;
    const [from, to] = mode === 0 ? [this.column, this.columns] : mode === 1 ? [0, this.column + 1] : [0, this.columns];
    for (let index = from; index < to; index += 1) line[index] = ' ';
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) { this.grid = Array.from({ length: this.rows }, () => this.blank()); return; }
    this.eraseLine(mode);
    const rows = mode === 0 ? [this.row + 1, this.rows] : [0, this.row];
    for (let index = rows[0]!; index < rows[1]!; index += 1) this.grid[index] = this.blank();
  }

  private csi(params: string, final: string): void {
    if (params.startsWith('?')) {
      // The alternate screen starts blank.
      if (/\b(?:1049|47|1047)\b/.test(params) && (final === 'h' || final === 'l')) this.eraseDisplay(2);
      return;
    }
    if (/^[<=>]/.test(params)) return;
    const numbers = params.split(';').map((part) => Number.parseInt(part, 10));
    const n = (index: number, fallback = 1): number => (Number.isFinite(numbers[index]) && numbers[index]! > 0 ? numbers[index]! : fallback);
    switch (final) {
      case 'A': this.row -= n(0); break;
      case 'B': case 'e': this.row += n(0); break;
      case 'C': case 'a': this.column += n(0); break;
      case 'D': this.column -= n(0); break;
      case 'E': this.row += n(0); this.column = 0; break;
      case 'F': this.row -= n(0); this.column = 0; break;
      case 'G': case '`': this.column = n(0) - 1; break;
      case 'd': this.row = n(0) - 1; break;
      case 'H': case 'f': this.row = n(0) - 1; this.column = n(1) - 1; break;
      case 'J': this.eraseDisplay(Number.isFinite(numbers[0]) ? numbers[0]! : 0); break;
      case 'K': this.eraseLine(Number.isFinite(numbers[0]) ? numbers[0]! : 0); break;
      case 'X': for (let index = 0; index < n(0) && this.column + index < this.columns; index += 1) this.grid[this.row]![this.column + index] = ' '; break;
      case 'P': { const line = this.grid[this.row]!; line.splice(this.column, n(0)); while (line.length < this.columns) line.push(' '); break; }
      case '@': { const line = this.grid[this.row]!; line.splice(this.column, 0, ...Array.from({ length: n(0) }, () => ' ')); line.length = this.columns; break; }
      case 'L': for (let index = 0; index < n(0); index += 1) { this.grid.splice(this.row, 0, this.blank()); this.grid.length = this.rows; } break;
      case 'M': for (let index = 0; index < n(0); index += 1) { this.grid.splice(this.row, 1); this.grid.push(this.blank()); } break;
      case 'S': for (let index = 0; index < n(0); index += 1) { this.grid.shift(); this.grid.push(this.blank()); } break;
      case 'T': for (let index = 0; index < n(0); index += 1) { this.grid.pop(); this.grid.unshift(this.blank()); } break;
      case 's': this.saved = { row: this.row, column: this.column }; break;
      case 'u': ({ row: this.row, column: this.column } = this.saved); break;
      default: break;
    }
    this.clamp();
  }

  write(text: string): void {
    const data = this.pending + text;
    this.pending = '';
    let index = 0;
    while (index < data.length) {
      const char = data[index]!;
      if (char === '\u001b') {
        const rest = data.slice(index);
        const csi = /^\u001b\[([0-9;?<=>]*)[ -/]*([@-~])/.exec(rest);
        if (csi) { this.csi(csi[1]!, csi[2]!); index += csi[0].length; continue; }
        const osc = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/.exec(rest) ?? /^\u001b[P^_][^\u001b]*\u001b\\/.exec(rest);
        if (osc) { index += osc[0].length; continue; }
        if (rest.length >= 2 && /^\u001b[78]/.test(rest)) {
          if (rest[1] === '7') this.saved = { row: this.row, column: this.column };
          else ({ row: this.row, column: this.column } = this.saved);
          index += 2; continue;
        }
        if (/^\u001b[()#%][\s\S]/.test(rest)) { index += 3; continue; }
        if (/^\u001b[=>DEMc]/.test(rest)) {
          if (rest[1] === 'D' || rest[1] === 'E') { this.lineFeed(); if (rest[1] === 'E') this.column = 0; }
          if (rest[1] === 'M') { if (this.row === 0) { this.grid.pop(); this.grid.unshift(this.blank()); } else this.row -= 1; }
          index += 2; continue;
        }
        // A sequence split across two reads: keep it for the next.
        if (/^\u001b(?:\[[0-9;?<=>]*[ -/]*|\][^\u0007\u001b]*|[P^_][^\u001b]*|[()#%])?$/.test(rest)) { this.pending = rest; return; }
        index += 1; continue;
      }
      if (char === '\r') this.column = 0;
      // A pty translates \n to \r\n (onlcr); text from anywhere else is read
      // the same way.
      else if (char === '\n') { this.column = 0; this.lineFeed(); }
      else if (char === '\b') this.column = Math.max(0, this.column - 1);
      else if (char === '\t') this.column = Math.min(this.columns - 1, (Math.floor(this.column / 8) + 1) * 8);
      else if (char >= ' ' && char !== '\u007f') this.put(char);
      index += 1;
    }
  }

  state(): ScreenState {
    const lines = this.grid.map((line) => line.join('').trimEnd());
    while (lines.length > this.row + 1 && !lines.at(-1)) lines.pop();
    return { lines, row: this.row, column: this.column };
  }
}
