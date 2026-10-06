/** A vendor's sign-in, run on ClikCode's own screen (gateway/login/
 * vendor-sign-in.ts): whichever screen the caller set up with
 * withSignInScreen -- the CLI's, the VS Code panel's -- or, with none, plain
 * stdin/stdout (`clikcode accounts login` from a shell). */

import { lifecycle } from '../../../runtime/lifecycle-log.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline/promises';
import { runVendorSignIn, SEARCH_CHOICE, type SignInScreen, type SignInUi } from '../../../gateway/login/vendor-sign-in.js';
import { keyProviders, localHarnessForCommand } from '../../../runtime/lazy-bridge.js';
import type { AiHarnessKeyRoute, AiKeyProvider, AiKeyProviderId } from '../../definition.js';
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
    if (spec.loginKeyCommand) {
      const found = spec.loginKeyRoutes ? await keyRoute(spec, spec.loginKeyRoutes, screen) : undefined;
      await signInWithKey(spec, spec.loginKeyCommand, envOverrides, screen, found && { provider: found.route.choose[0]!, key: found.key });
      return;
    }
    // Over once the vendor writes its credential: several go on into their
    // own app afterwards (Droid, Vibe), and only the file says it worked.
    const before = spec.authFiles?.length ? await authFilesStamp(spec, envOverrides) : undefined;
    await runVendorSignIn({
      ...(before !== undefined ? { signedIn: async () => (await authFilesStamp(spec, envOverrides)) !== before && authFilePresent(spec, envOverrides) } : {}),
      binary: spec.binary,
      args: !local && spec.loginRemoteArgv ? spec.loginRemoteArgv : spec.loginArgv ?? [],
      env: envOverrides, displayName: spec.displayName, local,
      ...(spec.loginSteps ? { steps: spec.loginSteps } : {}),
      ui: spec.loginKeyRoutes && ownLogin(spec) ? await keyRoutedScreen(spec, spec.loginKeyRoutes, screen) : screen,
    });
  } finally { if (!own) screen.stop(); }
}

/** Whether `spec` runs the harness's own sign-in, the one its key routes
 * answer -- not one for a single provider (providerLoginArgv, a model's
 * connect), whose screens are another's. */
function ownLogin(spec: NativeHarnessSpec): boolean {
  return JSON.stringify(spec.loginArgv ?? []) === JSON.stringify(localHarnessForCommand(spec.command)?.loginArgv ?? []);
}

/** A key stored by the vendor's own commands (loginKeyCommand), piped in
 * -- never an argument, so never in a process list: for the provider its
 * key routes found (`routed`), else one chosen from the providers it lists
 * and its key asked on ClikCode's screen. */
async function signInWithKey(
  spec: NativeHarnessSpec, command: NonNullable<NativeHarnessSpec['loginKeyCommand']>,
  env: Readonly<Record<string, string>>, screen: SignInScreen, routed?: { provider: string; key: string },
): Promise<void> {
  const set = (provider: string, key: string) => captureNativeHarnessOutput(spec, command.setArgv.map((part) => part.replace('{provider}', provider)), env, 30_000, undefined, `${key}\n`);
  if (routed) { await set(routed.provider, routed.key); return; }
  const cancelled = (): Error => new Error(`sign-in to ${spec.displayName} was cancelled`);
  const listed = await captureNativeHarnessOutput(spec, command.providersArgv, env);
  const providers = [...new Set(listed.split('\n').map((line) => line.trim().split(/\s+/)[0] ?? '').filter((word) => /^[a-z][\w.-]*$/i.test(word)))];
  if (!providers.length) throw new Error(`${spec.displayName} listed no providers to sign in to`);
  const index = await screen.choose(`Sign in to ${spec.displayName} with`, providers);
  if (index === undefined || screen.signal.aborted) throw cancelled();
  const key = (await screen.ask(`${providers[index]} API key`, true)).trim();
  if (!key || screen.signal.aborted) throw cancelled();
  await set(providers[index]!, key);
}

/** The key asked first, alone; then the vendor's menus answered from the
 * route that accepts it (catalog loginKeyRoutes). A menu the route does not
 * name, or any other screen, still goes to the user; so does the vendor's
 * whole sign-in when no key is given (its browser sign-ins). */
export async function keyRoutedScreen(
  spec: NativeHarnessSpec, routes: readonly AiHarnessKeyRoute[], screen: SignInScreen,
  providers: Readonly<Record<AiKeyProviderId, AiKeyProvider>> = keyProviders(),
): Promise<SignInUi> {
  const found = await keyRoute(spec, routes, screen, providers);
  if (!found) return screen;
  const { key, route } = found;
  const labels = [...route.choose];
  let searched: string | undefined;
  let keyGiven = false;
  // Once the key is in and the route has nothing more to say, the vendor's
  // own defaults: its menu's current option (a default model), a shown default.
  const defaults = (): boolean => keyGiven && !labels.length;
  return {
    signal: screen.signal,
    show: (link) => screen.show(link),
    choose: async (title, choices, selected) => {
      // `?label`: a menu the vendor may not show (OpenClaw's plugin install,
      // asked once): answered when shown, passed over when not.
      while (labels[0]?.startsWith('?') && optionFor(choices, labels[0].slice(1)) < 0) labels.shift();
      const label = labels[0]?.replace(/^\?/, '');
      const at = label === undefined ? -1 : optionFor(choices, label);
      if (at >= 0) { labels.shift(); searched = undefined; return at; }
      // Not among those shown: typed into the list's search, once -- the
      // one ClikCode offers, or the list's own (Goose's `Search all
      // providers...`).
      const search = choices.at(-1) === SEARCH_CHOICE ? choices.length - 1 : choices.findIndex(isSearch);
      if (label !== undefined && searched === undefined && search >= 0) { searched = label; return search; }
      // Its current option, unless that is a search (Goose's `Search all
      // models...`): then the first that is not.
      if (defaults() && selected !== undefined) return isSearch(choices[selected] ?? '') ? choices.findIndex((choice) => !isSearch(choice)) : selected;
      return screen.choose(title, choices, selected);
    },
    ask: async (prompt, secret, optional) => {
      if (searched !== undefined && prompt.startsWith('Search ')) return searched.replace(/\s*\(.*$/, '');
      if (secret && !keyGiven) { keyGiven = true; return key; }
      if (defaults() && /\[[^\]]+\]$/.test(prompt)) return '';
      return screen.ask(prompt, secret, optional);
    },
  };
}

function isSearch(choice: string): boolean {
  return choice === SEARCH_CHOICE || /^search\b/i.test(choice);
}

/** The key, asked first and alone, and the first route whose endpoint
 * takes it; undefined when the user gave none (Enter: the vendor's own
 * sign-in). Throws when no route takes it. */
async function keyRoute(
  spec: NativeHarnessSpec, routes: readonly AiHarnessKeyRoute[], screen: SignInScreen,
  providers: Readonly<Record<AiKeyProviderId, AiKeyProvider>> = keyProviders(),
): Promise<{ key: string; route: AiHarnessKeyRoute } | undefined> {
  const key = (await screen.ask(`${spec.displayName} API key, or Enter to choose a provider`, true, true)).trim();
  if (screen.signal.aborted) throw new Error(`sign-in to ${spec.displayName} was cancelled`);
  if (!key) return undefined;
  const candidates = keyCandidates(routes, key, providers);
  const accepted = await Promise.all(candidates.map((route) => acceptsKey(route, key, providers, screen.signal)));
  const route = candidates[accepted.indexOf(true)];
  if (!route) throw new Error(`no provider ${spec.displayName} signs in to accepts that key -- check it was copied whole`);
  return { key, route };
}

/** Which of `choices` is `label`: the option itself, else one that starts
 * with it and then a mark (Pi's `OpenAI • unconfigured`, Hermes's `OpenAI ▸
 * (...)`) -- never `MiniMax CN` for `MiniMax`; -1 for none. */
export function optionFor(choices: readonly string[], label: string): number {
  const want = label.toLowerCase();
  const lower = choices.map((choice) => choice.toLowerCase());
  const exact = lower.indexOf(want);
  return exact >= 0 ? exact : lower.findIndex((choice) => choice.startsWith(want) && /^\s+[^\p{L}\p{N}\s]/u.test(choice.slice(want.length)));
}

/** The routes `key` may be sent to: a provider's only when it could have
 * issued that key (KEY_PROVIDERS prefixes); the vendor's own endpoints always. */
export function keyCandidates(
  routes: readonly AiHarnessKeyRoute[], key: string, providers: Readonly<Record<AiKeyProviderId, AiKeyProvider>>,
): AiHarnessKeyRoute[] {
  const issues = (provider: AiKeyProvider): boolean => Boolean(provider.prefixes?.some((prefix) => key.startsWith(prefix)));
  const claimed = Object.values(providers).some(issues);
  return routes.filter((route) => {
    if (!('provider' in route)) return true;
    const provider = providers[route.provider];
    return claimed ? issues(provider) : !provider.prefixes || Boolean(provider.unprefixed);
  });
}

/** Whether a route's endpoint takes `key`, with no model run: a provider's
 * probe answers 2xx; the vendor's own chat endpoint, sent no messages, is
 * refused either for the key (401/403) or for being empty. */
async function acceptsKey(
  route: AiHarnessKeyRoute, key: string, providers: Readonly<Record<AiKeyProviderId, AiKeyProvider>>, signal: AbortSignal,
): Promise<boolean> {
  const provider = 'provider' in route ? providers[route.provider] : undefined;
  const auth = provider?.header ? { [provider.header]: key } : { authorization: `Bearer ${key}` };
  try {
    const response = provider
      ? await fetch(provider.probe, { headers: { ...auth, ...provider.headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
      : await fetch((route as { url: string }).url, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'probe', messages: [] }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
    await response.body?.cancel();
    return provider ? response.ok : response.status !== 401 && response.status !== 403;
  } catch {
    return false;
  }
}
