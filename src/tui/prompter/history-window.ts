/** The full-screen view's scroll-back, windowed by message.
 *
 * The persisted messages are the conversation; rows are only ever a rendering of them. The transcript the view scrolls over
 * (`alternateTranscript`) holds the rows of a WINDOW of messages -- [first, end) -- and everything outside it is virtual:
 *  - above the window (messages < first) are rendered on demand, a batch at a time, when the viewport comes within `reach`
 *    rows of its top, and put in FRONT of the rows kept (line numbers run on into the negatives, so no line already handed out
 *    changes and the viewport does not move);
 *  - far from the live end the window is DETACHED: the rows between the viewport and the end are let go (`end` < the list's
 *    length, `rowsBelow` standing in for them) and brought back a batch at a time when the viewport returns;
 *  - a jump (Home, a /search mention, a width change or a group toggle while far back) builds the window around its target
 *    directly, from the list, without rendering what lies between.
 * Rows far from the viewport are let go again, so what is held is proportional to the screen, not to the conversation.
 *
 * Row counts of messages that were never rendered are ESTIMATED (render/reseed-window.ts) and replaced by the measured count
 * once a message has been rendered. The viewport is positioned by rows from the end, as before; an estimate only affects how
 * far the end of the scroll is thought to be, never what is on screen, because every change to the window keeps the viewport's
 * first row where it was. */
import { performance } from 'node:perf_hooks';
import { stdout as output } from 'node:process';
import chalk from 'chalk';
import { isClikCodeNotice } from '../../session/clikcode-notice.js';
import { stripRepeatedTitles } from '../../session/title.js';
import { TurnTranscript } from '../../turn/transcript.js';
import type { TranscriptMessage } from '../../session/model.js';
import { accountSwitchLine } from '../../turn/failover.js';
import { withoutOtherOrgThinkingNotice } from '../../harness/protocol/claude-thinking-notice.js';
import { sanitizeTerminalText } from '../render/text.js';
import { turnEndLine } from '../render/turn-end-line.js';
import { estimatedRows } from '../render/reseed-window.js';
import { extractTags } from '../render/row-tags.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { createRowBuilders, createToolRows, createTurnTools } from './paint/rows.js';
import { makeRenderBlocks } from './paint/transcript.js';
import { safeRow } from './frame-flush.js';
import { RowSums } from './row-sums.js';

/** The longest one frame spends rendering older messages. A batch is a few messages, so it overshoots by about one of them. */
const WINDOW_FRAME_BUDGET_MS = 6;

/** Messages in one batch, at most (a batch also stops once it has about a screen of rows). */
const BATCH_MESSAGES = 40;

/** Rows kept materialised above and below the viewport: three screens. */
export function reach(p: { viewportRows(): number }): number {
  return Math.max(3 * p.viewportRows(), 90);
}

type Anchor = { message: number; into: number };

export class HistoryWindow {
  /** The first message whose rows are in the transcript. */
  first = 0;
  /** Detached from the live end: the exclusive end of the messages held (the list's length when the window reaches it). */
  end: number | undefined;
  /** Rows standing in for the messages from `end` on, while detached (estimated; measured ones counted as they are). */
  rowsBelow = 0;
  /** Rows retired while detached were let go; the live end is rewritten from the list when the viewport returns to it. */
  gap = false;
  /** The line where the rows of the answer still streaming begin (everything before it is a persisted message). */
  liveFrom = 0;
  /** A place to put the view back at after the conversation is written again (a new width, a toggled group). */
  anchor: Anchor | undefined;
  /** What the last frame drew from: the persisted messages, the width and whose conversation. Absent until one has been drawn. */
  source: { messages: readonly TranscriptMessage[]; inner: number; conversation?: string } | undefined;
  /** More batches are wanted than this frame's budget allowed; another frame is owed. */
  more = false;
  /** Messages rendered on demand, ever, and the most held at once (for tests and measurement). */
  rendered = 0;
  peak = 0;
  /** Measured rows of the messages rendered so far, by message, and the sums of every message's rows (measured where known,
   * else estimated) -- both for one conversation at one width, kept across rewrites of it so the scroll range stops drifting. */
  private readonly counts = new Map<number, number>();
  private readonly sums = new RowSums();
  private summed: { conversation?: string; inner: number } | undefined;

  get detached(): boolean { return this.end !== undefined; }

  /** Messages whose rows are held now. */
  get materialised(): number {
    const total = this.source?.messages.length ?? 0;
    return Math.max(0, Math.min(this.end ?? total, total) - this.first);
  }

  reset(): void {
    this.first = 0;
    this.end = undefined;
    this.rowsBelow = 0;
    this.gap = false;
    this.more = false;
  }

  /** The measured rows of message `index`, if it has been rendered. */
  measured(index: number): number | undefined {
    this.sync();
    return this.counts.get(index);
  }

  /** A real count of message `index`'s rows, replacing its estimate. */
  measure(index: number, rows: number): void {
    this.sync();
    this.counts.set(index, rows);
    if (index < this.sums.size) this.sums.set(index, rows);
  }

  /** Rows of messages [from, to): measured where known, else estimated. */
  rowsBetween(from: number, to: number): number {
    if (to <= from) return 0;
    this.fill();
    return this.sums.before(to) - this.sums.before(from);
  }

  /** The message whose rows hold row `row` of the conversation, and how far into it. */
  messageAt(row: number): Anchor | undefined {
    this.fill();
    const found = this.sums.at(row);
    return found && { message: found.index, into: found.into };
  }

  /** Another conversation or another width: what was counted no longer holds. */
  private sync(): void {
    const source = this.source;
    if (!source) return;
    const summed = this.summed;
    if (summed && summed.inner === source.inner && summed.conversation === source.conversation) {
      // A shorter list (rewound, compacted, a pending prompt gone): the messages past its end are not those that were counted.
      if (this.sums.size > source.messages.length) {
        this.sums.truncate(source.messages.length);
        for (const index of [...this.counts.keys()]) if (index >= source.messages.length) this.counts.delete(index);
      }
      return;
    }
    this.counts.clear();
    this.sums.clear();
    this.summed = { conversation: source.conversation, inner: source.inner };
  }

  private fill(): void {
    this.sync();
    const source = this.source;
    if (!source) return;
    for (let index = this.sums.size; index < source.messages.length; index += 1) {
      this.sums.push(this.counts.get(index) ?? estimatedRows(source.messages[index]!.content, source.inner));
    }
  }
}

/** Rows of message `index`: from its own and the next message's lines while it is held, else measured when it was, else estimated. */
function rowsOf(p: TerminalHarnessPrompter, index: number): number {
  const h = p.scrollWindow;
  const start = p.messageLines.get(index);
  const next = p.messageLines.get(index + 1);
  if (start !== undefined && next !== undefined) return Math.max(0, next - start);
  return h.measured(index) ?? h.rowsBetween(index, index + 1);
}

const totalOf = (p: TerminalHarnessPrompter): number => p.scrollWindow.source?.messages.length ?? 0;

/** The rows of messages [from, to), as the transcript writes them: what a message that is no longer being written is made of
 * (paint/transcript.ts writeMessages), without touching what has been written. `seed`: the last two rows above the chunk, so
 * the blank rows between messages are counted as they would be in one piece. A chunk that ends before a user message ends with
 * the blank that message would have opened with. Rows are safe to draw, their group tags taken off. */
export function renderChunk(
  p: TerminalHarnessPrompter, from: number, to: number, seed: { last?: string; before?: string } = {},
): { rows: string[]; tags: Array<string | undefined>; starts: number[]; counts: number[] } {
  const h = p.scrollWindow;
  const { messages, inner } = h.source!;
  const builders = createRowBuilders(p, inner);
  const { savedTools } = createTurnTools(p, builders, createToolRows(p, builders), undefined, { materializedPendingTurn: false });
  const renderBlocks = makeRenderBlocks(inner);
  const rows: string[] = [];
  const emit = (list: readonly string[]): void => {
    for (const row of list) {
      const last = rows.length ? rows[rows.length - 1] : seed.last;
      const before = rows.length > 1 ? rows[rows.length - 2] : rows.length ? seed.last : seed.before;
      if (row === '' && (last === undefined || (last === '' && (before === '' || before === undefined)))) continue;
      rows.push(row);
    }
  };
  const starts: number[] = [];
  p.callGroups.older = true;
  try {
    for (let index = from; index < to; index += 1) {
      starts.push(rows.length);
      const message = messages[index]!;
      if (message.role === 'user' && isClikCodeNotice(message.content)) { emit(builders.standaloneActivity(index + 1, false)); continue; }
      const tools = message.role === 'assistant' ? savedTools(message, index) : [];
      if (tools.length) {
        emit(new TurnTranscript().advance({
          content: sanitizeTerminalText(stripRepeatedTitles(message.content)), tools, turnEnded: true, renderBlocks,
        }).finished);
      } else {
        if (message.role === 'user' && index > 0) emit(['']);
        emit(message.role === 'assistant'
          ? builders.messageRows(withoutOtherOrgThinkingNotice(stripRepeatedTitles(message.content)), '·')
          : message.automatic ? builders.noticeRows(message.automatic) : builders.userRows(message.content));
      }
      if (message.role === 'assistant' && message.accountSwitch) emit(['', `  ${chalk.yellow(accountSwitchLine(message.accountSwitch))}`]);
      const ended = message.role === 'assistant' ? turnEndLine(messages, index) : undefined;
      if (ended) emit(['', `  ${chalk.dim(`─ ${ended} ─`)}`]);
      emit(['']);
      emit(builders.standaloneActivity(index + 1, false));
    }
    const next = messages[to];
    if (next && next.role === 'user' && to > 0 && !isClikCodeNotice(next.content)) emit(['']);
  } finally { p.callGroups.older = false; }
  h.rendered += to - from;
  const { rows: clean, tags } = extractTags(rows);
  const limit = Math.max(1, (output.columns || 100) - 1);
  const counts = starts.map((start, i) => (starts[i + 1] ?? clean.length) - start);
  return { rows: clean.map((row) => safeRow(row, limit)), tags, starts, counts };
}

function spliceFront(rows: string[], front: readonly string[]): void {
  for (let at = 0; at < front.length; at += 20000) rows.splice(at, 0, ...front.slice(at, at + 20000));
}

function pushAll(rows: string[], more: readonly string[]): void {
  for (let at = 0; at < more.length; at += 20000) rows.push(...more.slice(at, at + 20000));
}

/** The first row of the view, as an index into the transcript. */
function topIndex(p: TerminalHarnessPrompter, above: number): number {
  const h = p.scrollWindow;
  const extra = h.detached || p.alternateScrollback === 0 ? 0 : p.scrollTail.rows.length;
  return p.alternateTranscript.length + extra + h.rowsBelow - above - p.alternateScrollback;
}

/** Keep the view's first row at `top` after the rows around it changed. */
function holdTop(p: TerminalHarnessPrompter, above: number, top: number): void {
  const h = p.scrollWindow;
  const extra = h.detached ? 0 : p.scrollTail.rows.length;
  p.alternateScrollback = Math.max(0, p.alternateTranscript.length + extra + h.rowsBelow - above - top);
}

/** Render the batch of messages just above the window and put it in front of its rows. Returns how many messages it added (0: none
 * are left above). */
function prependBatch(p: TerminalHarnessPrompter, want: number): number {
  const h = p.scrollWindow;
  let lo = h.first;
  let rows = 0;
  while (lo > 0 && rows < want && h.first - lo < BATCH_MESSAGES) { lo -= 1; rows += rowsOf(p, lo); }
  if (lo === h.first) return 0;
  const chunk = renderChunk(p, lo, h.first);
  const base = p.alternateTrimmed - chunk.rows.length;
  spliceFront(p.alternateTranscript, chunk.rows);
  for (const [i, start] of chunk.starts.entries()) { p.messageLines.set(lo + i, base + start); h.measure(lo + i, chunk.counts[i]!); }
  for (const [i, tag] of chunk.tags.entries()) if (tag) p.lineTags.set(base + i, tag);
  p.alternateTrimmed = base;
  const added = h.first - lo;
  h.first = lo;
  return added;
}

/** Render the batch of messages just below a detached window and add its rows to the end. */
function appendBatch(p: TerminalHarnessPrompter, want: number): void {
  const h = p.scrollWindow;
  const total = totalOf(p);
  const from = h.end!;
  let hi = from;
  let rows = 0;
  while (hi < total && rows < want && hi - from < BATCH_MESSAGES) { rows += rowsOf(p, hi); hi += 1; }
  if (hi === from) return;
  const W = p.alternateTranscript;
  const chunk = renderChunk(p, from, hi, { last: W[W.length - 1], before: W[W.length - 2] });
  const base = p.alternateTrimmed + W.length;
  pushAll(W, chunk.rows);
  for (const [i, start] of chunk.starts.entries()) { p.messageLines.set(from + i, base + start); h.measure(from + i, chunk.counts[i]!); }
  for (const [i, tag] of chunk.tags.entries()) if (tag) p.lineTags.set(base + i, tag);
  h.end = hi;
  h.rowsBelow = h.rowsBetween(hi, total);
}

/** Give back the live end: the conversation is written from its list again, and the view put back where it is (or at the end). */
function toLive(p: TerminalHarnessPrompter, anchor: Anchor | undefined): void {
  const h = p.scrollWindow;
  h.anchor = anchor;
  h.more = false;
  p.emitted.requestReseed();
  if (!anchor) p.alternateScrollback = 0;
  p.schedulePaint(0);
}

/** Where in the conversation the view's first row is: the message, and how many rows into it. */
function placeOfTop(p: TerminalHarnessPrompter, above: number): Anchor | undefined {
  const h = p.scrollWindow;
  if (!h.source) return undefined;
  const top = p.alternateTrimmed + topIndex(p, above);
  let best: number | undefined;
  for (const [index, start] of p.messageLines) if (start <= top && (best === undefined || index > best)) best = index;
  if (best === undefined) return undefined;
  const start = p.messageLines.get(best)!;
  return { message: best, into: Math.max(0, top - start) };
}

/** Build the window around message `message`, `into` rows down, from the list -- nothing between it and the live end is rendered. */
export function jumpTo(p: TerminalHarnessPrompter, message: number, into: number, above: number, stayDetached = false): void {
  const h = p.scrollWindow;
  const total = totalOf(p);
  const W = p.alternateTranscript;
  p.alternateTrimmed += W.length;
  W.length = 0;
  p.messageLines.clear();
  p.lineTags.clear();
  p.selection = undefined;
  p.stopSelectionScroll();
  // The body the last frame measured is another text now: what holds the view still while rows arrive must not compare with it.
  p.scrollBodyLength = undefined;
  h.first = Math.max(0, Math.min(message, total - 1));
  h.end = h.first;
  h.gap = true;
  h.rowsBelow = h.rowsBetween(h.first, total);
  const need = into + above + reach(p);
  while (h.end < total && W.length < need) {
    appendBatch(p, Math.max(need - W.length, above));
    // The part the view needs is not optional; the rest of the margin is.
    if (W.length >= into + above) break;
  }
  const top = Math.min(into, Math.max(0, W.length - 1));
  holdTop(p, above, top);
  if (h.end >= total && !stayDetached) toLive(p, { message: h.first, into: top });
}

/** Everything done to the window before a frame is drawn: the view's rows are made to exist, rows far from it are let go. */
export function settleWindow(p: TerminalHarnessPrompter, above: number): void {
  const h = p.scrollWindow;
  h.more = false;
  if (!h.source) return;
  const W = p.alternateTranscript;
  const total = totalOf(p);
  const near = reach(p);
  const deadline = performance.now() + WINDOW_FRAME_BUDGET_MS;
  const timeLeft = (): boolean => performance.now() < deadline;
  if (h.anchor) {
    const anchor = h.anchor;
    h.anchor = undefined;
    const start = p.messageLines.get(anchor.message);
    if (start !== undefined && anchor.message >= h.first) {
      const into = Math.min(anchor.into, Math.max(0, rowsOf(p, anchor.message) - 1));
      holdTop(p, above, start - p.alternateTrimmed + into);
    } else if (anchor.message < total) jumpTo(p, anchor.message, anchor.into, above, true);
  }
  if (h.detached) {
    // Messages arrived while the view was back: they are below it, and the view stays where it is.
    const top = topIndex(p, above);
    h.rowsBelow = h.rowsBetween(h.end!, total);
    holdTop(p, above, top);
    // Following the end again (a new turn, Esc): the live end is written from the list, and the view goes with it.
    if (p.alternateScrollback === 0) { h.reset(); toLive(p, undefined); return; }
  }
  // Rows above the view: rendered ahead, a batch at a time.
  while (h.first > 0 && topIndex(p, above) < near) {
    if (!prependBatch(p, Math.max(above, 30))) break;
    if (!timeLeft()) { if (h.first > 0 && topIndex(p, above) < near) h.more = true; break; }
  }
  // Rows below a view that is far from the end (detached): the same.
  if (h.detached) {
    while (h.end! < total && p.alternateScrollback - h.rowsBelow < near) {
      const top = topIndex(p, above);
      appendBatch(p, Math.max(above, 30));
      holdTop(p, above, top);
      if (h.end! >= total) { toLive(p, placeOfTop(p, above)); return; }
      if (!timeLeft()) { h.more = true; break; }
    }
  } else if (p.alternateScrollback > 4 * near && W.length > 0) {
    // Attached and far from the end: the end is let go.
    dropBelow(p, above, near);
  }
  if (h.detached) cutBelowDetached(p, above, near);
  trimFront(p, above, near);
  h.peak = Math.max(h.peak, h.materialised);
}

/** The first message that starts at or after row index `row` of the transcript, among the messages held. */
function firstStartingAt(p: TerminalHarnessPrompter, row: number): number | undefined {
  let found: number | undefined;
  for (const [index, start] of p.messageLines) if (start - p.alternateTrimmed >= row && (found === undefined || index < found)) found = index;
  return found;
}

/** Let go of the rows beyond `keep` rows below the view's bottom, and stand in for them. */
function dropBelow(p: TerminalHarnessPrompter, above: number, keep: number): boolean {
  const h = p.scrollWindow;
  const W = p.alternateTranscript;
  const top = topIndex(p, above);
  const extra = h.detached || p.alternateScrollback === 0 ? 0 : p.scrollTail.rows.length;
  const bottom = W.length + extra + h.rowsBelow - p.alternateScrollback;
  const cut = firstStartingAt(p, bottom + keep);
  const total = totalOf(p);
  if (cut === undefined || cut >= total) return false;
  const cutRow = p.messageLines.get(cut)! - p.alternateTrimmed;
  if (cutRow >= W.length || cutRow <= 0) return false;
  for (let index = cut; index < (h.end ?? total); index += 1) {
    if (p.messageLines.has(index)) h.measure(index, rowsOf(p, index));
  }
  W.length = cutRow;
  for (const index of [...p.messageLines.keys()]) if (index >= cut) p.messageLines.delete(index);
  for (const line of [...p.lineTags.keys()]) if (line >= p.alternateTrimmed + cutRow) p.lineTags.delete(line);
  h.end = cut;
  h.gap = true;
  h.rowsBelow = h.rowsBetween(cut, total);
  holdTop(p, above, top);
  return true;
}

/** Detached with more rows below the view than needed. */
function cutBelowDetached(p: TerminalHarnessPrompter, above: number, near: number): void {
  const h = p.scrollWindow;
  const W = p.alternateTranscript;
  const bottom = W.length + h.rowsBelow - p.alternateScrollback;
  if (W.length - bottom > 2 * near) dropBelow(p, above, near);
}

/** Let go of the rows far above the view (whole messages only). */
function trimFront(p: TerminalHarnessPrompter, above: number, near: number): void {
  const h = p.scrollWindow;
  const top = topIndex(p, above);
  if (top <= 2 * near) return;
  let drop = 0;
  let upTo = h.first;
  for (;;) {
    const next = p.messageLines.get(upTo + 1);
    if (next === undefined) break;
    const rows = next - p.alternateTrimmed;
    if (rows > top - near) break;
    drop = rows;
    upTo += 1;
  }
  if (upTo === h.first || drop <= 0) return;
  for (let index = h.first; index < upTo; index += 1) { h.measure(index, rowsOf(p, index)); p.messageLines.delete(index); }
  p.alternateTranscript.splice(0, drop);
  p.alternateTrimmed += drop;
  for (const line of [...p.lineTags.keys()]) if (line < p.alternateTrimmed) p.lineTags.delete(line);
  h.first = upTo;
}

/** How far the view can be scrolled back, counting the messages not rendered (estimated), and how far with only what is held. */
export function scrollReach(p: TerminalHarnessPrompter): { held: number; all: number } {
  const h = p.scrollWindow;
  const extra = h.detached ? 0 : p.scrollTail.rows.length;
  const held = Math.max(0, p.alternateTranscript.length + extra + h.rowsBelow - p.alternateAbove);
  return { held, all: held + (h.source ? h.rowsBetween(0, h.first) : 0) };
}

/** A scroll to row-offset `next` that is further back than the window can reach in a few batches: go there directly. The message
 * is found from the rows the messages above the window are thought to take. Returns whether it jumped. */
export function jumpForScroll(p: TerminalHarnessPrompter, next: number, reachable = scrollReach(p)): boolean {
  const h = p.scrollWindow;
  if (!h.source) return false;
  const { held, all } = reachable;
  if (next <= held + 3 * reach(p)) return false;
  // Further back than everything held, so above the window: among the messages before `first`.
  const target = h.messageAt(all - next);
  if (!target) return false;
  const message = Math.min(target.message, Math.max(0, h.first - 1));
  const into = message === target.message ? target.into : Math.max(0, all - next - h.rowsBetween(0, message));
  p.alternateScrollback = next;
  jumpTo(p, message, into, p.alternateAbove);
  return true;
}

/** Following the live end (End, Esc, a new turn): a detached view is written back from the list. */
export function followEnd(p: TerminalHarnessPrompter): boolean {
  if (!p.scrollWindow.detached) return false;
  p.scrollWindow.reset();
  toLive(p, undefined);
  return true;
}

/** Message and row of the view's first row, kept across the rewrite of the conversation. */
export function keepPlace(p: TerminalHarnessPrompter): void {
  const h = p.scrollWindow;
  if (h.anchor || p.alternateScrollback <= 0) return;
  h.anchor = placeOfTop(p, p.alternateAbove);
}
