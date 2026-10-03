/** A narrow recovery for an agent that answers an explicit work order with
 * an offer to do that same work later. Not a success judge: a status report,
 * a blocker or an audit answer is a real reply and is never re-driven. */
export function deferredWorkReply(request: string, reply: string): boolean {
  const ask = request.trim();
  // A question, or a request for a report, is answered by a report.
  if (ask.includes('?')) return false;
  if (/\b(?:tell me|explain|audit|review|summari[sz]e|report|status|how (?:much|many|far|close)|what|why|whether)\b/i.test(ask)) {
    return false;
  }
  const ordersWork = /^(?:ok(?:ay)?[, ]+)?(?:please\s+)?(?:fully\s+)?(?:complete|finish|implement|build|fix)\b/i.test(ask)
    || /\b(?:complete it|get it done|finish it|do the work|do it)\b/i.test(ask);
  if (!ordersWork) return false;
  // Only an explicit offer to start later counts; "not complete" or a list
  // of remaining work is how an honest finished answer often reads.
  return /\bif you want(?:,?\s+i can)?\b[^.!?\n]{0,100}\b(?:do|build|implement|finish|complete|continue|next)\b/i.test(reply)
    || /\b(?:i can|we can)\s+(?:keep going|do (?:that|this|it|the next)|take the next step|proceed)\b[^.!?\n]{0,60}\b(?:next|now|right away|if you want|in order)\b/i.test(reply)
    || /\bi(?:'ll| will) proceed from\b/i.test(reply);
}

export const DEFERRED_WORK_CONTINUATION =
  'The user asked you to carry out the work, not to report its status or offer to start later. '
  + 'Inspect the current workspace and perform the remaining authorized steps now. '
  + 'If a concrete external blocker prevents completion, state it precisely after completing all independent work.';
