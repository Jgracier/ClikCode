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
  content: string, alreadyEmitted: number, turnEnded: boolean,
): { settled: MessageBlock[]; live: MessageBlock[]; emitted: number } {
  const blocks = splitIntoBlocks(content);
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

/** Tracks what a turn has already retired, so each frame emits only what is
 * newly final. Reset per turn; it holds no history beyond the current one
 * because scrollback holds everything else. */
export class TurnTranscript {
  private emittedBlocks = 0;
  private readonly emittedTools = new Set<string>();

  /** Rows newly settled since the last call, plus what is still live.
   * `renderBlocks` and the tool lines come from the caller so this stays free
   * of any dependency on how a row is painted. */
  advance(input: {
    content: string;
    tools: readonly { id: string; done: boolean; lines: readonly string[] }[];
    turnEnded: boolean;
    renderBlocks: (blocks: readonly MessageBlock[], firstOfMessage: boolean) => string[];
  }): { finished: string[]; live: string[] } {
    const answer = settledAnswerBlocks(input.content, this.emittedBlocks, input.turnEnded);
    const tools = settledToolRows(input.tools, this.emittedTools, input.turnEnded);

    const startsMessage = this.emittedBlocks === 0;
    const finished = [
      ...(answer.settled.length ? input.renderBlocks(answer.settled, startsMessage) : []),
      ...tools.settled,
    ];
    const live = [
      ...(answer.live.length ? input.renderBlocks(answer.live, startsMessage && !answer.settled.length) : []),
      ...tools.live,
    ];

    this.emittedBlocks = answer.emitted;
    for (const id of tools.emitted) this.emittedTools.add(id);
    return { finished, live };
  }

  reset(): void {
    this.emittedBlocks = 0;
    this.emittedTools.clear();
  }
}
