/** The sign-in Goose or OpenClaw borrows when its model is another agent's CLI.
 *
 * `claude-code/opus` on Goose is Goose running the `claude` program, signed in
 * however that program finds itself signed in -- which, left alone, is its
 * default profile in the home directory. ClikCode keeps each account in a
 * profile of its own, so that default is usually signed out while two Claude
 * accounts sit ready beside it: Goose's first model answered "Not logged in".
 * The driven CLI is pointed at one of those accounts instead. */

import { GOOSE_DRIVEN_HARNESSES } from '../harness/accounts/goose-discovery.js';
import { nativeProfileEnvironment } from '../harness/transport/profile-environment.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';

/** Model provider -> the ClikCode harness whose CLI answers for it. OpenClaw
 * runs `anthropic/*` through the `claude` program whenever it holds no
 * Anthropic sign-in of its own (`openclaw models status`: "anthropic via
 * claude-cli"); when it does hold one, the borrowed profile goes unused. */
const DRIVEN_BY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  goose: GOOSE_DRIVEN_HARNESSES,
  openclaw: { anthropic: 'claude', 'claude-cli': 'claude' },
};

type DrivenHarness = Pick<AiLocalHarnessDefinition, 'provider' | 'profileEnv'>;

/** The environment that signs the driven CLI in as one of the user's own
 * accounts, or nothing: for a model Goose serves itself, when the CLI's
 * default profile is itself an account (it is used as it always was), and for
 * a CLI whose profile is the home directory -- that would move Goose's too. */
export function gooseDrivenEnvironment(
  harness: Pick<AiLocalHarnessDefinition, 'command'>, model: string | null | undefined,
  accounts: readonly AiHarnessAccount[], drivenHarness: (command: string) => DrivenHarness | undefined,
): Record<string, string> {
  const drives = DRIVEN_BY[harness.command];
  if (!drives || !model?.includes('/')) return {};
  const command = drives[model.slice(0, model.indexOf('/'))];
  const driven = command ? drivenHarness(command) : undefined;
  if (!driven?.profileEnv || driven.profileEnv === 'HOME') return {};
  const signedIn = accounts.filter((account) => account.provider === driven.provider && account.authKind === 'vendor-cli'
    && account.status === 'ready' && !account.verification);
  if (!signedIn.length || signedIn.some((account) => !account.nativeProfile)) return {};
  const account = signedIn.find((candidate) => candidate.quotaState !== 'exhausted') ?? signedIn[0]!;
  return account.nativeProfile?.env === driven.profileEnv ? nativeProfileEnvironment(account.nativeProfile) : {};
}
