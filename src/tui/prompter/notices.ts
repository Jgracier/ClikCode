/** Transient notices and the scrollable panel above the composer. */
import { sanitizeTerminalText } from '../render/text.js';
import { NOTICE_MS } from '../../harness/protocol/timings.js';
import type { TerminalHarnessPrompter } from '../prompter.js';

export function notice(this: TerminalHarnessPrompter, text: string): void {
  this.showTransientNotice(text, NOTICE_MS, () => this.repaint());
  this.repaint();
}

export function showTransientNotice(this: TerminalHarnessPrompter, text: string, durationMs: number, redraw: () => void): void {
  this.clearTransientNotice();
  this.transientNotice = text;
  this.transientNoticeTimer = setTimeout(() => {
    this.transientNoticeTimer = undefined;
    this.transientNotice = undefined;
    if (!this.closed && !this.suspended) redraw();
  }, durationMs);
  this.transientNoticeTimer.unref();
}

export function clearTransientNotice(this: TerminalHarnessPrompter): void {
  if (this.transientNoticeTimer) clearTimeout(this.transientNoticeTimer);
  this.transientNoticeTimer = undefined;
  this.transientNotice = undefined;
}

/** A scrollable viewer in the live region. It used to keep only the last six
 * lines of the body, which cut /help and capability listings to their tail.
 * The whole body is kept; the prompt scrolls it (Up/Down/PgUp/PgDn while the
 * draft is empty) and q, Esc or Enter closes it. */
export function panel(this: TerminalHarnessPrompter, title: string, body: string): void {
  const lines = sanitizeTerminalText(body, { keepSgr: true }).split('\n').map((line) => line.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  this.panelState = { title: sanitizeTerminalText(title, { keepSgr: true, singleLine: true }), lines, offset: 0, page: 1, total: lines.length };
  this.repaint({ keepPalette: false });
}

/** True when the key was a panel command. Only consulted on an empty draft,
 * so none of these keys is ever taken away from text being typed. */
export function panelKey(this: TerminalHarnessPrompter, key: string): boolean {
  const panel = this.panelState;
  if (!panel) return false;
  const last = Math.max(0, panel.total - panel.page);
  const scrollTo = (offset: number): boolean => { panel.offset = Math.max(0, Math.min(last, offset)); return true; };
  if (key === '\u001b[A') return scrollTo(panel.offset - 1);
  if (key === '\u001b[B') return scrollTo(panel.offset + 1);
  if (key === '\u001b[5~') return scrollTo(panel.offset - Math.max(1, panel.page - 1));
  if (key === '\u001b[6~' || key === ' ') return scrollTo(panel.offset + Math.max(1, panel.page - 1));
  if (key === 'g') return scrollTo(0);
  if (key === 'G') return scrollTo(last);
  if (key === 'q' || key === 'Q' || key === '\u001b' || key === '\r') { this.panelState = undefined; return true; }
  return false;
}
