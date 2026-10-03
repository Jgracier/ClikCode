/** A vendor's sign-in, run on ClikCode's own screen (gateway/login/
 * vendor-sign-in.ts): whichever screen the caller set up with
 * withSignInScreen -- the CLI's, the VS Code panel's -- or, with none, plain
 * stdin/stdout (`clikcode accounts login` from a shell). */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline/promises';
import { runVendorSignIn, type SignInScreen } from '../../../gateway/login/vendor-sign-in.js';
import { hasLocalDisplay, loginUrlNotice, openLoginUrl } from '../../../gateway/login/url.js';
import { NativeHarnessSpec } from './binary.js';
import { ensureNativeHarness } from './inspect.js';

const screens = new AsyncLocalStorage<SignInScreen>();

/** Run `work` with its sign-ins shown on `screen`. */
export function withSignInScreen<T>(screen: SignInScreen, work: () => Promise<T>): Promise<T> {
  return screens.run(screen, work);
}

/** No screen of ClikCode's: the link printed (copied where no browser is
 * local, opened where one is), questions read from stdin. */
export function plainSignInScreen(name: string): SignInScreen {
  let opened = false;
  const controller = new AbortController();
  const line = async (prompt: string): Promise<string> => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try { return await reader.question(prompt); } finally { reader.close(); }
  };
  return {
    signal: controller.signal,
    show: (link) => {
      const local = hasLocalDisplay();
      if (local && !opened) { opened = true; openLoginUrl(link.url); }
      process.stdout.write(`${local ? '' : loginUrlNotice(link.url).clipboard}Sign in to ${name}: ${link.url}\n${link.code ? `Code: ${link.code}\n` : ''}`);
    },
    ask: (prompt) => line(`${prompt}: `),
    choose: async (title, choices) => {
      process.stdout.write(`${title}\n${choices.map((choice, index) => `  ${index + 1}. ${choice}`).join('\n')}\n`);
      const picked = Number.parseInt(await line('Number: '), 10);
      return picked >= 1 && picked <= choices.length ? picked - 1 : undefined;
    },
    stop: () => undefined,
  };
}

/** Sign in to a harness through its own login, on ClikCode's screen. */
export async function loginNativeHarness(spec: NativeHarnessSpec, envOverrides: Readonly<Record<string, string>> = {}): Promise<void> {
  await ensureNativeHarness(spec);
  const own = screens.getStore();
  const screen = own ?? plainSignInScreen(spec.displayName);
  const local = hasLocalDisplay();
  try {
    await runVendorSignIn({
      binary: spec.binary,
      args: !local && spec.loginRemoteArgv ? spec.loginRemoteArgv : spec.loginArgv ?? [],
      env: envOverrides, displayName: spec.displayName, local,
      ...(spec.loginSteps ? { steps: spec.loginSteps } : {}),
      ui: screen,
    });
  } finally { if (!own) screen.stop(); }
}
