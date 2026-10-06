import { splitIntoBlocks } from '../tui/render/markdown.js';
import type { MessageBlock } from '../harness/prompter.js';

/** Which parts of a turn can never change again.
 *
 * This is the one decision an append-only transcript has to make, and it is
 * deliberately the only place that makes it. A row is retired to scrollback
 * when — and only when — nothing that happens later can alter it.
 *
 * The renderer this replaces asked the question backwards: it re-rendered
 * everything every frame and then tried to work out how much of the result was
 * safe to keep. That calculation had to account for tools whose rows were still
 * being rewritten, counts that grew, queued rows that would become real
 * messages, and answers that were re-extracted at a different length. Each of
 * those produced its own class of bug. Here nothing is retired until it is
 * final, so there is nothing to reconcile afterwards.
 */

/** A streaming answer's last block may still grow, so it is never settled
 * until the turn ends. Everything before it is structurally complete: a new
 * block began, which no amount of further text can undo. */
export function settledAnswerBlocks(
  content: string, alreadyEmitted: number, turnEnded: boolean, parsedBlocks?: readonly MessageBlock[],
  /** A tool call began after every character of `content`. */
  closedByTool = false,
): { settled: MessageBlock[]; live: MessageBlock[]; emitted: number } {
  // `parsedBlocks` lets a streaming caller supply its incrementally parsed
  // blocks; they are identical to splitIntoBlocks(content) by contract.
  const blocks = parsedBlocks ?? splitIntoBlocks(content);
  // A turn that ended settles everything, including a final block with no
  // blank line after it -- otherwise the last paragraph of every answer would
  // be stranded in the live region forever. Mid-stream, the last block is
  // still settled if a blank line already closed it: more text starts a NEW
  // block and can no longer alter this one.
  //
  // A tool call closes it just as surely. The model wrote a sentence and then
  // went to work: nothing it does afterwards can edit that sentence, and
  // waiting for a blank line that never comes left the paragraph pinned above
  // the waiting row for the length of the turn -- stationary, while the tool
  // rows it caused scrolled past above it.
  // Not inside a fence still open: a blank line there is a line of code.
  const last = blocks[blocks.length - 1];
  const closedByBlankLine = blocks.length > 0 && /\n[ \t]*\n$/.test(content) && !(last?.kind === 'code' && last.open);
  const settledCount = turnEnded || closedByBlankLine || closedByTool
    ? blocks.length
    : Math.max(0, blocks.length - 1);
  const emitted = Math.min(alreadyEmitted, settledCount);
  return {
    settled: blocks.slice(emitted, settledCount),
    live: blocks.slice(settledCount),
    emitted: settledCount,
  };
}

/** A tool row carries the response offset it started at, so a tool that
 * settles in the same frame as the prose around it lands where it happened
 * rather than after everything. Nothing is ever re-ordered once written: a
 * tool that completes late is appended where it became final, which is what
 * append-only means. */
export type SettlingTool = {
  id: string; done: boolean; lines: readonly string[]; responseOffset?: number;
};

type BlockRenderer = (blocks: readonly MessageBlock[], firstOfMessage: boolean) => string[];

/** Merge newly settled tool rows into newly settled prose by response offset,
 * using the same rule responseTimeline uses on screen: a tool belongs after
 * the first block its offset falls inside, and an offset of zero belongs
 * before any prose at all. */
function interleave(
  blocks: readonly MessageBlock[], tools: readonly SettlingTool[],
  render: BlockRenderer, startsMessage: boolean,
): string[] {
  const offset = (tool: SettlingTool): number => tool.responseOffset ?? Number.POSITIVE_INFINITY;
  const pending = [...tools].sort((left, right) => offset(left) - offset(right));
  const out: string[] = [];
  let first = startsMessage;
  let run: MessageBlock[] = [];
  const flush = (): void => {
    if (!run.length) return;
    out.push(...render(run, first));
    first = false;
    run = [];
  };
  const take = (limit: number): void => {
    while (pending.length && offset(pending[0]!) <= limit) out.push(...pending.shift()!.lines);
  };
  take(0);
  for (const block of blocks) {
    run.push(block);
    if (pending.length && offset(pending[0]!) <= block.sourceEnd) {
      flush();
      take(block.sourceEnd);
    }
  }
  flush();
  for (const tool of pending) out.push(...tool.lines);
  return out;
}

/** Tracks what a turn has already retired, so each frame emits only what is
 * newly final. Reset per turn; it holds no history beyond the current one
 * because scrollback holds everything else. */
export class TurnTranscript {
  private emittedBlocks = 0;
  private readonly emittedTools = new Set<string>();
  /** Source lines of the open code fence already retired. A fence is the one
   * construct whose completed lines are final before the block itself is: each
   * wraps independently of the ones after it. Without this an answer whose code
   * block is taller than the viewport could never retire its head rows. */
  private openCodeLines = 0;
  /** Rendered rows of the open PROSE block already retired, and whether that
   * block began its message. Word wrap only ever extends the last line, so a
   * row that already has another row after it can never change -- which makes
   * every row but the last one final the moment it exists. Without this the
   * whole paragraph sat above the composer until a blank line closed it, then
   * jumped into the transcript at once. */
  private openProseRows = 0;
  private openProseFirst = false;
  /** The blank row that separates the open block from the one before it has
   * already been retired. Each retirement renders the block on its own, and
   * the renderer opens every block after the first with that row: written
   * again with each later chunk, it put a blank line between every pair of
   * code lines, and another under the "```" paragraph a fence begins as. */
  private openSeparated = false;
  /** The last block any rows were retired for: an item continuing a list
   * gets no blank row above it, whichever frame retired the item before. */
  private lastBlock: MessageBlock | undefined;
  /** Whether anything at all has been written for this message, which is what
   * decides the leading marker -- not the block count, which is still zero
   * while the head of an open fence is being retired line by line. */
  private started = false;

  /** Rows newly settled since the last call, plus what is still live.
   * `renderBlocks` and the tool lines come from the caller so this stays free
   * of any dependency on how a row is painted. */
  advance(input: {
    content: string;
    /** Incrementally parsed blocks for `content`, when the caller has them. */
    blocks?: readonly MessageBlock[];
    tools: readonly SettlingTool[];
    turnEnded: boolean;
    renderBlocks: BlockRenderer;
    /** Optional separate renderer for the block still receiving tokens. */
    renderLive?: BlockRenderer;
  }): { finished: string[]; live: string[] } {
    // A last line of only dashes or equals signs is either a list item or
    // the underline that turns the line above into a heading, and the next
    // character decides which. Lexed now it made a heading of a list item's
    // text, whose rows were then retired under the wrong shape.
    const undecided = input.turnEnded ? null : /(?:^|\n) {0,3}(?:-+|=+)[ \t]*$/.exec(input.content);
    if (undecided) {
      const content = input.content.slice(0, undecided.index + (undecided[0].startsWith('\n') ? 1 : 0));
      return this.advance({ ...input, content, blocks: splitIntoBlocks(content) });
    }
    // A tool that began at or after the end of the prose proves the prose is
    // final: the model stopped writing to call it. A call that is still
    // running closes that prose too, so its row can sit directly under it
    // instead of under whatever sentence arrives next.
    const closedByTool = input.tools.some((tool) => tool.responseOffset !== undefined
      && tool.responseOffset >= input.content.length && input.content.length > 0);
    const answer = settledAnswerBlocks(input.content, this.emittedBlocks, input.turnEnded, input.blocks, closedByTool);
    // Same rule as settledToolRows, kept grouped so a tool's rows can be
    // placed at the offset it started at rather than after all of the prose.
    const isSettled = (tool: SettlingTool): boolean => tool.done || input.turnEnded;
    const owing = input.tools.filter((tool) => !this.emittedTools.has(tool.id));
    const settledTools = owing.filter(isSettled);
    const liveTools = owing.filter((tool) => !isSettled(tool));
    const renderLive = input.renderLive ?? input.renderBlocks;
    /** Rows for `blocks` as they continue what is already written: without
     * the leading separator when it was written already (`joined`) or when
     * the first block continues the list the last one belonged to. */
    const continuing = (blocks: readonly MessageBlock[], first: boolean, joined: boolean, render: BlockRenderer = input.renderBlocks): string[] => {
      const rows = render(blocks, first);
      const tight = this.lastBlock?.kind === 'list-item' && blocks[0]?.kind === 'list-item';
      return !first && rows[0] === '' && (joined || tight) ? rows.slice(1) : rows;
    };

    // The head of an open fence was already retired line by line; only the
    // lines after it are still owed when the block itself finally settles.
    let settled = answer.settled;
    const head = settled[0];
    let headJoined = false;
    if (head && this.openSeparated && (head.kind === 'code' || this.openProseRows === 0)) headJoined = true;
    if (this.openCodeLines > 0 && head) {
      if (head.kind === 'code') {
        const owed = head.lines.slice(this.openCodeLines);
        settled = owed.length ? [{ ...head, lines: owed, language: undefined }, ...settled.slice(1)] : settled.slice(1);
        if (!owed.length) headJoined = false;
      }
      this.openCodeLines = 0;
    }

    // A prose block whose head rows were already retired while it streamed
    // owes only its tail now that it has closed. Rendered rows rather than
    // source lines, because how prose wraps is what was written.
    const finished: string[] = [];
    if (this.openProseRows > 0 && head && head.kind !== 'code') {
      const tail = continuing([head], this.openProseFirst, false).slice(this.openProseRows);
      if (tail.length) { finished.push(...tail); this.started = true; }
      this.lastBlock = head;
      settled = settled.slice(1);
      headJoined = false;
    }
    if (head) { this.openProseRows = 0; this.openSeparated = false; }

    let firstRun = true;
    finished.push(...interleave(settled, settledTools, (run, first) => {
      const rows = firstRun ? continuing(run, first, headJoined) : input.renderBlocks(run, first);
      firstRun = false;
      this.lastBlock = run[run.length - 1];
      return rows;
    }, !this.started));
    if (finished.length) this.started = true;
    // Monotonic, for the same reason the message loop is: a row in scrollback
    // cannot be un-emitted. A turn that streams part of an answer, hits a
    // quota wall and fails over resets its live response to '' -- and that
    // empty paint used to carry `emitted: 0` back here, so when the retry
    // streamed the same answer again every block looked new and the whole
    // thing was written a second time under the copy already on screen.
    this.emittedBlocks = Math.max(this.emittedBlocks, answer.emitted);
    for (const tool of settledTools) this.emittedTools.add(tool.id);

    // An open fence retires every source line but the one still being typed.
    const open = answer.live.length === 1 ? answer.live[0]! : undefined;
    let live: string[] = [];
    if (open?.kind === 'code' && open.lines.length > 1) {
      // A fence begins as a "```" paragraph, whose separator may be out already.
      this.openProseRows = 0;
      const complete = open.lines.slice(this.openCodeLines, open.lines.length - 1);
      if (complete.length) {
        const head = { ...open, lines: complete, ...(this.openCodeLines ? { language: undefined } : {}) };
        const rows = continuing([head], !this.started, this.openSeparated);
        if (rows.length) { this.started = true; this.openSeparated = true; this.lastBlock = open; }
        finished.push(...rows);
        this.openCodeLines = open.lines.length - 1;
      }
      live = continuing(
        [{ ...open, lines: [open.lines[open.lines.length - 1]!], ...(this.openCodeLines ? { language: undefined } : {}) }],
        !this.started, this.openSeparated, renderLive,
      );
    } else if (open && open.kind !== 'code') {
      // Everything but the row still being written is final.
      if (this.openProseRows === 0) this.openProseFirst = !this.started;
      // Still growing: drawn by the live renderer, which lays out only what
      // changed since the last frame (the same rows, by its contract).
      const rows = continuing([open], this.openProseFirst, this.openSeparated && this.openProseRows === 0, renderLive);
      const keep = Math.max(this.openProseRows, rows.length - 1);
      const newly = rows.slice(this.openProseRows, keep);
      if (newly.length) {
        finished.push(...newly);
        this.started = true;
        this.openProseRows = keep;
        this.openSeparated = true;
      }
      live = rows.slice(keep);
    } else if (answer.live.length) {
      live = continuing(answer.live, !this.started, this.openSeparated, renderLive);
    }
    // A running call stays where it started. One whose offset is already
    // behind the live prose sits at the top of this region, directly under
    // the scrollback it will join when it finishes. One still ahead of the
    // text sits at the end. Appending every running call after the text is
    // what made the row jump up the page when the checkmark was written.
    const blocks = input.blocks ?? splitIntoBlocks(input.content);
    const liveSourceStart = answer.emitted === 0 ? 0 : (blocks[answer.emitted - 1]?.sourceEnd ?? 0);
    const before: string[] = [];
    const after: string[] = [];
    for (const tool of [...liveTools].sort((left, right) => (left.responseOffset ?? Number.POSITIVE_INFINITY) - (right.responseOffset ?? Number.POSITIVE_INFINITY))) {
      const offset = tool.responseOffset ?? Number.POSITIVE_INFINITY;
      if (offset <= liveSourceStart) before.push(...tool.lines);
      else after.push(...tool.lines);
    }
    live = [...before, ...live, ...after];
    return { finished, live };
  }

  reset(): void {
    this.emittedBlocks = 0;
    this.emittedTools.clear();
    this.openCodeLines = 0;
    this.openProseRows = 0;
    this.openProseFirst = false;
    this.openSeparated = false;
    this.lastBlock = undefined;
    this.started = false;
  }
}
