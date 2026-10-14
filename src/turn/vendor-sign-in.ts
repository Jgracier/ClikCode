/** Signing in to the account a vendor turn runs on. */
import chalk from 'chalk';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { syncAccountIdentityAfterLogin, withSignIn } from '../commands/account.js';
import { harnessLoginArgvForModel, modelProvider } from '../runtime/lazy-bridge.js';
import { closePersistentTransport } from './vendor-process.js';
import type { VendorTurnContext } from './vendor-turn-context.js';

/** A sign-in that was refused up front because nobody can do it here: a
 * script or pipe answers the worker's sign-in request with "X is not signed
 * in; run ... in a terminal" (worker/scripted-send.ts), and a worker with no
 * window attached says "sign in to X needs an open ClikCode window". */
export function signInNotPossibleHere(error: unknown): boolean {
  return error instanceof Error && /is not signed in; run |needs an open ClikCode window/.test(error.message);
}

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
  await closePersistentTransport(session.id);
  const signIn = { ...harness, loginArgv: signInArgv };
  const signInName = signInArgv === harness.loginArgv ? harness.displayName : `${harness.displayName} › ${model ? modelProvider(harness, model) : ''}`;
  // A worker has no terminal: its client runs the sign-in and says when it
  // is done. Without that the vendor's login ran here, in a detached
  // process, and could never finish.
  const signedIn = await (prompter?.signIn
    ? prompter.signIn({ command: harness.command, argv: signInArgv, environment, name: signInName }, ctx.signal)
    : withSignIn(prompter, signInName, () => loginNativeHarness(signIn, environment)))
    .then(() => true, (error: unknown) => {
      // No one to sign in (a script, a worker with no window): nothing was
      // attempted, so nothing "did not finish". The turn's own error says
      // the account is not signed in, once.
      if (signInNotPossibleHere(error)) return false;
      prompter?.activity(chalk.yellow(`sign-in to ${signInName} did not finish: ${error instanceof Error ? error.message : String(error)}`));
      return false;
    });
  if (!signedIn) return false;
  ctx.account = await syncAccountIdentityAfterLogin(harness, ctx.account, state);
  await ctx.accounts.recordAccount(ctx.account);
  return true;
}
