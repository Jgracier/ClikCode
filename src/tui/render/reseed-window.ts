/** Where a full-conversation reseed starts painting.
 *
 * Opening a long chat used to lay out every message before the first frame.
 * The alternate screen only shows a viewport of that; older rows sit in
 * `alternateTranscript` for scroll-up, capped anyway. Starting near the end
 * makes the first paint O(viewport) instead of O(history). Scroll reaches
 * what was painted -- the same trade-off as the row cap. */

const WRAP_COLUMNS = 80;

/** Rough rows one message will take once wrapped, plus the blank gaps the
 * painter puts around it. Exact layout can differ; this only picks a start. */
function estimatedRows(content: string): number {
  let lines = 0;
  for (const line of content.split('\n')) {
    lines += Math.max(1, Math.ceil(Math.max(line.length, 1) / WRAP_COLUMNS));
  }
  return lines + 2;
}

/** Index of the first message to paint on a reseed, given a row budget for
 * the visible tail. `0` when the whole list fits. */
export function reseedStartIndex(
  messages: readonly { content: string }[],
  rowBudget: number,
): number {
  if (messages.length === 0 || rowBudget <= 0) return 0;
  let rows = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    rows += estimatedRows(messages[index]!.content);
    if (rows >= rowBudget) return index;
  }
  return 0;
}
