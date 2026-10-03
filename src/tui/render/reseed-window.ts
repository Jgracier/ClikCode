/** Where a full-conversation reseed starts painting.
 *
 * Opening a long chat used to lay out every message before the first frame.
 * Older rows sit in `alternateTranscript` for scroll-up, which keeps a fixed
 * number of rows anyway, so painting from as far back as that cap reaches
 * costs O(cap) instead of O(history) and loses nothing scroll could show.
 * A smaller window (three screens) cut a phone's chat off at its last long
 * answer after every switch. */

/** Rough rows one message will take once wrapped at `columns`, plus the
 * blank gaps the painter puts around it. Exact layout can differ; this only
 * picks a start. */
function estimatedRows(content: string, columns: number): number {
  let lines = 0;
  for (const line of content.split('\n')) {
    lines += Math.max(1, Math.ceil(Math.max(line.length, 1) / columns));
  }
  return lines + 2;
}

/** Index of the first message to paint on a reseed: as far back as `rowBudget`
 * rows reach at this width -- the budget is what the transcript keeps for
 * scrolling up, so nothing it could hold is left out. `0` when it all fits. */
export function reseedStartIndex(
  messages: readonly { content: string }[],
  rowBudget: number,
  columns: number,
): number {
  if (messages.length === 0 || rowBudget <= 0) return 0;
  const width = Math.max(1, columns);
  let rows = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    rows += estimatedRows(messages[index]!.content, width);
    if (rows >= rowBudget) return index;
  }
  return 0;
}
