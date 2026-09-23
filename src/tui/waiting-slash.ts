/** Whether a line typed while a turn is running is a ClikCode command.
 *
 * The composer accepts two different kinds of thing during a turn and they
 * used to be treated as one: text for the model (steered into the turn, or
 * queued behind it) and ClikCode's own slash commands. A slash line went to
 * the model as the literal characters "/model", which is neither what the user
 * asked for nor something the model can do anything with -- so a command was
 * simply unavailable for as long as an answer was streaming.
 *
 * This is deliberately only the FIRST half of the decision: whether the line
 * is even a candidate. The authority on what a slash line means is
 * routeSlashInput, which needs the session, the harness and the filesystem to
 * tell `/model` from `/etc/hosts explain this`. So this is generous, and the
 * caller routes what it gets and falls back to queueing it as conversation
 * when the router says that is what it really is.
 */
export function commandLineTypedDuringTurn(draft: string): string | undefined {
  const text = draft.trim();
  if (!text.startsWith('/')) return undefined;
  // `//text` is the explicit "send this to the harness verbatim" escape: it is
  // conversation by definition, and routing it as a command would take away
  // the one way to type a leading slash at the model.
  if (text.startsWith('//')) return undefined;
  return text.length > 1 ? text : undefined;
}
