/** Signing in to the Gateway because a turn was refused as signed out (401/403 from its API).
 *
 * The same outcome a vendor's refusal gets (vendor-turn.ts signInForTurn): sign in once, on the
 * screen the user is at, and run the turn again. The Gateway's sign-in is its own device flow
 * (commands/gateway.ts gatewayLogin): a link to open, then a poll until the browser finishes.
 * A terminal shows the link on its sign-in screen; a worker, which has no screen, shows it as a
 * line every window following the turn draws. With no one watching, nothing is asked and the
 * refusal stands. */
import type Conf from 'conf';
import { gatewayLogin } from '../commands/gateway.js';
import { withSignIn } from '../commands/account.js';
import { turnCancelledError } from '../agent/cancellation.js';
import type { SignInScreen } from './login/vendor-sign-in.js';
import type { TurnObserver } from '../turn/observer.js';
import { GATEWAY_LABEL } from '../session/route.js';

type Login = typeof gatewayLogin;

/** True when the Gateway is signed in afterwards; false when there was no one to ask or the
 * sign-in did not finish (what went wrong has been said on the prompter). */
export async function signInGatewayForTurn(
  config: Conf, prompter: TurnObserver | undefined, signal?: AbortSignal, login: Login = gatewayLogin,
): Promise<boolean> {
  if (!prompter) return false;
  const screenOf = (prompter as { signInScreen?: (name: string) => SignInScreen }).signInScreen;
  let screen: SignInScreen | undefined;
  const sleep = (ms: number): Promise<void> => new Promise((resolve, reject) => {
    const stop = screen?.signal ?? signal;
    if (stop?.aborted || signal?.aborted) { reject(turnCancelledError()); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(turnCancelledError()); };
    stop?.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const run = async (): Promise<void> => {
    const choice = screen ? await screen.choose(`Sign in to ${GATEWAY_LABEL}`, ['Continue with Google', 'Continue with GitHub'], 0) : 0;
    if (choice === undefined) throw turnCancelledError();
    await login(config, { embedded: true, google: choice === 0, github: choice === 1 }, {
      log: () => undefined,
      sleep,
      // The link goes where the user is: their sign-in screen, else the turn's own rows.
      openBrowser: (url) => {
        if (screen) screen.show({ url });
        else prompter.activity(`Sign in to ${GATEWAY_LABEL}: ${url}`);
      },
    });
  };
  try {
    if (screenOf) {
      await withSignIn({
        signInScreen: (name: string) => { screen = screenOf.call(prompter, name); return screen; },
        activity: (message: string) => prompter.activity(message),
      }, GATEWAY_LABEL, run);
    } else {
      await run();
      prompter.activity(`signed in to ${GATEWAY_LABEL}`);
    }
    return true;
  } catch (error) {
    if (signal?.aborted) throw turnCancelledError();
    if (!screenOf) prompter.activity(`sign-in to ${GATEWAY_LABEL} did not finish: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
