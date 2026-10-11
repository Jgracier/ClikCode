/** Where a steer lands in the answer text (standards 1.5 and 11).
 *
 * The live view lets a steer wait for the block it fell inside: the block is
 * settled whole and the steer is drawn after it, never in the middle of a
 * sentence (turn/transcript.ts, SettlingTool.steer). A saved answer is split
 * into messages at the steer, so the split uses the same place -- otherwise a
 * reopened chat shows a half sentence, then the steer, then the other half,
 * which the window that ran the turn never did.
 *
 * The rows that began around the steer keep their own (offset, seq) -- only
 * the text is split here. */

import { splitIntoBlocks } from '../tui/render/markdown.js';

/** The end of the block `offset` falls inside, as the live transcript places
 * a row at that offset (the first block whose end is at or past it); 0 stays
 * before any prose, and an offset past the text is the end of it. */
export function steerTextOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;
  for (const block of splitIntoBlocks(text)) {
    if (block.sourceEnd >= offset) return Math.min(block.sourceEnd, text.length);
  }
  return text.length;
}
