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
import { runInPty } from './pty.js';
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
 * or case), send `send` (keys: {enter} {down} {up} {tab} {esc} {space}), or
 * ask the user and send the answer with Enter. Each fires once, whichever
 * comes first: a vendor's screens depend on what the user chose. */
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
  | { kind: 'choice'; title: string; choices: readonly string[]; selected: number; style: 'arrows' | 'yes-no' }
  | { kind: 'input'; prompt: string; secret: boolean };

const SECRET_WORDS = /\b(?:api[ _-]?key|key|token|secret|password)\b/i;
/** A key or token, not a prompt that merely mentions one in a default
 * (`Label (optional, default: api-key-1)`). */
function isSecret(prompt: string): boolean {
  return SECRET_WORDS.test(prompt.replace(/\([^)]*\)/g, ''));
}
const KEYS: Readonly<Record<string, string>> = {
  '{enter}': '\r', '{down}': '\u001b[B', '{up}': '\u001b[A', '{tab}': '\t', '{esc}': '\u001b', '{space}': ' ',
};

/** Keys for `send` (see SignInStep). */
export function keystrokes(send: string): string {
  return send.replace(/\{[a-z]+\}/g, (token) => KEYS[token] ?? token);
}

/** Lines as a terminal would leave them: each carriage return starts the
 * line over, so a redrawn line keeps only its last drawing. */
function screenLines(text: string): string[] {
  return stripAnsi(text).split('\n').map((line) => (line.split('\r').filter((part) => part.trim()).pop() ?? '').trimEnd());
}

/** What the vendor's screen is waiting on, read from what it printed since
 * the last answer; undefined when it is not waiting on anything known. */
export function readScreenPrompt(tail: string): ScreenPrompt | undefined {
  const lines = screenLines(tail);
  // A question on the last line, the cursor still on it, is what the screen
  // waits on now -- whatever menu was drawn above it before (Gemini redraws
  // its sign-in menu once more on the way to `Enter the authorization
  // code:`). An active menu never ends on such a line.
  const last = [...lines].reverse().find((line) => line.trim())?.trim();
  if (last) {
    // aider: `Login to OpenRouter or create a free account? (Y)es/(N)o [Yes]:`
    const yesNo = /^(.*?)\s*(?:\(Y\)es\/\(N\)o|\[(?:Y\/n|y\/N|y\/n|Y\/N)\])\s*(?:\[(Yes|No)\])?\s*:?$/i.exec(last);
    if (yesNo) {
      const defaultNo = /\[(?:y\/N)\]/.test(last) || yesNo[2]?.toLowerCase() === 'no';
      return { kind: 'choice', title: yesNo[1]!.trim(), choices: ['Yes', 'No'], selected: defaultNo ? 1 : 0, style: 'yes-no' };
    }
    // `Paste your API key:` `Label (optional, default: api-key-1):`
    // `Paste code here if prompted >` -- a line ending in a prompt mark, with
    // the cursor still on it (nothing printed after).
    if (/[:>?]$/.test(last) && last.length <= 140 && !/https?:\/\//.test(last) && !/[\r\n]\s*$/.test(stripAnsi(tail))) {
      const prompt = last.replace(/\s*[:>?]$/, '').trim();
      if (prompt) return { kind: 'input', prompt, secret: isSecret(prompt) };
    }
  }
  // Of the menus and fields drawn since the last answer, the one drawn last
  // is what the screen shows now: an Ink app redraws the menu just answered
  // on its way to the next screen.
  const drawn = [readClack(lines), readEnquirer(lines), readNumbered(lines), readPointer(lines), readInputBox(lines)]
    .filter((found): found is Drawn => Boolean(found));
  return drawn.sort((left, right) => right.at - left.at)[0]?.prompt;
}

/** A prompt a reader found, and the line it is drawn from. */
interface Drawn { prompt: ScreenPrompt; at: number }

/** A boxed text field, as Ink apps draw one (Gemini's key, Qwen's): the
 * last box on screen says `Enter to submit`, and its first line says what
 * goes in it. */
function readInputBox(lines: readonly string[]): Drawn | undefined {
  let top = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) if (/^\s*[┌╭]/.test(lines[index]!)) { top = index; break; }
  if (top < 0) return undefined;
  let bottom = lines.length;
  for (let index = top + 1; index < lines.length; index += 1) if (/^\s*[└╰]/.test(lines[index]!)) { bottom = index; break; }
  const inside = lines.slice(top + 1, bottom).map((line) => line.replace(/^\s*[│┃]\s?|\s*[│┃]\s*$/g, '').trim()).filter(Boolean);
  if (!inside.some((line) => /\benter to submit\b/i.test(line))) return undefined;
  // `DeepSeek API Key · Step 2/2 · Model IDs`: the field is the last part,
  // and only the field says whether it is a secret.
  const parts = inside[0]!.split(/\s+·\s+/).filter((part) => !/^Step \d+\/\d+$/i.test(part));
  const field = parts.at(-1)!;
  const prompt = parts.length > 1 ? `${parts[0]}: ${field}` : field;
  return { prompt: { kind: 'input', prompt, secret: isSecret(field) }, at: top };
}

/** A pointer menu, as Qwen draws one: entries separated by blank lines, the
 * current one's first line marked `› `, each with a description under it.
 * The label is an entry's first line; the title the line above them all. */
function readPointer(lines: readonly string[]): Drawn | undefined {
  const plain = lines.map((line) => line.replace(/[│┃║]/g, ' ').trimEnd());
  const marker = (line: string): boolean => /^\s*›\s+\S/.test(line);
  let at = -1;
  for (let index = plain.length - 1; index >= 0; index -= 1) if (marker(plain[index]!)) { at = index; break; }
  if (at < 0) return undefined;
  // The marker stands in the indentation: `› Alibaba` lines up with
  // `  Third-party`.
  const indent = (line: string): number => { const shown = line.replace('›', ' '); return shown.length - shown.trimStart().length; };
  const column = indent(plain[at]!);
  // The menu runs from the first entry above the marker to the last below
  // it: lines at the marker's column, blank lines between them.
  const isEntryStart = (index: number): boolean => {
    const line = plain[index]!;
    if (!line.trim() || indent(line) !== column) return false;
    return index === 0 || !plain[index - 1]!.trim() || marker(line);
  };
  let first = at;
  for (let index = at - 1; index >= 0; index -= 1) {
    const line = plain[index]!;
    if (!line.trim()) continue;
    if (indent(line) < column || /^\s*[─━]{3,}/.test(line)) break;
    if (isEntryStart(index)) first = index;
  }
  const entries: number[] = [];
  for (let index = first; index < plain.length; index += 1) {
    const line = plain[index]!;
    if (/^\s*[─━]{3,}/.test(line) || (line.trim() && indent(line) < column)) break;
    if (isEntryStart(index)) entries.push(index);
  }
  if (entries.length < 2 || !entries.includes(at)) return undefined;
  const title = [...plain.slice(0, first)].reverse().map((line) => line.trim()).find((line) => line && !/^[┌└╭╰─━]+/.test(line)) ?? '';
  return {
    prompt: {
      kind: 'choice', title,
      choices: entries.map((index) => plain[index]!.trim().replace(/^›\s*/, '')),
      selected: entries.indexOf(at), style: 'arrows',
    },
    at: first,
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
  return { prompt: { kind: 'choice', title, choices, selected, style: 'arrows' }, at };
}

/** A numbered menu, as Ink apps draw one (Gemini's, Qwen's): `● 1. X`
 * current, `  2. Y` the rest, often inside a box; its title is the line
 * above. The last drawing is the one shown. */
function readNumbered(lines: readonly string[]): Drawn | undefined {
  const plain = lines.map((line) => line.replace(/[│┃║]/g, ' ').trimEnd());
  const option = (line: string) => /^\s*([●›❯>])?\s*(\d+)\.\s+(.+?)\s*$/.exec(line);
  let end = -1;
  for (let index = plain.length - 1; index >= 0; index -= 1) {
    if (option(plain[index]!)?.[2] && option(plain[index]!)![2] !== '1') { end = index; break; }
  }
  if (end < 0) return undefined;
  let start = end;
  while (start > 0 && option(plain[start - 1]!)) start -= 1;
  const block = plain.slice(start, end + 1).map((line) => option(line)!);
  if (block[0]![2] !== '1' || block.some((match, index) => Number(match[2]) !== index + 1)) return undefined;
  // A menu marks its current option; a numbered list of tips does not.
  const marked = block.findIndex((match) => match[1]);
  if (marked < 0) return undefined;
  const title = [...plain.slice(0, start)].reverse().map((line) => line.trim()).find((line) => line && !/^[╭╰─━┌└]+/.test(line)) ?? '';
  return { prompt: { kind: 'choice', title: title.replace(/^\?\s*/, ''), choices: block.map((match) => match[3]!), selected: marked, style: 'arrows' }, at: start };
}

/** Keys that move a menu from `from` to `to` and pick it. */
export function choiceKeys(prompt: Extract<ScreenPrompt, { kind: 'choice' }>, to: number): string {
  if (prompt.style === 'yes-no') return to === 0 ? 'y\r' : 'n\r';
  const moves = to - prompt.selected;
  return `${(moves >= 0 ? KEYS['{down}']! : KEYS['{up}']!).repeat(Math.abs(moves))}\r`;
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

/** How long the vendor's screen must be quiet before it is read: a prompt
 * is drawn in a burst, and reading mid-burst sees half a menu. */
const SETTLE_MS = 350;
/** The same prompt seen again this soon after it was answered is the
 * vendor redrawing it on the way to the next one, not asking again. */
const REDRAW_MS = 4_000;
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
  let opened: string | undefined;
  let shown: LoginLink | undefined;
  let write: (text: string) => void = () => undefined;
  let exited = false;
  // Catalog steps, each fired once.
  const fired = new Set<number>();
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
      // One key at a time: an Ink app takes a burst like `sk-123\r` as
      // pasted text, Enter and all, and never submits it.
      for (const key of keys.match(/\u001b\[[A-D]|\r|[^\r\u001b]+|\u001b/g) ?? []) {
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
    const index = input.steps?.findIndex((rule, at) => !fired.has(at) && since.includes(compact(rule.when))) ?? -1;
    const next = index >= 0 ? input.steps![index]! : undefined;
    if (next) {
      fired.add(index);
      void answer(async () => (next.ask
        ? `${await ui.ask(next.ask.prompt, Boolean(next.ask.secret))}\r`
        : keystrokes(next.send ?? ''))).finally(schedule);
      return;
    }
    const prompt = readScreenPrompt(raw.slice(answeredAt));
    if (!prompt) return;
    const key = `${prompt.kind}:${prompt.kind === 'choice' ? prompt.title : prompt.prompt}`;
    if (lastPrompt && lastPrompt.key === key && Date.now() - lastPrompt.at < REDRAW_MS) return;
    lastPrompt = { key, at: Date.now() };
    void answer(async () => {
      if (prompt.kind === 'input') return `${await ui.ask(prompt.prompt, prompt.secret)}\r`;
      const index = await ui.choose(prompt.title, prompt.choices);
      return index === undefined ? undefined : choiceKeys(prompt, index);
    }).finally(() => { lastPrompt = { key, at: Date.now() }; schedule(); });
  };
  const schedule = (): void => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(read, SETTLE_MS);
  };
  const onOutput = (chunk: string): void => { raw += chunk; publishLink(); schedule(); };

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
    if (settle) clearTimeout(settle);
    if (standIns) await rm(standIns.dir, { recursive: true, force: true }).catch(() => undefined);
  }
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
