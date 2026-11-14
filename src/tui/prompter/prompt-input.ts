/** The resting prompt: the composer read key by key, its palette, history, paste, and the answer it resolves. */
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { backslashNewline } from '../composer-edit.js';
import { commandPaletteMatches, completedCommandLine, composerRightArrowValue, exactPaletteCommand, type PaletteEntry } from '../command-palette.js';
import { stdin as input } from 'node:process';
import { nextCharacterIndex, previousCharacterIndex } from '../render/width.js';
import { takeTerminalKeys } from '../input-decoder.js';
import { SWIPE_ROWS } from '../modes.js';
import { keyHint, keyHintFor } from '../../harness/protocol/wording.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import type { ArrowSource } from '../swipe-arrows.js';
import { EXIT_CONFIRM_MS } from './state.js';
import { Composer, draftKey } from './composer.js';

/** `conversation`: this is the conversation's composer -- its draft is the prompter's (composer.ts), kept across turns, and what
 * it sends is history. Otherwise the question is a field of its own (a name, a model id, a key), starting empty. */
type PromptSettings = { conversation?: boolean; cancellable?: boolean; rightArrowPalette?: boolean; leftArrowCommand?: string; signal?: AbortSignal; secret?: boolean };

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

/** One prompt, from its first frame to the answer (or rejection) it ends in: the palette and its selection, over the draft it
 * edits (composer.ts). */
class PromptSession {
  private readonly composer: Composer;
  private selected = 0;
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
    this.composer = settings?.conversation ? p.composer : new Composer();
    this.paletteCapacity = commands.length ? Math.min(commands.length, 8) + 2 : 0;
  }

  // Every match, not the first eight: paint() windows a longer list, so
  // the selection can reach all of them.
  private matches() { return commandPaletteMatches(this.composer.text, this.p.paletteCommands); }

  // The row that runs is the row that is highlighted. When what was typed
  // names a command outright (`/new`), that command's row starts
  // highlighted, wherever its group ranks it -- so Enter and Right Arrow,
  // which both run the highlighted row, run what was typed.
  private highlightFor(text: string): number {
    const typed = exactPaletteCommand(text, this.p.paletteCommands)?.toLowerCase();
    if (!typed) return 0;
    const rows = commandPaletteMatches(text, this.p.paletteCommands);
    const at = rows.findIndex((row) => row.value.toLowerCase() === typed || row.aliases?.some((alias) => alias.toLowerCase() === typed));
    return Math.max(0, at);
  }

  // Running a command clears the palette and the typed command first, so
  // whatever it opens next -- a picker, a sign-in -- never has the
  // finished list and its `/command` left on screen around it.
  private runCommand(line: string): void {
    this.composer.clear();
    this.selected = 0;
    this.draw();
    this.finish(line);
  }

  /** This prompt's frame: the draft, the palette under it, a secret drawn as dots. What the prompter draws as the current state
   * while this prompt is open (paintCurrent). */
  draw(): void {
    const { p, prompt, settings } = this;
    const { text: value, cursor } = this.composer;
    const options = commandPaletteMatches(value, this.p.paletteCommands);
    if (this.selected >= options.length) this.selected = 0;
    if (options.length) {
      // After a space the palette is that command's own values to choose
      // from, or -- for a free-text argument -- just its hint.
      const hint = options[0]?.completes ? [keyHintFor('↑↓', 'choose'), keyHintFor('tab', 'fill in'), keyHint('apply'), keyHintFor('esc', 'clear')].join(' · ')
        : value.includes(' ') ? `${keyHintFor('enter', 'run')} · ${keyHintFor('esc', 'clear')}` : undefined;
      p.paint(value, options, this.selected, prompt, cursor, { capacity: this.paletteCapacity, ...(hint ? { hint } : {}) });
      return;
    }
    // Palette closure and ordinary typing are both complete frames, so
    // the transcript immediately reclaims any previously reserved rows.
    // A secret (an API key typed into a sign-in) is drawn as dots.
    p.paint(settings?.secret ? '•'.repeat(value.length) : value, [], 0, prompt, cursor);
  }

  /** The prompt is over, however it ended: the keyboard is given back, once, and its notice (Ctrl+C's) goes with it. Nothing is
   * written: the modes are the session's, and the caret is the next frame's. False when it had already ended. */
  private release(): boolean {
    if (this.finished) return false;
    this.finished = true;
    this.stopInput();
    const { p } = this;
    if (p.restingPrompt === this) p.restingPrompt = undefined;
    p.clearTransientNotice();
    // A secret typed and not sent is not kept anywhere.
    if (this.settings?.secret) this.composer.clear();
    return true;
  }

  private finish(answer: string): void {
    if (!this.release()) return;
    const { p, settings } = this;
    lifecycle('window.prompt.end', { how: !answer ? 'empty' : answer.startsWith('/') ? `command ${answer.split(/\s/, 1)[0]}` : 'message' });
    if (answer) p.panelState = undefined;
    // A line sent is done with the mention it was looking at.
    if (answer) p.mentionFocus = undefined;
    // The submitted line is the conversation's now, not a draft still in progress.
    this.composer.clear();
    if (answer && settings?.conversation && !answer.startsWith('/') && p.history[p.history.length - 1] !== answer) p.history.push(answer);
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
  // window did not start is running (worker/turn-bridge.ts). The draft
  // stays in the composer, and the caller is told why it ended.
  private interrupt(): void {
    if (!this.release()) return;
    this.rejectQuestion(Object.assign(new Error('interrupted'), { code: 'ERR_PROMPT_INTERRUPTED' }));
  }

  private listen(): void {
    this.stopInput = takeTerminalKeys((key) => { if (!this.finished) this.handleKey(key); }, () => { this.stopInput(); if (!this.finished) this.listen(); });
  }

  start(): void {
    const { p, settings } = this;
    if (settings?.signal?.aborted) {
      this.rejectQuestion(Object.assign(new Error('interrupted'), { code: 'ERR_PROMPT_INTERRUPTED' }));
      return;
    }
    settings?.signal?.addEventListener('abort', () => this.interrupt(), { once: true });
    // Typed ahead under a sign-in: before anything the terminal sends
    // next (listen() hands that on, on a later tick than this one). What
    // follows an Enter that sent this prompt is the next prompt's draft.
    const ahead = p.typedAhead.splice(0);
    if (ahead.length) {
      process.nextTick(() => {
        for (const [index, key] of ahead.entries()) {
          if (!this.finished) { this.handleKey(key); continue; }
          const rest = ahead.slice(index).filter((item) => !item.startsWith('\u001b') && item.charCodeAt(0) >= 0x20 && item !== '\u007f').join('');
          if (rest) p.composer.set(`${p.composer.text}${rest}`);
          break;
        }
      });
    }
    p.restingPrompt = this;
    this.listen();
    this.draw();
  }

  private handleKey(key: string): void {
    // Up/Down: a swipe or a key press (swipe-arrows.ts). A held arrow reaches this prompt only while it is still open.
    if (this.p.swipeArrows.route(key, (arrow, source) => { if (!this.finished) this.dispatchKey(arrow, source); })) return;
    this.dispatchKey(key, 'key');
  }

  private dispatchKey(key: string, source: ArrowSource): void {
    const { p } = this;
    if (source === 'swipe') return this.swipe(key);
    if (key === '\u000c') { p.repairScreen(); return; }
    const matched = this.matches();
    // `options` drives selection keys. While an argument is being typed the
    // palette is only a hint -- unless it is listing the argument's own
    // values, which are chosen exactly like commands are.
    const completing = Boolean(matched[0]?.completes);
    const context: KeyContext = { matched, completing, options: this.composer.text.includes(' ') && !completing ? [] : matched };
    if (this.controlKey(key, context)) return;
    if (this.commitKey(key, context)) return;
    if (this.paletteKey(key, context)) return;
    const before = this.composer.text;
    if (draftKey(p, this.composer, key) !== 'edit') return;
    if (this.composer.text !== before) this.selected = this.highlightFor(this.composer.text);
    this.draw();
  }

  /** Ctrl+Z/C/D, and Esc: true when the key was handled here. */
  private controlKey(key: string, { matched }: KeyContext): boolean {
    const { p, settings } = this;
    const value = this.composer.text;
    if (key === '\u001a') { p.suspendToShell(); return true; }
    // Esc on an empty composer, no panel open, stops a turn parked for
    // the quota reset.
    if (key === '\u001b' && !value && !p.panelState && p.idleEscape) { const stop = p.idleEscape; p.idleEscape = undefined; stop(); return true; }
    if (!value && !matched.length && p.panelKey(key)) { this.draw(); return true; }
    if (key === '\u0003') {
      // Ctrl+C clears a draft first. Leaving takes a second press, because
      // the same key also interrupts a turn and is pressed by reflex.
      if (value) { this.composer.clear(); this.selected = 0; this.draw(); return true; }
      if (Date.now() - this.exitArmedAt <= EXIT_CONFIRM_MS) { this.finish('/exit'); return true; }
      this.exitArmedAt = Date.now();
      p.showTransientNotice('Press Ctrl+C again to exit', EXIT_CONFIRM_MS);
      this.draw();
      return true;
    }
    if (this.exitArmedAt) { this.exitArmedAt = 0; p.clearTransientNotice(); }
    // Ctrl+D is end-of-input only on an empty draft; otherwise it deletes
    // forward like every other line editor.
    if (key === '\u0004' && !value) { this.finish('/exit'); return true; }
    if (key === '\u001b' && settings?.cancellable) { this.cancel(); return true; }
    if (key === '\u001b' && matched.length) {
      this.composer.clear();
      this.selected = 0;
      this.draw();
      return true;
    }
    return false;
  }

  /** Enter and Tab: true when the key was handled here. */
  private commitKey(key: string, { completing, options }: KeyContext): boolean {
    const { commands, selected, composer } = this;
    const { text: value, cursor } = composer;
    if (key === '\r') {
      const continued = options.length ? undefined : backslashNewline(value, cursor);
      if (continued) { composer.set({ value: continued.value, cursor: continued.cursor, held: composer.held }); this.draw(); return true; }
      // A value from the command's own list: what was typed wins when it
      // IS a value, otherwise the highlighted one.
      if (completing) { this.runCommand(completedCommandLine(value, commands, selected)); return true; }
      // The highlighted command, bare. One that takes a value (model,
      // effort, permissions, account, resume) opens its own picker, titled
      // and starting on the current value; the values are listed here
      // only once one is being typed (`/model op`).
      if (options.length && value.startsWith('/') && !value.includes(' ')) { this.runCommand(options[selected]!.value); return true; }
      if (value.startsWith('/')) { this.runCommand(composer.expanded()); return true; }
      this.finish(composer.expanded());
      return true;
    }
    if (key === '\t' && options.length) {
      // A value fills in as it is, ready to run or to keep editing; a
      // command that takes an argument completes ready for it.
      composer.set(completing ? options[selected]!.value
        : `${options[selected]!.value}${options[selected]!.argHint || options[selected]!.argValues ? ' ' : ''}`);
      this.selected = 0;
      this.draw();
      return true;
    }
    return false;
  }

  /** A swipe's arrow: it reads the conversation (or an open panel) and nothing else. It never recalls history, moves the draft's
   * cursor, changes the palette's selection or touches the draft (swipe-arrows.ts). */
  private swipe(key: string): void {
    const { p } = this;
    if (!this.composer.text && !this.matches().length && p.panelKey(key)) { this.draw(); return; }
    p.scrollTranscript(key === '\u001b[A' ? SWIPE_ROWS : -SWIPE_ROWS);
  }

  /** The keys an open palette gives a meaning of its own: Up/Down move its selection, Left backs out of it, Right runs the
   * highlighted row. Left on an empty draft opens the conversations, Right on a `/`-less one may open the palette. True when the
   * key was handled here; Up/Down otherwise are the draft's (draftKey). */
  private paletteKey(key: string, { completing, options }: KeyContext): boolean {
    const { commands, settings, composer } = this;
    const { text: value, cursor } = composer;
    if ((key === '\u001b[A' || key === '\u001b[B') && options.length) {
      const direction = key === '\u001b[A' ? -1 : 1;
      this.selected = (this.selected + direction + options.length) % options.length;
      this.draw();
      return true;
    }
    if (key === '\u001b[D') {
      // With nothing typed there is nothing for the arrow to move through,
      // so the chat composer spends it on its conversations: what is
      // running now, and below it what can be resumed.
      if (!value && settings?.leftArrowCommand) { this.finish(settings.leftArrowCommand); return true; }
      // Backing out of the command list clears it; inside an argument the
      // arrow edits, as it does in any line.
      if (options.length && !completing) { composer.clear(); this.selected = 0; }
      else composer.cursor = previousCharacterIndex(value, cursor);
      this.draw();
      return true;
    }
    if (key === '\u001b[C') {
      // Right Arrow is deliberately identical to Enter.
      if (completing && cursor >= value.length) { this.runCommand(completedCommandLine(value, commands, this.selected)); return true; }
      // When the palette is open (any options match), right arrow selects/runs the highlighted option
      if (options.length && cursor >= value.length) { this.runCommand(options[this.selected]!.value); return true; }
      const paletteValue = composerRightArrowValue(value, options.length > 0, settings?.rightArrowPalette);
      if (paletteValue) {
        composer.set(paletteValue);
        this.selected = 0;
        this.draw();
        return true;
      }
      composer.cursor = nextCharacterIndex(value, cursor);
      this.draw();
      return true;
    }
    return false;
  }
}
