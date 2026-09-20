import { splitIntoBlocks } from './markdown-render.js';
import type { MessageBlock } from './types.js';

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
): { settled: MessageBlock[]; live: MessageBlock[]; emitted: number } {
  // `parsedBlocks` lets a streaming caller supply its incrementally parsed
  // blocks; they are identical to splitIntoBlocks(content) by contract.
  const blocks = parsedBlocks ?? splitIntoBlocks(content);
  // A turn that ended settles everything, including a final block with no
  // blank line after it -- otherwise the last paragraph of every answer would
  // be stranded in the live region forever. Mid-stream, the last block is
  // still settled if a blank line already closed it: more text starts a NEW
  // block and can no longer alter this one.
  const closedByBlankLine = blocks.length > 0 && /\n[ \t]*\n$/.test(content);
  const settledCount = turnEnded || closedByBlankLine
    ? blocks.length
    : Math.max(0, blocks.length - 1);
  const emitted = Math.min(alreadyEmitted, settledCount);
  return {
    settled: blocks.slice(emitted, settledCount),
    live: blocks.slice(settledCount),
    emitted: settledCount,
  };
}

/** A tool row is settled the moment the tool finishes: completion is what
 * rewrites it with its output preview, so before that it must stay live, and
 * after it nothing touches it again. A tool that never reports completion is
 * settled by the end of the turn rather than pinning the region forever. */
export function settledToolRows(
  tools: readonly { id: string; done: boolean; lines: readonly string[] }[],
  alreadyEmitted: ReadonlySet<string>,
  turnEnded: boolean,
): { settled: string[]; live: string[]; emitted: string[] } {
  const settled: string[] = [];
  const live: string[] = [];
  const emitted: string[] = [];
  for (const tool of tools) {
    if (alreadyEmitted.has(tool.id)) continue;
    if (tool.done || turnEnded) {
      settled.push(...tool.lines);
      emitted.push(tool.id);
    } else {
      live.push(...tool.lines);
    }
  }
  return { settled, live, emitted };
}

/** A tool row carries the response offset it started at, so a tool that
 * settles in the same frame as the prose around it lands where it happened
 * rather than after everything. Nothing is ever re-ordered once written: a
 * tool that completes late is appended where it became final, which is what
 * append-only means. */
export type SettlingTool = {
  id: string; done: boolean; lines: readonly string[]; responseOffset?: number;
};

export type BlockRenderer = (blocks: readonly MessageBlock[], firstOfMessage: boolean) => string[];

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
    const answer = settledAnswerBlocks(input.content, this.emittedBlocks, input.turnEnded, input.blocks);
    // Same rule as settledToolRows, kept grouped so a tool's rows can be
    // placed at the offset it started at rather than after all of the prose.
    const isSettled = (tool: SettlingTool): boolean => tool.done || input.turnEnded;
    const owing = input.tools.filter((tool) => !this.emittedTools.has(tool.id));
    const settledTools = owing.filter(isSettled);
    const liveToolLines = owing.filter((tool) => !isSettled(tool)).flatMap((tool) => [...tool.lines]);
    const renderLive = input.renderLive ?? input.renderBlocks;

    // The head of an open fence was already retired line by line; only the
    // lines after it are still owed when the block itself finally settles.
    let settled = answer.settled;
    const head = settled[0];
    if (this.openCodeLines > 0 && head) {
      if (head.kind === 'code') {
        const owed = head.lines.slice(this.openCodeLines);
        settled = owed.length ? [{ ...head, lines: owed, language: undefined }, ...settled.slice(1)] : settled.slice(1);
      }
      this.openCodeLines = 0;
    }

    const finished = interleave(settled, settledTools, input.renderBlocks, !this.started);
    if (finished.length) this.started = true;
    this.emittedBlocks = answer.emitted;
    for (const tool of settledTools) this.emittedTools.add(tool.id);

    // An open fence retires every source line but the one still being typed.
    const open = answer.live.length === 1 ? answer.live[0]! : undefined;
    let live: string[] = [];
    if (open?.kind === 'code' && open.lines.length > 1) {
      const complete = open.lines.slice(this.openCodeLines, open.lines.length - 1);
      if (complete.length) {
        const head = { ...open, lines: complete, ...(this.openCodeLines ? { language: undefined } : {}) };
        const rows = input.renderBlocks([head], !this.started);
        if (rows.length) this.started = true;
        finished.push(...rows);
        this.openCodeLines = open.lines.length - 1;
      }
      live = renderLive(
        [{ ...open, lines: [open.lines[open.lines.length - 1]!], ...(this.openCodeLines ? { language: undefined } : {}) }],
        !this.started,
      );
    } else if (answer.live.length) {
      live = renderLive(answer.live, !this.started);
    }
    live.push(...liveToolLines);
    return { finished, live };
  }

  reset(): void {
    this.emittedBlocks = 0;
    this.emittedTools.clear();
    this.openCodeLines = 0;
    this.started = false;
  }
}
