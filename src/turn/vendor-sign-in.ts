/** Signing in to the account a vendor turn runs on. */
import chalk from 'chalk';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { signInOutcomeSaid, syncAccountIdentityAfterLogin, withSignIn } from '../commands/account.js';
import { SignInEnded } from './observer.js';
import { harnessLoginArgvForModel, modelProvider } from '../runtime/lazy-bridge.js';
import { leavePersistentTransport } from './vendor-process.js';
import type { VendorTurnContext } from './vendor-turn-context.js';

/** Sign in to the account this turn runs on, once per turn: true when it
 * worked and the account is ready. */
export async function signInForTurn(ctx: VendorTurnContext, environment: Readonly<Record<string, string>>): Promise<boolean> {
  const { harness, session, prompter, state, model } = ctx;
  // A multi-provider harness signs in to the provider the model runs on
  // (`hermes auth add opencode-free`), not the whole harness.
  const signInArgv = harnessLoginArgvForModel(harness, model);
  // With no one watching, the sign-in is the plain terminal's (login.ts
  // plainSignInScreen: the link printed, questions read from stdin) -- the
  // console with no alternate screen, a send from a shell. Only with a
  // person at that terminal: a piped send fails as not signed in.
  if (!signInArgv || (!prompter && !process.stdin.isTTY)) return false;
  ctx.attempt.authRetried = true;
  await leavePersistentTransport(session.id);
  const signIn = { ...harness, loginArgv: signInArgv };
  const signInName = signInArgv === harness.loginArgv ? harness.displayName : `${harness.displayName} › ${model ? modelProvider(harness, model) : ''}`;
  // A worker has no terminal: its client runs the sign-in and says when it
  // is done. Without that the vendor's login ran here, in a detached
  // process, and could never finish.
  const signedIn = await (prompter?.signIn
    ? prompter.signIn({ command: harness.command, argv: signInArgv, environment, name: signInName }, ctx.signal)
    : withSignIn(prompter, signInName, () => loginNativeHarness(signIn, environment)))
    .then(() => true, (error: unknown) => {
      // Said already where it ran (withSignIn's line, the window's), or
      // nothing was attempted (a script, a worker with no window): the
      // turn's own error says the account is not signed in, once.
      if (error instanceof SignInEnded || signInOutcomeSaid(error)) return false;
      prompter?.activity(chalk.yellow(`sign-in to ${signInName} did not finish: ${error instanceof Error ? error.message : String(error)}`));
      return false;
    });
  if (!signedIn) return false;
  ctx.account = await syncAccountIdentityAfterLogin(harness, ctx.account, state);
  await ctx.accounts.recordAccount(ctx.account);
  return true;
}
