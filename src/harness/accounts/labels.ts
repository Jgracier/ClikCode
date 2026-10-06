/** What an account is called: the email its sign-in reveals, read once, when
 * it signs in. Nothing renames an account afterwards -- opening a list of
 * accounts never does. A harness that reveals no email keeps a numbered
 * placeholder ("Kiro CLI 1") or the name the user gave. */

import { vendorAccountEmail } from './vendor-identity.js';
import { apiKeyAccountEmail } from './api-key-identity.js';
import { readProfileKey } from './profile-key.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';

/** The email (or, for Copilot, the GitHub login) the harness itself reports
 * for the account in `profilePath`, read right after its sign-in. Undefined
 * -- never a fabricated name -- for a harness that keeps none; the numbered
 * placeholder below covers those. See vendor-identity.ts for each source. */
export async function deriveAccountLabel(harness: AiLocalHarnessDefinition, profilePath: string | undefined): Promise<string | undefined> {
  // A key pasted at sign-in: the email behind it, where its vendor says.
  const [saved] = Object.entries(readProfileKey(profilePath));
  if (saved) return apiKeyAccountEmail({ provider: harness.provider, envName: saved[0], key: saved[1], harness });
  return vendorAccountEmail(harness, profilePath);
}

/** Find the same signed-in vendor identity even when an older account still
 * has a placeholder or a user-supplied label. An API key is a separate
 * credential and must never be replaced by a vendor login. */
export async function matchingVendorAccount(
  accounts: readonly AiHarnessAccount[], harness: AiLocalHarnessDefinition, identity: string, exceptId?: string,
): Promise<AiHarnessAccount | undefined> {
  const candidates = accounts.filter((account) => account.id !== exceptId
    && account.provider === harness.provider && account.authKind === 'vendor-cli');
  const wanted = identity.toLowerCase();
  // Verify plausible matches first; the label is only an ordering hint, not
  // proof, because it may have been supplied by the user before sign-in.
  candidates.sort((left, right) => Number(right.label.toLowerCase() === wanted) - Number(left.label.toLowerCase() === wanted));
  for (const account of candidates) {
    // A label can be user-supplied or stale after a login in the vendor CLI.
    // The credential's current identity, not its label, proves equality.
    const actual = await deriveAccountLabel(harness, account.nativeProfile?.path);
    if (actual?.toLowerCase() === wanted) return account;
  }
  return undefined;
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
