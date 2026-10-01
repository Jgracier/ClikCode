/** What an account is called: the email its sign-in reveals, read once, when
 * it signs in. Nothing renames an account afterwards -- opening a list of
 * accounts never does. A harness that reveals no email keeps a numbered
 * placeholder ("Kiro CLI 1") or the name the user gave. */

import { vendorAccountEmail } from './vendor-identity.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';

/** The email (or, for Copilot, the GitHub login) the harness itself reports
 * for the account in `profilePath`, read right after its sign-in. Undefined
 * -- never a fabricated name -- for a harness that keeps none; the numbered
 * placeholder below covers those. See vendor-identity.ts for each source. */
export function deriveAccountLabel(harness: AiLocalHarnessDefinition, profilePath: string | undefined): Promise<string | undefined> {
  return vendorAccountEmail(harness, profilePath);
}

/** The one naming rule, applied only when an account signs in or is
 * created: a label is unique among one provider's accounts, ignoring case
 * (the same person's email on two harnesses is two real accounts).
 * `preferred` is the email the sign-in revealed or the name the user gave; a
 * taken one gets " (2)", " (3)", ... Without one, the harness's numbered
 * placeholder: "Codex 2" after removing "Codex 1" of two used to collide with
 * the surviving "Codex 2" (the number was just count + 1), so it is the first
 * number nobody holds. */
export function nameAccount(
  accounts: readonly Pick<AiHarnessAccount, 'id' | 'provider' | 'label'>[],
  harness: Pick<AiLocalHarnessDefinition, 'provider' | 'displayName'>,
  preferred?: string, exceptId?: string,
): string {
  const used = (label: string): boolean => accounts.some((account) => account.id !== exceptId
    && account.provider === harness.provider && account.label.toLowerCase() === label.toLowerCase());
  if (preferred && !used(preferred)) return preferred;
  for (let number = preferred ? 2 : 1; ; number += 1) {
    const candidate = preferred ? `${preferred} (${number})` : `${harness.displayName} ${number}`;
    if (!used(candidate)) return candidate;
  }
}
