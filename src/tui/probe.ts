/** What the terminal says it can do, asked once at startup instead of believed from its name.
 *
 * Three questions go out in one write, in this order: DECRQM for synchronized output (`CSI ? 2026 $ p`), XTVERSION
 * (`CSI > 0 q`) and Primary DA (`CSI c`). A terminal answers in the order it was asked and every terminal answers
 * Primary DA, so DA1 is the sentinel: when it comes, everything that is going to be answered has been.
 *
 * The probe never blocks the UI. Nothing waits for it; the answers are recorded whenever they arrive (the input
 * decoder hands them to `noteProbeReply`), and `timeoutMs` only bounds how long `probeTerminal` stays pending.
 *
 * FALLBACK, written down: a terminal that never answers is treated as it always was. Unknown means "do what has always
 * been done": frames are wrapped in DEC 2026 (a terminal that does not know the mode ignores it). The only thing that
 * changes is on a positive "no": a terminal that reports 2026 as unrecognised (0) or permanently off (4) is not sent
 * the wrapper.
 *
 * NOT probed, because it cannot be: whether `CSI 3 J` clears the saved lines. No query reports it and the saved
 * lines cannot be read back. Nothing depends on it succeeding: it is used only to drop blank rows a shrinking
 * screen pushed there, and a terminal that ignores it merely keeps them (the matrix's `xterm-no3j` and tmux runs). */

import { stdout as output } from 'node:process';
import { terminalModes } from './restore.js';
import { logCursorEvent } from './cursor-log.js';

export const terminalFacts: {
  syncOutput?: boolean; name?: string; answered: boolean;
  /** Rows at the top of the screen the terminal draws its own things over (ClikDeploy's phone page: the status bar, the Dynamic
   * Island, its tabs). The conversation is drawn under them, and its first line comes to rest below them. 0 until it says. */
  coveredTopRows: number;
} = { answered: false, coveredTopRows: 0 };

const PROBE_QUERY = '\u001b[?2026$p\u001b[>0q\u001b[c';

/** "How many rows at the top do you cover?" -- a private OSC (7701), asked only of ClikDeploy's phone page, which answers
 * `OSC 7701 ; <rows> ST` and from then on gives this program its whole height, the covered rows included. Asking is the
 * opt-in: a program that never asks is kept clear of those rows by the page, as before. The answer depends on the size of
 * the text, so it is asked again whenever the screen changes size. Any other terminal is not asked. */
const COVERED_TOP_QUERY = '\u001b]7701;?\u001b\\';
const COVERED_TOP_REPLY = /^\u001b\]7701;(\d{1,3})(?:\u0007|\u001b\\)$/;
/** The rows of a screen `rows` tall that nothing of the terminal's own is drawn over: where everything but the conversation is
 * laid out (the chat history, a list, a card, the composer's block). Only the conversation itself runs under the covered rows. */
export const uncoveredRows = (rows: number): number => Math.max(5, rows - terminalFacts.coveredTopRows);

export const asksCoveredTop = (env: NodeJS.ProcessEnv = process.env): boolean => env.CLIKDEPLOY_CLIENT === 'mobile';
export function askCoveredTop(): void {
  if (!output.isTTY || !terminalModes.rawMode || !asksCoveredTop()) return;
  output.write(COVERED_TOP_QUERY);
}

const MODE_REPORT = /^\u001b\[\?(\d+);(\d)\$y$/;
const PRIMARY_DA = /^\u001b\[\?[0-9;]*c$/;
const waiting = new Set<() => void>();
const coveredTopListeners = new Set<() => void>();
/** Called when the terminal says it covers a different number of rows: the view is drawn again for it. */
export function onCoveredTopChange(listener: () => void): () => void {
  coveredTopListeners.add(listener);
  return () => coveredTopListeners.delete(listener);
}

/** Synchronized output markers, empty on a terminal that said it does not know the mode. */
export const syncBegin = (): string => (terminalFacts.syncOutput === false ? '' : '\u001b[?2026h');
export const syncEnd = (): string => (terminalFacts.syncOutput === false ? '' : '\u001b[?2026l');

/** Any key the decoder reads that is an answer to the probe, or to a mode report nobody asked for: recorded and
 * consumed. True when it was one (it is never a keystroke). */
export function noteProbeReply(key: string): boolean {
  const covered = COVERED_TOP_REPLY.exec(key);
  if (covered) {
    const rows = Number(covered[1]);
    if (rows !== terminalFacts.coveredTopRows) {
      terminalFacts.coveredTopRows = rows;
      logCursorEvent(`terminal covers the top ${rows} row(s)`);
      for (const changed of [...coveredTopListeners]) changed();
    }
    return true;
  }
  const mode = MODE_REPORT.exec(key);
  if (mode) {
    if (mode[1] === '2026') terminalFacts.syncOutput = !(mode[2] === '0' || mode[2] === '4');
    terminalFacts.answered = true;
    return true;
  }
  if (key.startsWith('\u001bP>|')) {
    terminalFacts.name = key.slice(4, key.endsWith('\u001b\\') ? -2 : undefined).slice(0, 80);
    terminalFacts.answered = true;
    return true;
  }
  if (PRIMARY_DA.test(key)) {
    terminalFacts.answered = true;
    logCursorEvent(`terminal probe: name=${terminalFacts.name ?? '?'} sync2026=${terminalFacts.syncOutput ?? 'unknown'}`);
    for (const done of [...waiting]) done();
    return true;
  }
  return false;
}

/** Asks. Resolves when the sentinel arrives or `timeoutMs` passes, whichever is first; never rejects. Only asks a raw
 * terminal (with echo on, the answers would be printed as text). */
export function probeTerminal(timeoutMs = 300): Promise<void> {
  if (!output.isTTY || !terminalModes.rawMode) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => { clearTimeout(timer); waiting.delete(finish); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    waiting.add(finish);
    output.write(`${asksCoveredTop() ? COVERED_TOP_QUERY : ''}${PROBE_QUERY}`);
  });
}
