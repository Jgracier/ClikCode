/** A narrow recovery for an agent that answers an explicit work order with
 * an offer to do that same work later. Not a success judge: a status report,
 * a blocker or an audit answer is a real reply and is never re-driven, and a
 * reply that did the work and then offers optional extras is finished. */

/** A request answered by being told something, not by work: a question, or a
 * request for an audit, review, explanation or report. */
const REPORT_REQUEST = /\b(?:tell me|explain|audit|review|summari[sz]e|report|status|how|what|why|whether|describe|show me|list)\b/i;

const WORK_ORDER = /^(?:ok(?:ay)?[, ]+)?(?:(?:i said|now)\s+)?(?:please\s+)?(?:fully\s+)?(?:complete|finish|implement|build|fix|do)\b/i;
const WORK_ORDER_ANYWHERE = /\b(?:complete it|get it done|finish it|do the work|do it)\b/i;

/** The reply says the work happened. Negated or future forms ("not done",
 * "to be done", "isn't fixed yet") do not count. */
const NOT_NEGATED = String.raw`(?<!\bnot\s|\bnot yet\s|\bnot been\s|\bbe\s|n't\s|n't been\s|\bnever\s)`;
const COMPLETED = new RegExp(
  String.raw`(?:^|[\s(*_\-])${NOT_NEGATED}(?:done|fixed|implemented|pushed|committed|completed|resolved|merged|shipped|landed|applied)\b`
  + String.raw`|\b(?:all\s+)?(?:\d+\s+)?(?:tests?|specs?|checks?)\s+(?:now\s+)?(?:pass(?:es|ed|ing)?|green)\b`,
  'i',
);

/** An explicit offer to start the requested work later. */
const OFFERS = [
  /\bif you(?:'d)? (?:want|like)(?:,?\s+i can)?\b[^.!?\n]{0,100}\b(?:do|build|implement|fix|finish|complete|continue|next)\b/i,
  /\b(?:i|we) can\s+(?:now\s+)?(?:fix|implement|build|do|finish|complete|continue|start|proceed|keep going|take the next step|apply|make)\b[^.!?\n]{0,80}\b(?:next|now|right away|if you(?:'d)? (?:want|like)|in order|once you confirm)\b/i,
  /\bi(?:'ll| will) proceed from\b/i,
];

export function deferredWorkReply(request: string, reply: string): boolean {
  const ask = request.trim();
  if (ask.includes('?') || REPORT_REQUEST.test(ask)) return false;
  if (!WORK_ORDER.test(ask) && !WORK_ORDER_ANYWHERE.test(ask)) return false;
  // A reply that reports the work done and offers more is finished; the
  // offer is an optional extra, not the requested work put off.
  if (COMPLETED.test(reply)) return false;
  return OFFERS.some((offer) => offer.test(reply));
}

export const DEFERRED_WORK_CONTINUATION =
  'The user asked you to carry out the work, not to report its status or offer to start later. '
  + 'Inspect the current workspace and perform the remaining authorized steps now. '
  + 'If a concrete external blocker prevents completion, state it precisely after completing all independent work.';
