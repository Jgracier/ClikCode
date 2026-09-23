/** The message the user just submitted, while the turn it started is running.
 *
 * A decision, not a field read, because it has two sources that arrive at
 * different times and neither one is available for the whole turn:
 *
 *  - the CLIENT knows the prompt the moment Enter is pressed, and renders it
 *    immediately -- there is nothing to wait for and waiting would feel broken;
 *  - the WORKER writes it to `session.pendingTurn` a moment later, and that is
 *    the only copy a client which attached mid-turn can see.
 *
 * A session snapshot pushed in the window between the two has neither: not in
 * `messages` (the turn has not completed), not in `pendingTurn` (not yet
 * written). Reading only the snapshot therefore made the message the user had
 * just sent appear and then vanish, for as long as that window lasted.
 *
 * So the client's own copy is held for the turn and used as the fallback. The
 * durable copy still wins where both exist -- the same rule the queued and
 * steered rows follow, and for the same reason: a row drawn from two sources
 * reads as the user having said it twice, and the transcript is append-only.
 */
export function pendingPromptText(input: {
  /** `session.pendingTurn?.prompt` from the snapshot being painted. */
  durable?: string;
  /** What this client submitted, held from Enter until the turn ends. */
  sticky?: string;
  /** The last message already in the transcript. */
  lastMessage?: { role: 'user' | 'assistant'; content: string } | undefined;
}): string | undefined {
  if (input.durable) return input.durable;
  if (!input.sticky) return undefined;
  // The turn completed and its prompt is a real message now. Drawing the
  // sticky copy on top of it is the duplicate this function exists to avoid.
  const last = input.lastMessage;
  if (last?.role === 'user' && last.content === input.sticky) return undefined;
  return input.sticky;
}
