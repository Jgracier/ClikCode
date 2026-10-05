/** A vendor's sign-in, run on ClikCode's own screen (gateway/login/
 * vendor-sign-in.ts): whichever screen the caller set up with
 * withSignInScreen -- the CLI's, the VS Code panel's -- or, with none, plain
 * stdin/stdout (`clikcode accounts login` from a shell). */

import { lifecycle } from '../../../runtime/lifecycle-log.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline/promises';
import { runVendorSignIn, type SignInScreen, type SignInUi } from '../../../gateway/login/vendor-sign-in.js';
import { hasLocalDisplay, loginUrlNotice, openLoginUrl } from '../../../gateway/login/url.js';
import { NativeHarnessSpec } from './binary.js';
import { captureNativeHarnessOutput } from './command.js';
import { ensureNativeHarness } from './inspect.js';
import { authFilePresent, authFilesStamp } from '../../accounts/auth-files.js';

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
  lifecycle('signin.start', { harness: spec.command });
  try {
    await loginNativeHarnessInner(spec, envOverrides);
    lifecycle('signin.end', { harness: spec.command, outcome: 'signed in' });
  } catch (error) {
    lifecycle('signin.end', { harness: spec.command, outcome: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    throw error;
  }
}

async function loginNativeHarnessInner(spec: NativeHarnessSpec, envOverrides: Readonly<Record<string, string>>): Promise<void> {
  await ensureNativeHarness(spec);
  const own = screens.getStore();
  const screen = own ?? plainSignInScreen(spec.displayName);
  const local = hasLocalDisplay();
  try {
    if (spec.loginKeyCommand) { await signInWithKey(spec, spec.loginKeyCommand, envOverrides, screen); return; }
    // Over once the vendor writes its credential: several go on into their
    // own app afterwards (Droid, Vibe), and only the file says it worked.
    const before = spec.authFiles?.length ? await authFilesStamp(spec, envOverrides) : undefined;
    await runVendorSignIn({
      ...(before !== undefined ? { signedIn: async () => (await authFilesStamp(spec, envOverrides)) !== before && authFilePresent(spec, envOverrides) } : {}),
      binary: spec.binary,
      args: !local && spec.loginRemoteArgv ? spec.loginRemoteArgv : spec.loginArgv ?? [],
      env: envOverrides, displayName: spec.displayName, local,
      ...(spec.loginSteps ? { steps: spec.loginSteps } : {}),
      ui: spec.loginKeyRoutes ? await keyRoutedScreen(spec, spec.loginKeyRoutes, screen) : screen,
    });
  } finally { if (!own) screen.stop(); }
}

/** A key stored by the vendor's own commands (loginKeyCommand): its
 * providers listed, one chosen and its key asked on ClikCode's screen, the
 * key piped in -- never an argument, so never in a process list. */
async function signInWithKey(
  spec: NativeHarnessSpec, command: NonNullable<NativeHarnessSpec['loginKeyCommand']>,
  env: Readonly<Record<string, string>>, screen: SignInScreen,
): Promise<void> {
  const cancelled = (): Error => new Error(`sign-in to ${spec.displayName} was cancelled`);
  const listed = await captureNativeHarnessOutput(spec, command.providersArgv, env);
  const providers = [...new Set(listed.split('\n').map((line) => line.trim().split(/\s+/)[0] ?? '').filter((word) => /^[a-z][\w.-]*$/i.test(word)))];
  if (!providers.length) throw new Error(`${spec.displayName} listed no providers to sign in to`);
  const index = await screen.choose(`Sign in to ${spec.displayName} with`, providers);
  if (index === undefined || screen.signal.aborted) throw cancelled();
  const key = (await screen.ask(`${providers[index]} API key`, true)).trim();
  if (!key || screen.signal.aborted) throw cancelled();
  const argv = command.setArgv.map((part) => part.replace('{provider}', providers[index]!));
  await captureNativeHarnessOutput(spec, argv, env, 30_000, undefined, `${key}\n`);
}

/** The key asked first, alone; then the vendor's menus answered from the
 * route that accepts it (catalog loginKeyRoutes). A menu the route does not
 * name, or any other screen, still goes to the user. */
export async function keyRoutedScreen(
  spec: NativeHarnessSpec, routes: NonNullable<NativeHarnessSpec['loginKeyRoutes']>, screen: SignInScreen,
): Promise<SignInUi> {
  const key = (await screen.ask(`${spec.displayName} API key`, true)).trim();
  if (!key || screen.signal.aborted) throw new Error(`sign-in to ${spec.displayName} was cancelled`);
  const accepted = await Promise.all(routes.map((route) => acceptsKey(route.url, key, screen.signal)));
  const route = routes[accepted.indexOf(true)];
  if (!route) throw new Error(`no ${spec.displayName} endpoint accepts that key -- check it was copied whole`);
  const labels = [...route.choose];
  let keyGiven = false;
  return {
    signal: screen.signal,
    show: (link) => screen.show(link),
    choose: async (title, choices) => {
      const at = labels.length ? choices.findIndex((choice) => choice.toLowerCase().includes(labels[0]!.toLowerCase())) : -1;
      if (at < 0) return screen.choose(title, choices);
      labels.shift();
      return at;
    },
    ask: async (prompt, secret) => {
      if (secret && !keyGiven) { keyGiven = true; return key; }
      return screen.ask(prompt, secret);
    },
  };
}

/** Whether `url` takes `key`: a request with no messages is refused either
 * for the key (401/403) or for being empty -- the key's answer, no model run. */
async function acceptsKey(url: string, key: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'probe', messages: [] }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    await response.body?.cancel();
    return response.status !== 401 && response.status !== 403;
  } catch {
    return false;
  }
}

