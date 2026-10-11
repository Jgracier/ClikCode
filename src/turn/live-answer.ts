/** Which copy of a running turn's answer a window that joins it starts from.
 *
 * Two sources describe the same text and arrive at different times: the
 * worker's live copy (what has streamed, to the character) and the journal's
 * `pendingTurn.response`, which is written on a debounce and so can be a few
 * hundred milliseconds behind. A client that took the journal's alone showed a
 * shorter answer than a window that had been attached all along.
 *
 * The repo's rule for two-source rows: the durable copy wins once it is at
 * least as long as the live one, and until then the live copy stands -- so
 * the result depends only on the two texts, never on which was read first. */
export function joinedAnswerText(durable: string | undefined, live: string | undefined): string {
  const saved = durable ?? '';
  const streamed = live ?? '';
  return saved.length >= streamed.length ? saved : streamed;
}
