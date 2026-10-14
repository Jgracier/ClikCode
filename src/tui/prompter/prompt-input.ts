/** The resting prompt: the composer read key by key, its palette, history, paste, and the answer it resolves. */
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { pastedText } from '../keys.js';
import { backslashNewline, composerVerticalMove, editWaitingComposer } from '../composer-edit.js';
import { commandPaletteMatches, completedCommandLine, composerRightArrowValue, exactPaletteCommand, type PaletteEntry } from '../command-palette.js';
import { stdin as input, stdout as output } from 'node:process';
import { nextCharacterIndex, previousCharacterIndex } from '../render/width.js';
import { expandPastes, insertPaste, keptPastes, removePlaceholderAt, type DraftWithPastes, type HeldPaste } from '../render/held-pastes.js';
import { takeTerminalKeys } from '../input-decoder.js';
import { SWIPE_ROWS, enterInputModes, popReadModes } from '../modes.js';
import { keyHint, keyHintFor } from '../../harness/protocol/wording.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { EXIT_CONFIRM_MS } from './state.js';

type PromptSettings = { cancellable?: boolean; rightArrowPalette?: boolean; leftArrowCommand?: string; signal?: AbortSignal; secret?: boolean };

/** What one key sees of the palette: its matches, whether they are an
 * argument's own values, and the rows the selection keys move through. */
type KeyContext = { matched: readonly PaletteEntry[]; completing: boolean; options: readonly PaletteEntry[] };

export async function question(
  this: TerminalHarnessPrompter,
  prompt: string,
  commands: readonly PaletteEntry[] = [],
  settings?: PromptSettings,
): Promise<string> {
  // Kept for the turn this prompt's answer starts: a turn in flight offers
  // the same commands, and this is where they are known.
  this.paletteCommands = commands;
  // Node sets isTTY once when it creates process.stdin and never changes
  // it, and this prompter is only built when stdin is a TTY
  // (terminalUiSupported). So this is a guard, not a wait: an earlier
  // version retried here for 10s after a vendor login, which could never
  // change the answer -- it only delayed the same exit.
  if (!input.isTTY) throw Object.assign(new Error('terminal input is closed'), { code: 'ERR_USE_AFTER_CLOSE' });
  lifecycle('window.prompt.start');
  return new Promise((resolveQuestion, rejectQuestion) => {
    new PromptSession(this, prompt, commands, settings, resolveQuestion, rejectQuestion).start();
  });
}

/** One prompt, from its first frame to the answer (or rejection) it ends in:
 * the draft, the palette selection, held pastes and history position. */
class PromptSession {
  private value: string;
  private cursor: number;
  private selected = 0;
  private historyIndex: number;
  // Long pastes, held out of the draft as placeholders (held-pastes.ts)
  // and put back when it is sent.
  private held: HeldPaste[] = [];
  // Reserved once for the whole prompt, not recomputed per keystroke: keeping the
  // footer band a fixed height is what stops the conversation area above it from
  // reflowing (and the cursor from jumping) as the number of matches narrows.
  private readonly paletteCapacity: number;
  private stopInput: () => void = () => {};
  private finished = false;
  private exitArmedAt = 0;

  constructor(
    private readonly p: TerminalHarnessPrompter,
    private readonly prompt: string,
    private readonly commands: readonly PaletteEntry[],
    private readonly settings: PromptSettings | undefined,
    private readonly resolveQuestion: (answer: string) => void,
    private readonly rejectQuestion: (reason: unknown) => void,
  ) {
    this.value = p.queuedDraft ?? '';
    p.queuedDraft = undefined;
    p.signedInJustNow = false;
    this.cursor = this.value.length;
    this.historyIndex = p.history.length;
    this.paletteCapacity = commands.length ? Math.min(commands.length, 8) + 2 : 0;
  }

  private draft(): DraftWithPastes { return { value: this.value, cursor: this.cursor, held: this.held }; }

  private apply(next: DraftWithPastes): void { this.value = next.value; this.cursor = next.cursor; this.held = [...next.held]; }

  // Every match, not the first eight: paint() windows a longer list, so
  // the selection can reach all of them.
  private matches() { return commandPaletteMatches(this.value, this.commands); }

  // The row that runs is the row that is highlighted. When what was typed
  // names a command outright (`/new`), that command's row starts
  // highlighted, wherever its group ranks it -- so Enter and Right Arrow,
  // which both run the highlighted row, run what was typed.
  private highlightFor(text: string): number {
    const typed = exactPaletteCommand(text, this.commands)?.toLowerCase();
    if (!typed) return 0;
    const rows = commandPaletteMatches(text, this.commands);
    const at = rows.findIndex((row) => row.value.toLowerCase() === typed || row.aliases?.some((alias) => alias.toLowerCase() === typed));
    return Math.max(0, at);
  }

  // Running a command clears the palette and the typed command first, so
  // whatever it opens next -- a picker, a sign-in -- never has the
  // finished list and its `/command` left on screen around it.
  private runCommand(line: string): void {
    this.value = '';
    this.cursor = 0;
    this.selected = 0;
    this.draw();
    this.finish(line);
  }

  private draw(): void {
    const { p, value, prompt, settings } = this;
    const options = commandPaletteMatches(value, this.commands);
    if (this.selected >= options.length) this.selected = 0;
    if (options.length) {
      // After a space the palette is that command's own values to choose
      // from, or -- for a free-text argument -- just its hint.
      const hint = options[0]?.completes ? [keyHintFor('↑↓', 'choose'), keyHintFor('tab', 'fill in'), keyHint('apply'), keyHintFor('esc', 'clear')].join(' · ')
        : value.includes(' ') ? `${keyHintFor('enter', 'run')} · ${keyHintFor('esc', 'clear')}` : undefined;
      p.paint(value, options, this.selected, prompt, this.cursor, { capacity: this.paletteCapacity, ...(hint ? { hint } : {}) });
      p.paletteActive = true;
      return;
    }
    p.paletteActive = false;
    // Palette closure and ordinary typing are both complete frames, so
    // the transcript immediately reclaims any previously reserved rows.
    // A secret (an API key typed into a sign-in) is drawn as dots.
    p.paint(settings?.secret ? '•'.repeat(value.length) : value, [], 0, prompt, this.cursor);
  }

  /** The prompt is over, however it ended: the keyboard and the read
   * modes are given back, once. False when it had already ended. */
  private release(): boolean {
    if (this.finished) return false;
    this.finished = true;
    this.p.paletteActive = false;
    this.stopInput();
    output.write(`${popReadModes()}\u001b[?25h`);
    this.p.cursorShown = true;
    this.p.resumeInput = undefined;
    return true;
  }

  private finish(answer: string): void {
    if (!this.release()) return;
    const { p, settings } = this;
    lifecycle('window.prompt.end', { how: !answer ? 'empty' : answer.startsWith('/') ? `command ${answer.split(/\s/, 1)[0]}` : 'message' });
    p.clearTransientNotice();
    if (answer) p.panelState = undefined;
    // A line sent is done with the mention it was looking at.
    if (answer) p.mentionFocus = undefined;
    // The submitted line is the conversation's now. Leaving it in the
    // composer made the next idle check look like a draft still in progress.
    p.composer = { ...p.composer, text: '' };
    if (answer && !settings?.secret && !answer.startsWith('/') && p.history[p.history.length - 1] !== answer) p.history.push(answer);
    this.resolveQuestion(answer);
  }

  // Opt-in, not a default: this same question() drives the persistent
  // chat composer too, where Esc doing nothing is the existing,
  // intentional behavior (there's nothing to "cancel" mid-draft the way
  // there is for a one-off prompt). Callers that need real cancel
  // semantics -- like the API-key env-var-name prompt, previously
  // "esc doesn't cancel" with no way out short of Ctrl+C -- pass
  // { cancellable: true } and get a real rejection to catch, instead of
  // an empty string indistinguishable from "accepted the default".
  private cancel(): void {
    if (!this.release()) return;
    this.rejectQuestion(Object.assign(new Error('cancelled'), { code: 'ERR_PROMPT_CANCELLED' }));
  }

  // Something other than the keyboard needs the screen: a turn this
  // window did not start is running (worker/turn-bridge.ts). The draft is
  // kept for the next prompt, and the caller is told why it ended.
  private interrupt(): void {
    if (!this.release()) return;
    // Kept whole: a placeholder in the next prompt's draft would have
    // lost the paste it stood for.
    const kept = expandPastes(this.value, this.held);
    if (kept) this.p.queuedDraft = this.p.queuedDraft ? `${this.p.queuedDraft}\n${kept}` : kept;
    this.rejectQuestion(Object.assign(new Error('interrupted'), { code: 'ERR_PROMPT_INTERRUPTED' }));
  }

  private listen(): void {
    this.stopInput = takeTerminalKeys((key) => { if (!this.finished) this.handleKey(key); });
    output.write(enterInputModes());
  }

  start(): void {
    const { p, settings } = this;
    if (settings?.signal?.aborted) {
      p.queuedDraft = this.value || undefined;
      this.rejectQuestion(Object.assign(new Error('interrupted'), { code: 'ERR_PROMPT_INTERRUPTED' }));
      return;
    }
    settings?.signal?.addEventListener('abort', () => this.interrupt(), { once: true });
    p.resumeInput = () => { this.stopInput(); if (!this.finished) this.listen(); };
    // Typed ahead under a sign-in: before anything the terminal sends
    // next (listen() hands that on, on a later tick than this one). What
    // follows an Enter that sent this prompt is the next prompt's draft.
    const ahead = p.typedAhead.splice(0);
    if (ahead.length) {
      process.nextTick(() => {
        for (const [index, key] of ahead.entries()) {
          if (!this.finished) { this.handleKey(key); continue; }
          const rest = ahead.slice(index).filter((item) => !item.startsWith('\u001b') && item.charCodeAt(0) >= 0x20 && item !== '\u007f').join('');
          if (rest) p.queuedDraft = p.queuedDraft ? `${p.queuedDraft}${rest}` : rest;
          break;
        }
      });
    }
    this.listen();
    this.draw();
  }

  private handleKey(key: string): void {
    const { p } = this;
    if (key === '\u000c') {
      p.requestRedraw('repair');
      p.forgetScreenPosition();
      return this.draw();
    }
    const matched = this.matches();
    // `options` drives selection keys. While an argument is being typed the
    // palette is only a hint -- unless it is listing the argument's own
    // values, which are chosen exactly like commands are.
    const completing = Boolean(matched[0]?.completes);
    const context: KeyContext = { matched, completing, options: this.value.includes(' ') && !completing ? [] : matched };
    if (this.pasteAndControlKey(key, context)) return;
    if (this.commitKey(key, context)) return;
    if (this.navigationKey(key, context)) return;
    this.editKey(key);
  }

  /** Paste, Ctrl+O/Z/C/D, and Esc: true when the key was handled here. */
  private pasteAndControlKey(key: string, { matched }: KeyContext): boolean {
    const { p, settings } = this;
    const pasted = pastedText(key);
    if (pasted !== undefined) {
      // Pasted newlines are content, not Enter. Splitting on them is what
      // turned one pasted block into a queue of separate messages. A long
      // one is held as `[Pasted text #1 +40 lines]`.
      const next = insertPaste(this.draft(), pasted, p.pasteCount + 1);
      if (next.held.length > this.held.length) p.pasteCount += 1;
      this.apply(next);
      this.selected = 0;
      this.draw();
      return true;
    }
    // Ctrl+O: the held pastes back in the draft as text, to read or edit.
    if (key === '\u000f') {
      if (!this.held.length) { p.handleScrollKey(key); return true; }
      this.cursor = expandPastes(this.value.slice(0, this.cursor), this.held).length;
      this.value = expandPastes(this.value, this.held);
      this.held = [];
      this.draw();
      return true;
    }
    if (key === '\u001b' && p.groupPanel) { p.closeGroupPanel(); return true; }
    if (key === '\u001a') { p.suspendToShell(); return true; }
    // Esc on an empty composer, no panel open, stops a turn parked for
    // the quota reset.
    if (key === '\u001b' && !this.value && !p.panelState && p.idleEscape) { const stop = p.idleEscape; p.idleEscape = undefined; stop(); return true; }
    if (!this.value && !matched.length && p.panelKey(key)) { this.draw(); return true; }
    if (key === '\u0003') {
      // Ctrl+C clears a draft first. Leaving takes a second press, because
      // the same key also interrupts a turn and is pressed by reflex.
      if (this.value) { this.value = ''; this.cursor = 0; this.held = []; this.selected = 0; this.historyIndex = p.history.length; this.draw(); return true; }
      if (Date.now() - this.exitArmedAt <= EXIT_CONFIRM_MS) { this.finish('/exit'); return true; }
      this.exitArmedAt = Date.now();
      p.showTransientNotice('Press Ctrl+C again to exit', EXIT_CONFIRM_MS, () => this.draw());
      this.draw();
      return true;
    }
    if (this.exitArmedAt) { this.exitArmedAt = 0; p.clearTransientNotice(); }
    // Ctrl+D is end-of-input only on an empty draft; otherwise it deletes
    // forward like every other line editor.
    if (key === '\u0004' && !this.value) { this.finish('/exit'); return true; }
    if (key === '\u001b' && settings?.cancellable) { this.cancel(); return true; }
    if (key === '\u001b' && matched.length) {
      this.value = '';
      this.cursor = 0;
      this.selected = 0;
      this.draw();
      return true;
    }
    return false;
  }

  /** Enter and Tab: true when the key was handled here. */
  private commitKey(key: string, { completing, options }: KeyContext): boolean {
    const { value, cursor, commands, selected } = this;
    if (key === '\r') {
      const continued = options.length ? undefined : backslashNewline(value, cursor);
      if (continued) { this.value = continued.value; this.cursor = continued.cursor; this.draw(); return true; }
      // A value from the command's own list: what was typed wins when it
      // IS a value, otherwise the highlighted one.
      if (completing) { this.runCommand(completedCommandLine(value, commands, selected)); return true; }
      // The highlighted command, bare. One that takes a value (model,
      // effort, permissions, account, resume) opens its own picker, titled
      // and starting on the current value; the values are listed here
      // only once one is being typed (`/model op`).
      if (options.length && value.startsWith('/') && !value.includes(' ')) { this.runCommand(options[selected]!.value); return true; }
      if (value.startsWith('/')) { this.runCommand(expandPastes(value, this.held)); return true; }
      this.finish(expandPastes(value, this.held));
      return true;
    }
    if (key === '\t' && options.length) {
      // A value fills in as it is, ready to run or to keep editing; a
      // command that takes an argument completes ready for it.
      this.value = completing ? options[selected]!.value
        : `${options[selected]!.value}${options[selected]!.argHint || options[selected]!.argValues ? ' ' : ''}`;
      this.cursor = this.value.length;
      this.selected = 0;
      this.draw();
      return true;
    }
    return false;
  }

  private historyStep(direction: -1 | 1): void {
    if (direction < 0 && this.historyIndex > 0) this.historyIndex -= 1;
    else if (direction > 0) this.historyIndex = Math.min(this.p.history.length, this.historyIndex + 1);
    else return;
    this.value = this.p.history[this.historyIndex] ?? '';
    this.cursor = this.value.length;
  }

  /** Arrows and history keys: true when the key was handled here.
   * Up/Down navigate palette options; otherwise they move through a
   * multi-line draft and fall through to input history from its first
   * and last line. (Wheel/touch scrolling belongs to the terminal and
   * never arrives as these keys.) Ctrl+P/Ctrl+N always mean history. */
  private navigationKey(key: string, { completing, options }: KeyContext): boolean {
    const { p, value, commands, settings } = this;
    if (key === '\u001b[A' || key === '\u001b[B') {
      const direction = key === '\u001b[A' ? -1 : 1;
      if (options.length) { this.selected = (this.selected + direction + options.length) % options.length; this.draw(); return true; }
      // An empty composer means the conversation is what is being looked
      // at, so the arrows read it. Recorded from a real phone client: a
      // swipe arrives as arrow keys and nothing else -- no mouse report in
      // any encoding, and no page keys on the keyboard -- so on that
      // client this is the only way back through the conversation at all.
      // History keeps Ctrl+P and Ctrl+N, which is where it always was as
      // well, and the arrows still move through a draft once there is one.
      if (!value) {
        if (p.scrollTranscript(direction === -1 ? SWIPE_ROWS : -SWIPE_ROWS)) return true;
        if (direction === 1 && p.noteReadingDirection()) return true;
      }
      const moved = composerVerticalMove(value, this.cursor, direction);
      if (moved !== undefined) this.cursor = moved;
      else this.historyStep(direction);
      this.draw();
      return true;
    }
    if (key === '\u0010' && !options.length) { this.historyStep(-1); this.draw(); return true; }
    if (key === '\u000e' && !options.length) { this.historyStep(1); this.draw(); return true; }
    if (key === '\u001b[D') {
      // With nothing typed there is nothing for the arrow to move through,
      // so the chat composer spends it on its conversations: what is
      // running now, and below it what can be resumed.
      if (!value && settings?.leftArrowCommand) { this.finish(settings.leftArrowCommand); return true; }
      // Backing out of the command list clears it; inside an argument the
      // arrow edits, as it does in any line.
      if (options.length && !completing) { this.value = ''; this.cursor = 0; this.selected = 0; }
      else this.cursor = previousCharacterIndex(value, this.cursor);
      this.draw();
      return true;
    }
    if (key === '\u001b[C') {
      // Right Arrow is deliberately identical to Enter.
      if (completing && this.cursor >= value.length) { this.runCommand(completedCommandLine(value, commands, this.selected)); return true; }
      // When the palette is open (any options match), right arrow selects/runs the highlighted option
      if (options.length && this.cursor >= value.length) { this.runCommand(options[this.selected]!.value); return true; }
      const paletteValue = composerRightArrowValue(value, options.length > 0, settings?.rightArrowPalette);
      if (paletteValue) {
        this.value = paletteValue;
        this.cursor = paletteValue.length;
        this.selected = 0;
        this.draw();
        return true;
      }
      this.cursor = nextCharacterIndex(value, this.cursor);
      this.draw();
      return true;
    }
    return false;
  }

  /** Page keys, then text editing. */
  private editKey(key: string): void {
    const { p } = this;
    // Page keys read the conversation rather than edit the draft: the
    // alternate screen has no terminal scrollback behind it, so this is
    // the only way back through what was said. Shift+Up/Down does the
    // same a row at a time. Esc, which already clears a draft, also
    // returns to the live end.
    if (p.handleScrollKey(key)) return;
    // Escape returns to the live end here; in the waiting band it keeps
    // meaning interrupt, and a new turn rejoins on its own.
    if (key === '\u001b' && p.scrolledBack) { p.scrollTranscript(-Number.MAX_SAFE_INTEGER); return; }
    // A placeholder is deleted whole, its paste with it.
    const removed = key === '\u007f' || key === '\b' ? removePlaceholderAt(this.draft(), 'back')
      : key === '\u001b[3~' || key === '\u0004' ? removePlaceholderAt(this.draft(), 'forward') : undefined;
    if (removed) { this.apply(removed); this.selected = this.highlightFor(this.value); this.draw(); return; }
    // Everything else is text editing, shared with the waiting composer.
    const edited = editWaitingComposer(this.value, this.cursor, key);
    if (!edited.changed) return;
    if (edited.value !== this.value) this.selected = this.highlightFor(edited.value);
    this.value = edited.value;
    this.cursor = edited.cursor;
    // An edit that broke a placeholder drops its paste.
    this.held = keptPastes(this.value, this.held);
    this.draw();
  }
}
