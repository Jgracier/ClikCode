/** A narrow recovery for an agent that answers an explicit work order with
 * an offer to do that same work later. Not a success judge: a status report,
 * a blocker or an audit answer is a real reply and is never re-driven, and a
 * reply that did the work and then offers optional extras is finished. */

/** A request answered by being told something, not by work: a question, or a
 * request for an audit, review, explanation or report. Only request FORMS
 * count; bare words do not, so "fix the list view" or "fix how the cache
 * invalidates" stay work orders. */
const REPORT_REQUEST = new RegExp([
  String.raw`\b(?:tell|show) me\b`,
  String.raw`\b(?:explain|describe|summari[sz]e)\b`,
  String.raw`\b(?:how|why) (?:is|are|was|were|do|does|did|much|many|come)\b`,
  String.raw`\bwhat (?:is|are|was|were|do|does|did|remains|happened)\b`,
  String.raw`\b(?:check|see|find out|let me know) (?:if|whether)\b`,
  String.raw`\blist (?:the|all|what|which|every)\b`,
  String.raw`\b(?:do|run|write|give me|get me) (?:a|an|the|me (?:a|an|the))?\s*(?:audit|review|report|summary|status)\b`,
  String.raw`^(?:audit|review|report on|status)\b`,
].join('|'), 'i');

const WORK_ORDER = /^(?:ok(?:ay)?[, ]+)?(?:(?:i said|now)\s+)?(?:please\s+)?(?:fully\s+)?(?:complete|finish|implement|build|fix|do)\b/i;
const WORK_ORDER_ANYWHERE = /\b(?:complete it|get it done|finish it|do the work|do it)\b/i;

/** The reply says the work happened. Negated or future forms ("not done",
 * "to be done", "isn't fixed yet", "nothing has been committed") do not
 * count. */
const NOT_NEGATED = String.raw`(?<!\bnot\s|\bnot yet\s|\bnot been\s|\bbe\s|n't\s|n't been\s|\bnever\s|\bnothing (?:has |have |had )?(?:been|was|is|got)\s|\bno \w+ (?:has|have|had) been\s|\bno \w+ (?:was|were)\s)`;
const COMPLETED = new RegExp(
  String.raw`(?:^|[\s(*_\-])${NOT_NEGATED}(?:done|fixed|implemented|pushed|committed|completed|resolved|merged|shipped|landed|applied)\b`
  + String.raw`|\b(?:all\s+)?(?:\d+\s+)?(?:tests?|specs?|checks?)\s+(?:now\s+)?(?:pass(?:es|ed|ing)?|green)\b`,
  'i',
);
/** Words that make what follows in the same sentence a plan, a future or a
 * condition, not a report: "make sure all tests pass", "the build will
 * pass", "once it's fixed". */
const NOT_YET_REAL = /\b(?:will|would|should|shall|going to|make sure|ensure|once|when|after|until|unless|if|need(?:s|ed)? to|to be|plan)\b|'ll\b/i;

/** Any sentence reports the work as done, outside a plan/future/condition. */
function reportsCompletion(reply: string): boolean {
  return reply.split(/[.!?\n;\u2026]+/).some((sentence) => {
    const hit = COMPLETED.exec(sentence);
    return hit !== null && !NOT_YET_REAL.test(sentence.slice(0, hit.index + 1));
  });
}

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
  if (reportsCompletion(reply)) return false;
  return OFFERS.some((offer) => offer.test(reply));
}

export const DEFERRED_WORK_CONTINUATION =
  'The user asked you to carry out the work, not to report its status or offer to start later. '
  + 'Inspect the current workspace and perform the remaining authorized steps now. '
  + 'If a concrete external blocker prevents completion, state it precisely after completing all independent work.';
