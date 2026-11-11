/** The composer: the one draft the conversation is typed into, owned by the prompter and the same at rest and while a turn runs.
 *
 * Its text, cursor, held pastes and place in the prompt history live here and nowhere else. The resting prompt (prompt-input.ts)
 * and the waiting band (waiting-keys.ts) both edit it, by the same key rules (draftKey), and every frame draws it from here: a
 * draft typed at rest is the turn's draft when one starts, and still the draft when it ends. Nothing hands it from one to the
 * other. */
import { pastedText } from '../keys.js';
import { composerVerticalMove, editWaitingComposer } from '../composer-edit.js';
import { expandPastes, insertPaste, keptPastes, removePlaceholderAt, type DraftWithPastes, type HeldPaste } from '../render/held-pastes.js';
import type { TerminalHarnessPrompter } from '../prompter.js';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const CTRL_O = '\u000f';

export class Composer {
  text = '';
  cursor = 0;
  /** Long pastes held out of the text as placeholders (held-pastes.ts), put back when it is sent. */
  held: HeldPaste[] = [];
  /** The history entry shown, or undefined on the draft itself. */
  private recalled: number | undefined;
  /** The draft as typed, kept while history is recalled over it: Down past the newest entry brings it back. */
  private stashed: DraftWithPastes | undefined;

  get draft(): DraftWithPastes { return { value: this.text, cursor: this.cursor, held: this.held }; }

  /** The text as it is sent: every held paste back in its place. */
  expanded(): string { return expandPastes(this.text, this.held); }

  /** Replace the draft (a new text, or one set aside coming back): the history position starts again from it. */
  set(next: DraftWithPastes | string): void {
    const draft = typeof next === 'string' ? { value: next, cursor: next.length, held: [] } : next;
    this.apply(draft);
    this.recalled = undefined;
    this.stashed = undefined;
  }

  clear(): void { this.set(''); }

  /** The draft, taken out (set aside while the composer answers something else); put it back with set(). */
  take(): DraftWithPastes {
    const taken = { value: this.text, cursor: this.cursor, held: [...this.held] };
    this.clear();
    return taken;
  }

  /** A message handed back (taken out of the queue, a send that failed, a turn that never started): in front of what is typed,
   * since it was written first, with the cursor at its end. */
  restore(message: string): void {
    if (!message) return;
    const rest = this.text;
    this.set({ value: rest ? `${message}\n${rest}` : message, cursor: message.length, held: this.held });
  }

  /** A paste at the cursor, held as a placeholder when it is long. True when it was held (it took the paste number). */
  paste(pasted: string, number: number): boolean {
    const next = insertPaste(this.draft, pasted, number);
    const held = next.held.length > this.held.length;
    this.apply(next);
    return held;
  }

  /** The held pastes back in the text, to read or edit. False when none is held. */
  expandHeld(): boolean {
    if (!this.held.length) return false;
    this.cursor = expandPastes(this.text.slice(0, this.cursor), this.held).length;
    this.text = this.expanded();
    this.held = [];
    return true;
  }

  /** A text-editing key (composer-edit.ts), a placeholder deleted whole. False when the key is not an edit. */
  edit(key: string): boolean {
    const removed = key === '\u007f' || key === '\b' ? removePlaceholderAt(this.draft, 'back')
      : key === '\u001b[3~' || key === '\u0004' ? removePlaceholderAt(this.draft, 'forward') : undefined;
    if (removed) { this.apply(removed); return true; }
    const edited = editWaitingComposer(this.text, this.cursor, key);
    if (!edited.changed) return false;
    this.text = edited.value;
    this.cursor = edited.cursor;
    // An edit that broke a placeholder drops its paste.
    this.held = keptPastes(this.text, this.held);
    return true;
  }

  /** Up or Down as a key: a line of a multi-line draft, else the next or previous prompt sent. Down on the draft itself goes
   * nowhere -- it never empties the composer. */
  step(direction: -1 | 1, history: readonly string[]): void {
    const moved = composerVerticalMove(this.text, this.cursor, direction);
    if (moved !== undefined) { this.cursor = moved; return; }
    this.historyStep(direction, history);
  }

  historyStep(direction: -1 | 1, history: readonly string[]): void {
    const at = this.recalled ?? history.length;
    if (direction < 0) {
      if (at <= 0) return;
      // Leaving the draft: it is kept, whatever it is, and comes back when Down returns past the newest entry.
      if (this.recalled === undefined) this.stashed = { value: this.text, cursor: this.cursor, held: [...this.held] };
      this.recalled = at - 1;
    } else {
      if (this.recalled === undefined) return;
      this.recalled = at + 1;
    }
    if (this.recalled >= history.length) {
      const draft = this.stashed ?? { value: '', cursor: 0, held: [] };
      this.recalled = undefined;
      this.stashed = undefined;
      this.apply(draft);
      return;
    }
    const entry = history[this.recalled] ?? '';
    this.apply({ value: entry, cursor: entry.length, held: [] });
  }

  private apply(next: DraftWithPastes): void { this.text = next.value; this.cursor = next.cursor; this.held = [...next.held]; }
}

/** A key for a draft, by the same rules at rest and while a turn runs: a paste (held when long), Up/Down pressed as keys (the
 * draft's lines, then its history), Ctrl+P/Ctrl+N (history), Home/End on an empty draft (the conversation's first row and live
 * end), the keys that read the conversation (page keys, the wheel, Esc back to the live end), and text editing. Whatever is
 * particular to a mode -- the palette's selection, Enter, Left and Right on an empty draft, Esc and Ctrl+C -- the mode reads
 * first. A swipe never reaches here (swipe-arrows.ts). Returns what the key did: `edit` changed the draft (draw it), `read`
 * moved the view (already drawn), undefined: not a draft key. */
export function draftKey(p: TerminalHarnessPrompter, composer: Composer, key: string): 'edit' | 'read' | undefined {
  const pasted = pastedText(key);
  if (pasted !== undefined) {
    if (composer.paste(pasted, p.pasteCount + 1)) p.pasteCount += 1;
    return 'edit';
  }
  if (key === CTRL_O && composer.expandHeld()) return 'edit';
  if (key === UP || key === DOWN) { composer.step(key === UP ? -1 : 1, p.history); return 'edit'; }
  if (key === '\u0010' || key === '\u000e') { composer.historyStep(key === '\u0010' ? -1 : 1, p.history); return 'edit'; }
  // Home and End (the decoder reads them as Ctrl+A and Ctrl+E) on an empty draft go to the first and the last row of the conversation.
  if (!composer.text && (key === '\u0001' || key === '\u0005')) {
    p.scrollTranscript(key === '\u0001' ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER);
    return 'read';
  }
  // Page keys read the conversation rather than edit the draft: the alternate screen has no terminal scrollback behind it, so
  // this is the only way back through what was said. Esc, scrolled back, returns to the live end.
  if (p.handleScrollKey(key)) return 'read';
  if (key === '\u001b' && p.scrolledBack) { p.scrollTranscript(-Number.MAX_SAFE_INTEGER); return 'read'; }
  return composer.edit(key) ? 'edit' : undefined;
}
