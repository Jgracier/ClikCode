/** The provider a command already named, without saying so.
 *
 * `/model claude-opus-5` on a session with no provider chosen used to refuse,
 * and then (one commit ago) ask. Both are wrong when the answer is already in
 * the question: exactly one configured account publishes that model, so the
 * provider is not a decision the user has left open -- it is a lookup.
 *
 * The rule throughout: derive it when the evidence is unique, ask when it is
 * not, and never guess. Two accounts publishing the same model is a real
 * choice and gets a picker; one is an answer.
 *
 * Accounts are the evidence because they are what a turn actually runs on.
 * The catalog knows which models a harness could have; only an account knows
 * which are configured here, and offering a provider the user has no account
 * for would replace one dead end with another.
 */
import type { AiHarnessAccount } from '../../harness/definition.js';

type Evidence = Pick<AiHarnessAccount, 'provider' | 'label' | 'models' | 'status'>;

/** Accounts that could actually run something. An offline or signed-out
 * account is not evidence of where the user meant to go. */
function usable(accounts: readonly Evidence[]): readonly Evidence[] {
  return accounts.filter((account) => account.status === 'ready');
}

function soleProvider(accounts: readonly Evidence[]): string | undefined {
  const providers = new Set(accounts.map((account) => account.provider));
  return providers.size === 1 ? [...providers][0] : undefined;
}

const sameWord = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

export function providerImpliedBy(
  route: { head: string; args: string },
  accounts: readonly Evidence[],
): string | undefined {
  const args = route.args.trim();
  const ready = usable(accounts);
  if (route.head === 'model') {
    if (!args) return undefined;
    // A model name is specific. `/model auto` and `/model default` are not --
    // they mean "whatever this harness publishes", which is a statement about
    // a provider rather than evidence of one.
    if (['auto', 'default'].includes(args.toLowerCase())) return undefined;
    return soleProvider(ready.filter((account) => account.models.some((model) => sameWord(model, args))));
  }
  if (route.head === 'account' || route.head === 'accounts') {
    // `/account work` and `/accounts use work` name the same thing. Any other
    // /accounts subcommand (add, remove, failover, a bare list) is not naming
    // one, so there is nothing to derive from it.
    const label = route.head === 'accounts'
      ? (/^use\s+/i.test(args) ? args.replace(/^use\s+/i, '') : '')
      : args;
    if (!label.trim()) return undefined;
    // Not filtered to ready accounts: switching to one that is signed out is
    // a legitimate thing to do, and it says where the user means to go.
    return soleProvider(accounts.filter((account) => sameWord(account.label, label)));
  }
  if (route.head === 'login') {
    // Nothing to match on, so the only safe inference is that there is only
    // one place to sign in to. Signed-out accounts count here: being signed
    // out is the reason for typing this.
    return soleProvider(accounts);
  }
  return undefined;
}
