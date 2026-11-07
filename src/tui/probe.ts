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

export const terminalFacts: { syncOutput?: boolean; name?: string; answered: boolean } = { answered: false };

export const PROBE_QUERY = '\u001b[?2026$p\u001b[>0q\u001b[c';

const MODE_REPORT = /^\u001b\[\?(\d+);(\d)\$y$/;
const PRIMARY_DA = /^\u001b\[\?[0-9;]*c$/;
const waiting = new Set<() => void>();

/** Synchronized output markers, empty on a terminal that said it does not know the mode. */
export const syncBegin = (): string => (terminalFacts.syncOutput === false ? '' : '\u001b[?2026h');
export const syncEnd = (): string => (terminalFacts.syncOutput === false ? '' : '\u001b[?2026l');

/** Any key the decoder reads that is an answer to the probe, or to a mode report nobody asked for: recorded and
 * consumed. True when it was one (it is never a keystroke). */
export function noteProbeReply(key: string): boolean {
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
    output.write(PROBE_QUERY);
  });
}
