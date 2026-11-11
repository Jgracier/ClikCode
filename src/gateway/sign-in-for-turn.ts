/** Signing in to the Gateway because a turn was refused as signed out (401/403 from its API).
 *
 * The same outcome a vendor's refusal gets (turn/vendor-sign-in.ts signInForTurn): sign in once,
 * on the screen the user is at, and run the turn again. The Gateway's sign-in is its own device
 * flow (commands/gateway.ts gatewayLogin): a link to open, then a poll until the browser
 * finishes. A terminal or the editor runs it on its sign-in screen; a worker, which has none,
 * asks one window showing the conversation to run it (TurnObserver.signIn), as it does a
 * vendor's. With no one watching, nothing is asked and the refusal stands. */
import Conf from 'conf';
import { gatewayLogin } from '../commands/gateway.js';
import { withSignIn } from '../commands/account.js';
import { turnCancelledError } from '../agent/cancellation.js';
import { SignInCancelled, type SignInScreen } from './login/vendor-sign-in.js';
import { SignInEnded, type TurnObserver } from '../turn/observer.js';
import { GATEWAY_LABEL } from '../session/route.js';
import { sleep as sleepFor } from '../runtime/sleep.js';

type Login = typeof gatewayLogin;

/** The Gateway's device sign-in on `screen`: Google or GitHub, then its link,
 * polled until the browser finishes. Without a screen, Google, and the link
 * goes to `show`. */
export async function gatewaySignIn(
  config: Conf, screen: SignInScreen | undefined, show: (line: string) => void, signal?: AbortSignal, login: Login = gatewayLogin,
): Promise<void> {
  const stops = [screen?.signal, signal].filter((stop): stop is AbortSignal => stop !== undefined);
  const sleep = (ms: number): Promise<void> => sleepFor(ms, stops.length ? AbortSignal.any(stops) : undefined, turnCancelledError);
  const choice = screen ? await screen.choose(`Sign in to ${GATEWAY_LABEL}`, ['Continue with Google', 'Continue with GitHub'], 0) : 0;
  if (choice === undefined) throw new SignInCancelled(GATEWAY_LABEL);
  await login(config, { google: choice === 0, github: choice === 1 }, {
    log: () => undefined,
    sleep,
    openBrowser: (url) => {
      if (screen) screen.show({ url });
      else show(`Sign in to ${GATEWAY_LABEL}: ${url}`);
    },
  });
}

/** A window running the Gateway's sign-in its worker asked for (worker/window-sign-in.ts). */
export function gatewaySignInHere(screen: SignInScreen | undefined): Promise<void> {
  return gatewaySignIn(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }), screen, () => undefined);
}

/** True when the Gateway is signed in afterwards; false when there was no one to ask or the
 * sign-in did not finish (what went wrong has been said where it ran). */
export async function signInGatewayForTurn(
  config: Conf, prompter: TurnObserver | undefined, signal?: AbortSignal, login: Login = gatewayLogin,
): Promise<boolean> {
  if (!prompter) return false;
  const screenOf = (prompter as { signInScreen?: (name: string) => SignInScreen }).signInScreen;
  let screen: SignInScreen | undefined;
  try {
    if (prompter.signIn) {
      await prompter.signIn({ kind: 'gateway', name: GATEWAY_LABEL }, signal);
    } else if (screenOf) {
      await withSignIn({
        signInScreen: (name: string) => { screen = screenOf.call(prompter, name); return screen; },
        activity: (message: string) => prompter.activity(message),
      }, GATEWAY_LABEL, () => gatewaySignIn(config, screen, (line) => prompter.activity(line), signal, login));
    } else {
      await gatewaySignIn(config, undefined, (line) => prompter.activity(line), signal, login);
    }
    return true;
  } catch (error) {
    if (signal?.aborted) throw turnCancelledError();
    if (!screenOf && !(error instanceof SignInEnded)) prompter.activity(`sign-in to ${GATEWAY_LABEL} did not finish: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
