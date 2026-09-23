/** Which models `/model` may choose from.
 *
 * This conversation's provider, and nothing else. `/model` on a session that
 * has a provider is not a question about providers: the conversation runs on
 * one, and a model belonging to another is not something this command could
 * set -- setting it would mean changing provider, which always branches the
 * conversation and is `/<harness>`'s decision to make. `/models` is the
 * cross-provider list, and it says so in its own name.
 *
 * Narrower still where the session has an account: that account's own models
 * are what a turn on it can actually run.
 */
export type ModelChoice = { account: string; provider: string; model: string };

type Evidence = { id: string; label: string; provider: string; models: string[] };

export function modelChoicesFor(
  session: { accountId?: string | null; provider?: string | null },
  accounts: readonly Evidence[],
): ModelChoice[] {
  const scoped = session.accountId
    ? accounts.filter((account) => account.id === session.accountId)
    : accounts.filter((account) => Boolean(session.provider) && account.provider === session.provider);
  return scoped.flatMap((account) => account.models.map((model) => ({
    account: account.label, provider: account.provider, model,
  })));
}
