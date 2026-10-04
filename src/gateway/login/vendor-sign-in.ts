/**
 * Every vendor sign-in, run on ClikCode's own screen.
 *
 * The vendor's login runs down a pty in the background (script(1): several
 * check for a TTY before they print anything) and nobody sees its screen.
 * ClikCode reads it instead and puts each thing it needs from the user on
 * its own screen -- the CLI's, or the VS Code panel's -- in one look:
 *
 *   - a link, often with a code, approved in a browser (Grok, Codex, ...);
 *   - a choice, read off the vendor's own menu (OpenCode's login methods);
 *   - a typed answer: a key, or a code the browser page shows (Claude Code).
 *
 * The vendor's menus and prompts are read, not compiled in: the shapes the
 * common prompt libraries draw (clack's `◆ title / ● option`, enquirer's
 * `? title ›  ❯ option`, `(Y)es/(N)o`, a line ending in `:`) are recognised
 * on whatever the vendor prints. A screen no reader knows is answered by the
 * catalog's `steps` for that vendor.
 *
 * Exactly one browser tab: every way a vendor opens one (xdg-open, open, gio,
 * $BROWSER) is a stand-in that records the URL instead, and the screen opens
 * it. Where a browser is local, the URL the vendor tried to open is the one
 * it prefers (its localhost callback finishes without a pasted code); where
 * none is (SSH from a phone), the printed one is.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnPortable as spawn, terminatePortable } from '../../harness/transport/spawn.js';
import { runInPty, SIGN_IN_COLUMNS, SIGN_IN_ROWS } from './pty.js';
import { Screen, type ScreenState } from './screen.js';
import { extractLoginUrl, stripAnsi } from './url.js';

export interface LoginLink { url: string; code?: string }

/** What a sign-in needs from the screen showing it. */
export interface SignInUi {
  show(link: LoginLink): void;
  /** A typed answer. `secret`: a key, drawn as dots. */
  ask(prompt: string, secret: boolean): Promise<string>;
  /** One of `choices`, by index; undefined cancels the sign-in. */
  choose(title: string, choices: readonly string[]): Promise<number | undefined>;
  signal?: AbortSignal;
}

/** A sign-in's screen as a prompter provides it (HarnessPrompter.
 * signInScreen): `signal` is its Cancel, `stop` takes it down. */
export interface SignInScreen extends SignInUi {
  signal: AbortSignal;
  stop(): void;
}

/** A screen no reader knows, answered from the catalog: when the vendor's
 * text since the last answer shows `when` (compared without colours, spaces
 * or case), send `send` (keys: {enter} {down} {up} {tab} {esc} {space} {ctrl-c} {ctrl-d}), or
 * ask the user and send the answer with Enter. Whichever matches first: a
 * vendor's screens depend on what the user chose. One still on screen two
 * seconds later fires again (its key was dropped). */
export interface SignInStep { when: string; send?: string; ask?: { prompt: string; secret?: boolean } }

/** A device code: from the link's own `user_code`, else the first
 * `XXXX-XXXX`-shaped token printed (Grok, Amp, Kimi, Codex, Copilot all
 * print one). */
export function extractLoginCode(text: string, url?: string): string | undefined {
  if (url) {
    try {
      const fromUrl = new URL(url).searchParams.get('user_code');
      if (fromUrl) return fromUrl;
    } catch { /* fail-open-ok: not a parseable URL, read the text instead */ }
  }
  // Never from inside a link (Cursor's carries a UUID whose middle looks
  // like one), and never a piece of a longer dashed token.
  const prose = stripAnsi(text).replace(/https?:\/\/\S+/g, ' ');
  return prose.match(/(?<![\w-])[A-Z0-9]{4,5}-[A-Z0-9]{4,5}(?![\w-])/)?.[0];
}

/** Which link to show: the one the vendor tried to open where a browser is
 * local, the printed one where it is not. */
export function chooseLoginLink(input: { printed?: string; opened?: string; local: boolean }): string | undefined {
  return input.local ? input.opened ?? input.printed : input.printed ?? input.opened;
}

/** Something the vendor's screen is waiting on. */
export type ScreenPrompt =
  | { kind: 'choice'; title: string; choices: readonly string[]; selected: number; style: 'arrows' | 'yes-no' | 'number' | 'sideways'; searchable?: boolean }
  | { kind: 'input'; prompt: string; secret: boolean };

// `OPENROUTER_API_KEY` too: an underscore is no word boundary.
const SECRET_WORDS = /api[ _-]?key|\b(?:key|token|secret|password)\b/i;
/** A key or token, not a prompt that merely mentions one in a default
 * (`Label (optional, default: api-key-1)`). */
function isSecret(prompt: string): boolean {
  return SECRET_WORDS.test(prompt.replace(/\([^)]*\)/g, ''));
}
const KEYS: Readonly<Record<string, string>> = {
  '{enter}': '\r', '{down}': '\u001b[B', '{up}': '\u001b[A', '{tab}': '\t', '{esc}': '\u001b', '{space}': ' ',
  '{ctrl-c}': '\u0003', '{ctrl-d}': '\u0004',
};

/** A menu's title: the nearest line above it that says something --
 * not a border, a key hint, or a search box's lone `>`. */
function titleAbove(lines: readonly string[], start: number, fallback = ''): string {
  return [...lines.slice(0, start)].reverse().map((line) => line.replace(/[│┃║]/g, ' ').trim())
    .find((line) => /[A-Za-z]/.test(line) && !/^[┌└╭╰─━]/.test(line) && !/\b(?:navigate|ENTER|ESC|select)\b.*\b(?:select|cancel|confirm)\b/i.test(line))
    ?.replace(/^\?\s*/, '') ?? fallback;
}

/** Keys for `send` (see SignInStep). */
export function keystrokes(send: string): string {
  return send.replace(/\{[a-z-]+\}/g, (token) => KEYS[token] ?? token);
}

/** Text drawn on a screen large enough that nothing scrolls or wraps. */
function drawText(text: string): ScreenState {
  const screen = new Screen(Math.max(24, text.split('\n').length + 2), 400);
  screen.write(text);
  return screen.state();
}

/** Lines as a terminal would leave them: each carriage return starts the
 * line over, so a redrawn line keeps only its last drawing. */
function screenLines(text: string): string[] {
  return stripAnsi(text).split('\n').map((line) => (line.split('\r').filter((part) => part.trim()).pop() ?? '').trimEnd());
}

/** What the vendor's screen is waiting on, or undefined when it is not
 * waiting on anything known. Given text, it is drawn on a large screen
 * first (tests, and what is printed line by line). */
export function readScreenPrompt(shown: string | ScreenState): ScreenPrompt | undefined {
  const state = typeof shown === 'string' ? drawText(shown) : shown;
  const lines = state.lines;
  // The line the cursor waits on, when it waits right after a question:
  // what the screen asks now, whatever menu is drawn above it (Gemini
  // redraws its sign-in menu once more on the way to `Enter the
  // authorization code:`).
  const before = (lines[state.row] ?? '').slice(0, state.column);
  const after = (lines[state.row] ?? '').slice(state.column);
  const last = !after.trim() ? before.trim() : '';
  if (last) {
    // aider: `Login to OpenRouter or create a free account? (Y)es/(N)o [Yes]:`
    const yesNo = /^(.*?)\s*(?:\(Y\)es\/\(N\)o|\[(?:Y\/n|y\/N|y\/n|Y\/N)\])\s*(?:\[(Yes|No)\])?\s*:?$/i.exec(last);
    if (yesNo) {
      const defaultNo = /\[(?:y\/N)\]/.test(last) || yesNo[2]?.toLowerCase() === 'no';
      return { kind: 'choice', title: yesNo[1]!.trim(), choices: ['Yes', 'No'], selected: defaultNo ? 1 : 0, style: 'yes-no' };
    }
    // `Paste your API key:` `Label (optional, default: api-key-1):`
    // `Paste code here if prompted >`
    if (/[:>?]$/.test(last) && last.length <= 140 && !/https?:\/\//.test(last)) {
      const prompt = last.replace(/\s*[:>?]$/, '').trim();
      // `Choice [default 1]:` under a numbered list (Hermes): the list is the
      // question, answered by typing an option's number.
      const asksNumber = /\b(?:choice|choose|select|option|number)\b/i.test(prompt);
      const list = asksNumber ? numberedList(lines.slice(0, state.row), true) : undefined;
      if (list && list.prompt.kind === 'choice') {
        const fallback = /\[default (\d+)\]/i.exec(prompt)?.[1];
        return { ...list.prompt, title: list.prompt.title || prompt, selected: fallback ? Number(fallback) - 1 : list.prompt.selected, style: 'number' };
      }
      if (prompt) return { kind: 'input', prompt, secret: isSecret(prompt) };
    }
  }
  // Of the menus and fields drawn since the last answer, the one drawn last
  // is what the screen shows now: an Ink app redraws the menu just answered
  // on its way to the next screen.
  const drawn = [readClack(lines), readEnquirer(lines), readNumbered(lines), readRadio(lines), readPointer(lines), readCards(lines), readInputBox(lines), readTitledField(state)]
    .filter((found): found is Drawn => Boolean(found));
  const found = drawn.sort((left, right) => right.at - left.at)[0]?.prompt;
  // A list that shows a few of many and filters as you type (Cline's 228
  // providers, Pi's, OpenCode's): ClikCode offers a search as well.
  if (found?.kind === 'choice' && found.style === 'arrows' && lines.some((line) => /\btype to (?:search|filter)\b|\bsearch [a-z]+\.\.\.|\bsearch:|\d+ more\b/i.test(line))) {
    return { ...found, searchable: true };
  }
  return found;
}

/** A prompt a reader found, and the line it is drawn from. */
interface Drawn { prompt: ScreenPrompt; at: number }

/** A field whose name is in its border, the cursor inside it (Vibe's
 * `┌─ Paste API key ──`): what the screen waits on is typing there. */
function readTitledField(state: ScreenState): Drawn | undefined {
  const { lines, row } = state;
  for (let index = row - 1; index >= 0 && row - index <= 4; index -= 1) {
    const title = /^\s*[┌╭]─+\s*([^─┐╮]+?)\s*─/.exec(lines[index]!)?.[1];
    if (!title) continue;
    const closed = lines.slice(row + 1, row + 5).some((line) => /^\s*[└╰]─/.test(line));
    if (!closed || !/[A-Za-z]/.test(title)) return undefined;
    return { prompt: { kind: 'input', prompt: title, secret: isSecret(title) }, at: index };
  }
  return undefined;
}

/** A menu of cards: a box per option, its first line the label (after an
 * icon), the current one marked `→` at its right edge (Cline) or `>` left
 * of the box (Vibe). The title is the line above the first card. */
function readCards(lines: readonly string[]): Drawn | undefined {
  const cards: { at: number; label: string; current: boolean }[] = [];
  let open = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*[╭┌]─/.test(line)) { open = index; continue; }
    if (/^\s*[╰└]─/.test(line) && open >= 0) {
      const rows = lines.slice(open + 1, index);
      const first = rows.map((row) => row.replace(/^\s*>?\s*│\s?|\s*│\s*$/g, '').trim()).find(Boolean);
      const current = (first !== undefined && /→\s*$/.test(first)) || rows.some((row) => /^\s*>\s*│/.test(row));
      if (first) cards.push({ at: open, label: first.replace(/^[^\p{L}\p{N}(]+\s*/u, '').replace(/\s*→$/, '').trim(), current });
      open = -1;
    }
  }
  // Only the cards stacked last, one right under the next.
  const run: typeof cards = [];
  for (const card of cards.reverse()) {
    if (run.length && run[0]!.at - card.at > 8) break;
    run.unshift(card);
  }
  const selected = run.findIndex((card) => card.current);
  if (run.length < 2 || selected < 0) return undefined;
  // A menu says how to move through it; the same cards as a progress view
  // (Vibe's `Open browser / Complete sign-in / Finished setup`) do not.
  if (!lines.slice(run.at(-1)!.at).some((line) => /↑|↓|\bnavigate\b|\benter (?:to )?select\b/i.test(line))) return undefined;
  return { prompt: { kind: 'choice', title: titleAbove(lines, run[0]!.at), choices: run.map((card) => card.label), selected, style: 'arrows' }, at: run[0]!.at };
}

/** A radio list, as Hermes's full-screen menu draws one: `→ (●) X` the
 * current option, `(○) Y` the rest. Its title may have scrolled away; the
 * line above, unless it only lists keys, stands in. */
function readRadio(lines: readonly string[]): Drawn | undefined {
  const option = (line: string) => /^\s*(?:[→>›❯]\s*)?\((●|○)\)\s+(?!\d+\.\s)(.+?)\s*$/.exec(line);
  let end = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) if (option(lines[index]!)) { end = index; break; }
  if (end < 0) return undefined;
  let start = end;
  while (start > 0 && option(lines[start - 1]!)) start -= 1;
  const found = lines.slice(start, end + 1).map((line) => option(line)!);
  const selected = found.findIndex((match) => match[1] === '●');
  if (found.length < 2 || selected < 0) return undefined;
  const title = titleAbove(lines, start, 'Choose one');
  return { prompt: { kind: 'choice', title, choices: found.map((match) => match[2]!), selected, style: 'arrows' }, at: start };
}

/** A boxed text field, as Ink apps draw one (Gemini's key, Qwen's): the
 * last box on screen says `Enter to submit`, and its first line says what
 * goes in it. */
function readInputBox(lines: readonly string[]): Drawn | undefined {
  const hint = (line: string): boolean => /\benter to (?:submit|save|confirm|continue)\b|↵\s*submit\b/i.test(line);
  let at = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) if (hint(lines[index]!)) { at = index; break; }
  if (at < 0) return undefined;
  const content = (line: string): string => line.replace(/^\s*[│┃]\s?|\s*[│┃]\s*$/g, '').trim();
  // The box the hint is in, or the one just above it.
  let top = -1;
  for (let index = at; index >= 0 && at - index < 40; index -= 1) {
    if (/^\s*[┌╭]/.test(lines[index]!)) { top = index; break; }
  }
  let bottom = -1;
  if (top >= 0) for (let index = top + 1; index < lines.length; index += 1) if (/^\s*[└╰]/.test(lines[index]!)) { bottom = index; break; }
  if (top >= 0 && bottom >= 0 && (bottom >= at || at - bottom <= 3)) {
    const inside = lines.slice(top + 1, bottom).map(content).filter(Boolean).filter((line) => !hint(line));
    // `DeepSeek API Key · Step 2/2 · Model IDs`: the field is the last part,
    // and only the field says whether it is a secret.
    const parts = (inside[0] ?? '').split(/\s+·\s+/).filter((part) => !/^Step \d+\/\d+$/i.test(part));
    const label = [lines[top - 1], lines[top - 2]].map((line) => (line ?? '').trim()).find((line) => /[A-Za-z]/.test(line) && line.length <= 60);
    // A one-line box is the field itself, its text a placeholder; what it is
    // for is the label above it (Cline's `API key`).
    const field = inside.length <= 1 && label ? label : parts.at(-1) ?? label ?? '';
    if (!field) return undefined;
    const prompt = parts.length > 1 ? `${parts[0]}: ${field}` : field;
    return { prompt: { kind: 'input', prompt, secret: isSecret(field) || (inside.length <= 1 && isSecret(inside[0] ?? '')) }, at: top };
  }
  // Unboxed: the question, a `>` (Pi) or `❭` (Devin) line to type on --
  // perhaps holding a placeholder that says more -- then the hint.
  const typing = lines.slice(Math.max(0, at - 4), at).find((line) => /^\s*[>❭]/.test(line));
  if (typing === undefined) return undefined;
  const placeholder = typing.replace(/^\s*[>❭]\s*/, '').trim();
  for (let index = at - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line || /^[>❭]/.test(line)) continue;
    const label = line.replace(/\s*:$/, '');
    const prompt = placeholder.length > label.length && /[A-Za-z]{3}/.test(placeholder) ? placeholder : label;
    return { prompt: { kind: 'input', prompt, secret: isSecret(prompt) || isSecret(label) }, at: index };
  }
  return undefined;
}

/** A pointer menu: the current entry marked `› `, `> ` or `→ ` (Pi). Qwen's has a
 * description under each entry and blank lines between them (an entry is
 * its first line); Droid's is one line per entry (`> Login` / `Exit`).
 * The title is the line above them all. */
function readPointer(lines: readonly string[]): Drawn | undefined {
  const plain = lines.map((line) => line.replace(/[│┃║]/g, ' ').trimEnd());
  // Not a radio mark, and not a card's border (Vibe's `> │ Launch browser`).
  const marker = (line: string): boolean => /^\s*[›>→❯]\s+(?!\([●○]\)|[│┃])\S/.test(line);
  let at = -1;
  // Not a card's `> │ X` (Vibe): with its border blanked it would read as
  // a pointer. A pointer inside a box (Qwen's `│ › X`) is one.
  for (let index = plain.length - 1; index >= 0; index -= 1) if (marker(plain[index]!) && !/^\s*[›>→❯]\s*[│┃]/.test(lines[index]!)) { at = index; break; }
  if (at < 0) return undefined;
  // The marker stands in the indentation: `› Alibaba` lines up with
  // `  Third-party`.
  const indent = (line: string): number => { const shown = line.replace(/[›>→❯]/, ' '); return shown.length - shown.trimStart().length; };
  const column = indent(plain[at]!);
  const inMenu = (line: string): boolean => !/^\s*[─━]{3,}/.test(line) && (!line.trim() || indent(line) === column);
  let first = at;
  while (first > 0 && inMenu(plain[first - 1]!)) first -= 1;
  let last = at;
  while (last < plain.length - 1 && inMenu(plain[last + 1]!)) last += 1;
  // Groups of lines between blank lines.
  const groups: number[][] = [];
  for (let index = first; index <= last; index += 1) {
    if (!plain[index]!.trim()) { if (groups.at(-1)?.length) groups.push([]); continue; }
    if (!groups.length) groups.push([]);
    groups.at(-1)!.push(index);
  }
  const filled = groups.filter((group) => group.length);
  const entries = filled.length > 1 ? filled.map((group) => group[0]!) : (filled[0] ?? []);
  // One entry is a menu only behind an unmistakable marker (a search
  // narrowed to one): `> ` alone is also a chat's input line.
  if (!entries.includes(at) || entries.length < (/^\s*[❯→]/.test(plain[at]!) ? 1 : 2)) return undefined;
  const title = titleAbove(lines, entries[0]!);
  return {
    prompt: {
      kind: 'choice', title,
      choices: entries.map((index) => plain[index]!.trim().replace(/^[›>→❯]\s*/, '')),
      selected: entries.indexOf(at), style: 'arrows',
    },
    at: entries[0]!,
  };
}

/** clack (`@clack/prompts`, and cliclack in Rust): an active prompt is a
 * `◆ title` with no `◇` (answered) after it; a select lists `● ` (current)
 * and `○ ` options under it, a text prompt has none. */
function readClack(lines: readonly string[]): Drawn | undefined {
  let at = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (/[◇■▲]/.test(line)) return undefined;
    if (line.includes('◆')) { at = index; break; }
  }
  if (at < 0) return undefined;
  const title = lines[at]!.replace(/^.*◆\s*/, '').trim();
  const choices: string[] = [];
  let selected = 0;
  for (const line of lines.slice(at + 1)) {
    // A confirm draws both answers on one line: `● Yes / ○ No`.
    const inline = /^\s*[│|]?\s*([●○])\s+(.+?)\s+\/\s+([●○])\s+(.+?)\s*$/.exec(line);
    if (inline) {
      return { prompt: { kind: 'choice', title, choices: [inline[2]!, inline[4]!], selected: inline[3] === '●' ? 1 : 0, style: 'sideways' }, at };
    }
    const option = /^\s*[│|]?\s*([●○])\s+(.+?)\s*$/.exec(line);
    if (!option) continue;
    if (option[1] === '●') selected = choices.length;
    choices.push(option[2]!);
  }
  if (choices.length) return { prompt: { kind: 'choice', title, choices, selected, style: 'arrows' }, at };
  return title ? { prompt: { kind: 'input', prompt: title, secret: isSecret(title) }, at } : undefined;
}

/** enquirer/inquirer: `? title ›` (or `?` title then options), the current
 * option marked `❯`, the others indented. */
function readEnquirer(lines: readonly string[]): Drawn | undefined {
  let at = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*\?\s+\S/.test(lines[index]!)) { at = index; break; }
  }
  if (at < 0) return undefined;
  const options = lines.slice(at + 1).filter((line) => line.trim());
  // The menu is redrawn whole on each move; the last drawing is the one shown.
  const firstRepeat = options.findIndex((line, index) => index > 0 && line.trim().replace(/^❯\s*/, '') === options[0]!.trim().replace(/^❯\s*/, ''));
  const drawing = firstRepeat > 0 ? options.slice(options.length - firstRepeat) : options;
  if (!drawing.some((line) => /^\s*❯/.test(line))) return undefined;
  const choices = drawing.map((line) => line.trim().replace(/^❯\s*/, ''));
  const selected = Math.max(0, drawing.findIndex((line) => /^\s*❯/.test(line)));
  const title = lines[at]!.replace(/^\s*\?\s*/, '').replace(/\s*[›»].*$/, '').trim();
  // Anchored at the drawing shown, where a pointer reader would see the
  // same lines: the two tie, and this, the more specific, comes first.
  const shownAt = lines.lastIndexOf(drawing[0]!);
  return { prompt: { kind: 'choice', title, choices, selected, style: 'arrows' }, at: Math.max(at, shownAt) };
}

/** A numbered menu: `● 1. X` (Gemini, in a box), `❭ 1 X` with a
 * description under each (Devin), `(●) 1. X` (Hermes). The current option
 * is marked; its title is the line above the first. The last drawing is
 * the one shown. With `unmarked`, a list nothing marks counts too (one
 * answered by typing its number, see readScreenPrompt). */
function numberedList(lines: readonly string[], unmarked = false): (Drawn & { marked: boolean }) | undefined {
  const plain = lines.map((line) => line.replace(/[│┃║]/g, ' ').trimEnd());
  const option = (line: string) => /^\s*(?:([●›❯>❭])|\((●|○)\))?\s*(\d+)[.)]?\s+(\S.*?)\s*$/.exec(line);
  // From the last option up to option 1, descriptions allowed between.
  let index = plain.length - 1;
  while (index >= 0 && !option(plain[index]!)) index -= 1;
  if (index < 0) return undefined;
  const found: { at: number; match: RegExpExecArray }[] = [];
  let expected = Number(option(plain[index]!)![3]);
  if (expected < 2) return undefined;
  let gap = 0;
  for (; index >= 0 && expected >= 1; index -= 1) {
    const match = option(plain[index]!);
    if (match && Number(match[3]) === expected) { found.unshift({ at: index, match }); expected -= 1; gap = 0; continue; }
    if (++gap > 3) return undefined;
  }
  if (expected !== 0) return undefined;
  // A menu marks its current option; a numbered list of tips does not.
  const marked = found.findIndex(({ match }) => match[1] || match[2] === '●');
  if (marked < 0 && !unmarked) return undefined;
  const start = found[0]!.at;
  const title = titleAbove(lines, start);
  return {
    prompt: { kind: 'choice', title: title.replace(/^\?\s*/, ''), choices: found.map(({ match }) => match[4]!), selected: Math.max(0, marked), style: 'arrows' },
    at: start, marked: marked >= 0,
  };
}

function readNumbered(lines: readonly string[]): Drawn | undefined {
  return numberedList(lines);
}

/** Keys that move a menu from `from` to `to` and pick it. */
export function choiceKeys(prompt: Extract<ScreenPrompt, { kind: 'choice' }>, to: number): string {
  if (prompt.style === 'yes-no') return to === 0 ? 'y\r' : 'n\r';
  if (prompt.style === 'number') return `${to + 1}\r`;
  const moves = to - prompt.selected;
  if (prompt.style === 'sideways') return `${(moves >= 0 ? '\u001b[C' : '\u001b[D').repeat(Math.abs(moves))}\r`;
  return `${(moves >= 0 ? KEYS['{down}']! : KEYS['{up}']!).repeat(Math.abs(moves))}\r`;
}

/** What a terminal answers to the questions a TUI asks it on start --
 * device attributes, cursor position, modes, colours, version. Unanswered,
 * Textual apps (Vibe) wait and draw nothing; others guess and draw worse. */
export function terminalReplies(chunk: string, cursor: { row: number; column: number }): string {
  let reply = '';
  for (const match of chunk.matchAll(/\u001b\[(?:0?c|6n|\?(\d+)\$p|>0?q|5n)|\u001b\](1[01]);\?(?:\u0007|\u001b\\)/g)) {
    const query = match[0];
    if (/^\u001b\[0?c$/.test(query)) reply += '\u001b[?62;22c';
    else if (query === '\u001b[6n') reply += `\u001b[${cursor.row + 1};${cursor.column + 1}R`;
    else if (query === '\u001b[5n') reply += '\u001b[0n';
    else if (match[1]) reply += `\u001b[?${match[1]};2$y`;
    else if (/^\u001b\[>0?q$/.test(query)) reply += '\u001bP>|xterm(388)\u001b\\';
    else if (match[2]) reply += `\u001b]${match[2]};rgb:${match[2] === '10' ? 'ffff/ffff/ffff' : '0000/0000/0000'}\u001b\\`;
  }
  return reply;
}

function compact(text: string): string {
  return stripAnsi(text).replace(/\s+/g, '').toLowerCase();
}

const OPENERS = ['xdg-open', 'open', 'gio', 'sensible-browser', 'x-www-browser', 'www-browser'];

/** Executables that record the URL they were asked to open, one per line. */
async function openerStandIns(): Promise<{ dir: string; log: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'clikcode-open-'));
  const log = join(dir, 'opened');
  const script = '#!/bin/sh\nfor a; do case "$a" in http://*|https://*) printf \'%s\\n\' "$a" >> "$CLIKCODE_OPENED";; esac; done\n';
  await Promise.all(OPENERS.map(async (name) => {
    await writeFile(join(dir, name), script);
    await chmod(join(dir, name), 0o755);
  }));
  return { dir, log };
}

/** The extra choice a searchable list gets (readScreenPrompt). */
export const SEARCH_CHOICE = 'Search for another…';

/** How long the vendor's screen must be quiet before it is read: a prompt
 * is drawn in a burst, and reading mid-burst sees half a menu. */
const SETTLE_MS = 350;
/** The same prompt seen again this soon after it was answered is the
 * vendor redrawing it on the way to the next one, not asking again. */
const REDRAW_MS = 4_000;
/** How often the credential is looked for, and how long the vendor gets
 * to finish once it is there. */
const SIGNED_IN_POLL_MS = 1_000;
const SIGNED_IN_GRACE_MS = 1_500;
/** How soon a step whose text the screen still shows may fire again. */
const STEP_AGAIN_MS = 2_000;
/** The longest a screen that keeps drawing goes unread. */
const MAX_UNREAD_MS = 1_000;
/** Between keys sent to the vendor (see answer()). */
const KEY_GAP_MS = 100;

/** Run a vendor sign-in to the end on `ui`. Resolves when the vendor exits
 * 0; rejects when it fails, a choice is cancelled, or `ui.signal` aborts. */
export async function runVendorSignIn(input: {
  binary: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  displayName: string;
  local: boolean;
  steps?: readonly SignInStep[];
  ui: SignInUi;
  /** True once the vendor has written its credential: the sign-in is done,
   * and the vendor is closed after a moment to finish writing. */
  signedIn?: () => Promise<boolean>;
}): Promise<void> {
  const { ui } = input;
  const cancelled = (): Error => new Error(`sign-in to ${input.displayName} was cancelled`);
  if (ui.signal?.aborted) throw cancelled();
  // Cancel and a cancelled choice both end the vendor through this.
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  ui.signal?.addEventListener('abort', abort, { once: true });
  const standIns = process.platform === 'win32' ? undefined : await openerStandIns();
  const env: Record<string, string> = {
    ...input.env,
    ...(standIns ? {
      PATH: `${standIns.dir}${delimiter}${input.env.PATH ?? process.env.PATH ?? ''}`,
      BROWSER: join(standIns.dir, 'xdg-open'),
      CLIKCODE_OPENED: standIns.log,
    } : {}),
  };
  let raw = '';
  const screen = new Screen(SIGN_IN_ROWS, SIGN_IN_COLUMNS);
  // Read only once the screen has changed since the last answer: until the
  // vendor redraws, the prompt just answered is still on it.
  let changed = false;
  let opened: string | undefined;
  let shown: LoginLink | undefined;
  let write: (text: string) => void = () => undefined;
  let exited = false;
  // Catalog steps: each fires when its text shows since the last answer,
  // and again if the screen still shows it a while later -- a key sent
  // mid-animation (Vibe's welcome) is dropped, and the screen says so by
  // drawing the same thing again.
  const fired = new Map<number, number>();
  // Prompts are read from what was printed since the last answer.
  let answeredAt = 0;
  let answering = false;
  let lastPrompt: { key: string; at: number } | undefined;
  let settle: NodeJS.Timeout | undefined;

  const publishLink = (): void => {
    const url = chooseLoginLink({ printed: extractLoginUrl(raw), opened, local: input.local });
    if (!url) return;
    const code = extractLoginCode(raw, url);
    if (shown && shown.url === url && shown.code === code) return;
    shown = { url, ...(code ? { code } : {}) };
    try { ui.show(shown); } catch { /* fail-open-ok: showing must never break the sign-in */ }
  };

  const answer = async (work: () => Promise<string | undefined>): Promise<void> => {
    answering = true;
    try {
      const keys = await work();
      if (exited) return;
      if (keys === undefined) { abort(); return; }
      answeredAt = raw.length;
      changed = false;
      // One key at a time: an Ink app takes a burst like `sk-123\r` as
      // pasted text, Enter and all, and never submits it.
      for (const key of keys.match(/\u001b\[[A-D]|[\r\u0003\u0004]|[^\r\u0003\u0004\u001b]+|\u001b/g) ?? []) {
        if (exited) return;
        write(key);
        await new Promise((resolve) => setTimeout(resolve, KEY_GAP_MS));
      }
    } finally { answering = false; }
  };

  const read = (): void => {
    if (answering || exited) return;
    publishLink();
    const since = compact(raw.slice(answeredAt));
    const index = input.steps?.findIndex((rule, at) => Date.now() - (fired.get(at) ?? 0) >= STEP_AGAIN_MS && since.includes(compact(rule.when))) ?? -1;
    const next = index >= 0 ? input.steps![index]! : undefined;
    if (next) {
      fired.set(index, Date.now());
      void answer(async () => (next.ask
        ? `${await ui.ask(next.ask.prompt, Boolean(next.ask.secret))}\r`
        : keystrokes(next.send ?? ''))).finally(schedule);
      return;
    }
    if (!changed) return;
    const prompt = readScreenPrompt(screen.state());
    if (!prompt) return;
    const key = `${prompt.kind}:${prompt.kind === 'choice' ? prompt.title : prompt.prompt}`;
    if (lastPrompt && lastPrompt.key === key && Date.now() - lastPrompt.at < REDRAW_MS) return;
    lastPrompt = { key, at: Date.now() };
    void answer(async () => {
      if (prompt.kind === 'input') return `${await ui.ask(prompt.prompt, prompt.secret)}\r`;
      const choices = prompt.searchable ? [...prompt.choices, SEARCH_CHOICE] : prompt.choices;
      const index = await ui.choose(prompt.title, choices);
      if (index === undefined) return undefined;
      // Typed into the vendor's own search; the filtered list is read next.
      if (index === prompt.choices.length) return ui.ask(`Search ${prompt.title.replace(/:$/, '')}`, false);
      return choiceKeys(prompt, index);
    }).finally(() => { lastPrompt = { key, at: Date.now() }; schedule(); });
  };
  // A screen that never goes quiet (Vibe's animated welcome) is still read:
  // at least once a second while it keeps drawing.
  let deadline: NodeJS.Timeout | undefined;
  const readNow = (): void => {
    if (settle) clearTimeout(settle);
    if (deadline) clearTimeout(deadline);
    settle = undefined;
    deadline = undefined;
    read();
  };
  const schedule = (): void => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(readNow, SETTLE_MS);
    deadline ??= setTimeout(readNow, MAX_UNREAD_MS);
  };
  const onOutput = (chunk: string): void => {
    raw += chunk;
    screen.write(chunk);
    const replies = terminalReplies(chunk, screen.state());
    if (replies) write(replies);
    changed = true;
    publishLink();
    schedule();
  };

  let succeeded = false;
  const watch = input.signedIn ? setInterval(() => {
    if (succeeded) return;
    void input.signedIn!().then((done) => {
      if (!done || succeeded) return;
      succeeded = true;
      setTimeout(abort, SIGNED_IN_GRACE_MS);
    }, () => undefined);
  }, SIGNED_IN_POLL_MS) : undefined;
  const poll = standIns ? setInterval(() => {
    void readFile(standIns.log, 'utf8').then((text) => {
      const last = text.trim().split('\n').pop();
      if (last && last !== opened) { opened = last; publishLink(); }
    }, () => undefined);
  }, 200) : undefined;

  let exitCode: number | null;
  try {
    const teed = await runInPty({
      binary: input.binary, args: input.args, env, onOutput,
      onStdin: (send) => { write = send; },
      signal: controller.signal,
    });
    exitCode = teed.teed ? teed.exitCode : await runPiped(input.binary, input.args, env, onOutput, (send) => { write = send; }, controller.signal);
  } finally {
    exited = true;
    ui.signal?.removeEventListener('abort', abort);
    if (poll) clearInterval(poll);
    if (watch) clearInterval(watch);
    if (settle) clearTimeout(settle);
    if (deadline) clearTimeout(deadline);
    if (standIns) await rm(standIns.dir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (succeeded) return;
  if (controller.signal.aborted) throw cancelled();
  if (exitCode !== 0) {
    const said = screenLines(raw).map((line) => line.trim()).filter(Boolean).pop();
    throw new Error(`${input.displayName} sign-in exited with status ${exitCode}${said ? `: ${said}` : ''}`);
  }
}

/** Where there is no script(1) (Windows): plain pipes. A vendor that
 * insists on a TTY fails here, and says so. */
function runPiped(
  binary: string, args: readonly string[], env: Record<string, string>, onOutput: (chunk: string) => void,
  onStdin: (send: (text: string) => void) => void, signal: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const abort = (): void => { terminatePortable(child, 'SIGTERM'); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdin?.on('error', () => { /* fail-open-ok: vendor already exited */ });
    onStdin((text) => { child.stdin?.write(text); });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.on('error', (error) => { signal.removeEventListener('abort', abort); reject(error); });
    child.on('close', (code) => { signal.removeEventListener('abort', abort); resolve(code); });
  });
}
