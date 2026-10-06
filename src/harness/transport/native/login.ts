/** A vendor's sign-in, run on ClikCode's own screen (gateway/login/
 * vendor-sign-in.ts): whichever screen the caller set up with
 * withSignInScreen -- the CLI's, the VS Code panel's -- or, with none, plain
 * stdin/stdout (`clikcode accounts login` from a shell). */

import { lifecycle } from '../../../runtime/lifecycle-log.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline/promises';
import { runVendorSignIn, SEARCH_CHOICE, type SignInScreen, type SignInUi } from '../../../gateway/login/vendor-sign-in.js';
import { keyProviders, localHarnessForCommand } from '../../../runtime/lazy-bridge.js';
import type { AiHarnessKeyRoute, AiKeyProvider, AiKeyProviderId, AiLocalHarnessDefinition } from '../../definition.js';
import { hasLocalDisplay, loginUrlNotice, openLoginUrl } from '../../../gateway/login/url.js';
import { NativeHarnessSpec } from './binary.js';
import { captureNativeHarnessOutput } from './command.js';
import { ensureNativeHarness } from './inspect.js';
import { authFilePresent, authFilesStamp, expandAuthPath } from '../../accounts/auth-files.js';
import { keyVariables, writeProfileKey } from '../../accounts/profile-key.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
      const key = spec.loginKeyRoutes ? await askKey(spec, screen) : '';
      const route = key ? await routeFor(spec, spec.loginKeyRoutes!, key, screen.signal) : undefined;
      await signInWithKey(spec, spec.loginKeyCommand, envOverrides, screen, route && { provider: route.choose[0]!, key });
      return;
    }
    // Over once the vendor writes its credential: several go on into their
    // own app afterwards (Droid, Vibe), and only the file says it worked.
    const before = spec.authFiles?.length ? await authFilesStamp(spec, envOverrides) : undefined;
    const run = (ui: SignInUi) => runVendorSignIn({
      ...(before !== undefined ? { signedIn: async () => (await authFilesStamp(spec, envOverrides)) !== before && authFilePresent(spec, envOverrides) } : {}),
      binary: spec.binary,
      args: !local && spec.loginRemoteArgv ? spec.loginRemoteArgv : spec.loginArgv ?? [],
      env: envOverrides, displayName: spec.displayName, local,
      ...(spec.loginSteps ? { steps: spec.loginSteps } : {}),
      ui,
    });
    const harness = localHarnessForCommand(spec.command);
    if (!harness || !ownLogin(spec)) { await run(screen); return; }
    const routes = spec.loginKeyRoutes;
    if (routes) {
      // The vendor's own account sign-in at once, a key pasted under its link
      // (or Enter, for its other options) taking over; else the key first.
      const instead = spec.loginAccountChoose
        ? await accountFirst(spec.displayName, spec.loginAccountChoose, screen, run, {
          prompt: `Or paste your ${spec.displayName} API key · Enter for other sign-ins`, others: true,
          isKey: async (text) => keyCandidates(routes, text, keyProviders()).length > 0 && Boolean(await routeFor(spec, routes, text, screen.signal).catch(() => undefined)),
        })
        : { key: undefined };
      if (instead) await run(await keyRoutedScreen(spec, routes, screen, keyProviders(), instead.key));
      return;
    }
    // A vendor that reads its key only from a variable: its own sign-in, with
    // a key pasted instead saved where it runs (storeKey).
    if (!harness.localAuth.includes('api-key') || spec.loginKeyCommand || !keyVariables(harness).length) { await run(screen); return; }
    const instead = await accountFirst(spec.displayName, spec.loginAccountChoose ?? [], screen, run, {
      prompt: `Or paste your ${spec.displayName} API key`, others: false,
      isKey: async (text) => (await keyVariableFor(harness, text, screen.signal))?.checked === true,
    });
    if (instead?.key) await storeKey(harness, spec, envOverrides, instead.key, screen.signal);
  } finally { if (!own) screen.stop(); }
}

/** What the sign-in screen offers beside the vendor's own sign-in. */
export interface KeyOffer {
  prompt: string;
  /** Enter alone is an answer: the vendor's other sign-ins. */
  others: boolean;
  /** Whether text answered to a question of the vendor's own (a pasted
   * code) is instead a key, proven by its endpoint. */
  isKey(text: string): Promise<boolean>;
}

/** The vendor's own sign-in (Cline's account, Claude's OAuth), its menus
 * answered with `labels` so its link shows straight away -- opened in a
 * local browser, shown for a phone -- with a key field open from the start.
 * A key pasted there (or Enter, where `others`) stops that run and is
 * returned ('' for Enter). Undefined: the vendor's sign-in finished (its
 * callback). A question of the vendor's own shares the field: an answer that
 * is a key (offer.isKey) is taken as one, anything else goes to the vendor;
 * the vendor's own key question (secret) replaces the field. */
export async function accountFirst(
  name: string, labels: readonly string[], screen: SignInScreen, run: (ui: SignInUi) => Promise<void>, offer: KeyOffer,
): Promise<{ key: string } | undefined> {
  const stop = new AbortController();
  const signal = AbortSignal.any([screen.signal, stop.signal]);
  const left = [...labels];
  let instead: string | undefined;
  let answered: () => void = () => undefined;
  const pasted = new Promise<void>((resolve) => { answered = resolve; });
  const take = (key: string): void => { instead = key; stop.abort(); answered(); };
  // Each ask replaces the one before on the screen; only the latest counts.
  let current = 0;
  let withdrawn = false;
  const openField = (): void => {
    const asked = ++current;
    void screen.ask(offer.prompt, true, offer.others, true).then((text) => {
      if (asked === current && !signal.aborted) take(text.trim());
    });
  };
  const ui: SignInUi = {
    signal,
    show: (link) => screen.show(link),
    choose: async (title, choices, selected) => {
      const at = left.length ? optionFor(choices, left[0]!) : -1;
      if (at >= 0) { left.shift(); return at; }
      return screen.choose(title, choices, selected);
    },
    ask: async (prompt, secret, optional) => {
      const asked = ++current;
      // A key question of the vendor's own (Continue's) is already the field,
      // and once it is answered nothing more is offered beside the vendor.
      if (secret) withdrawn = true;
      if (withdrawn) return screen.ask(prompt, secret, optional);
      const text = await screen.ask(`${prompt} · or paste your ${name} API key`, secret, optional);
      if (asked === current && text.trim() && await offer.isKey(text.trim())) { take(text.trim()); return ''; }
      if (!signal.aborted) openField();
      return text;
    },
  };
  openField();
  const finished = run(ui).then(() => true, (error: unknown) => {
    if (instead !== undefined) return false;
    throw error;
  });
  const done = await Promise.race([finished, pasted.then(() => false)]);
  if (done) { current++; return undefined; }
  await finished.catch(() => undefined);
  if (screen.signal.aborted) throw new Error(`sign-in to ${name} was cancelled`);
  return { key: instead ?? '' };
}

/** The variable a pasted key is given as: of the harness's key variables,
 * the one whose provider's endpoint accepts it (`checked`); with one
 * variable and no endpoint to ask (Amp, Cursor), that one, unchecked.
 * Undefined: no endpoint takes it. */
export async function keyVariableFor(
  harness: Pick<AiLocalHarnessDefinition, 'authEnv' | 'provider'>, key: string, signal: AbortSignal,
  providers: Readonly<Record<AiKeyProviderId, AiKeyProvider>> = keyProviders(),
): Promise<{ variable: string; checked: boolean } | undefined> {
  const variables = keyVariables(harness);
  const routes = variables.flatMap((variable) => {
    const provider = providerOfVariable(variable, providers);
    return provider ? [{ provider, choose: [variable] } as AiHarnessKeyRoute] : [];
  });
  const candidates = keyCandidates(routes, key, providers);
  const accepted = await Promise.all(candidates.map((route) => acceptsKey(route, key, providers, signal)));
  const found = candidates[accepted.indexOf(true)];
  if (found) return { variable: found.choose[0]!, checked: true };
  return variables.length === 1 && !routes.length ? { variable: variables[0]!, checked: false } : undefined;
}

/** ANTHROPIC_API_KEY -> anthropic; GEMINI_API_KEY and GOOGLE_API_KEY -> google. */
function providerOfVariable(variable: string, providers: Readonly<Record<AiKeyProviderId, AiKeyProvider>>): AiKeyProviderId | undefined {
  if (variable === 'GEMINI_API_KEY' || variable === 'GOOGLE_API_KEY') return 'google';
  return (Object.keys(providers) as AiKeyProviderId[]).find((id) => `${id.toUpperCase().replace(/-/g, '_')}_API_KEY` === variable);
}

/** A pasted key, stored: by the vendor's own command where it has one
 * (Codex's `login --with-api-key`, piped, never an argument), else saved in
 * the account's profile as its variable, plus any setting the vendor needs
 * to use it (Antigravity's apiKeySettings). */
async function storeKey(
  harness: AiLocalHarnessDefinition, spec: NativeHarnessSpec, env: Readonly<Record<string, string>>, key: string, signal: AbortSignal,
): Promise<void> {
  const found = await keyVariableFor(harness, key, signal);
  if (!found) throw new Error(`${harness.displayName} does not accept that key -- check it was copied whole`);
  if (harness.loginKeyStdinArgv) {
    await captureNativeHarnessOutput(spec, harness.loginKeyStdinArgv, env, 30_000, undefined, `${key}\n`);
    return;
  }
  const profile = harness.profileEnv ? env[harness.profileEnv] : undefined;
  if (!profile) throw new Error(`${harness.displayName} keeps a pasted key in an account of its own -- add one from /account`);
  await writeProfileKey(profile, found.variable, key);
  if (harness.apiKeySettings) {
    const path = expandAuthPath(harness.apiKeySettings.path, env);
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; } catch { /* none yet */ }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ ...settings, ...harness.apiKeySettings.set }, null, 2)}\n`, 'utf8');
  }
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

/** The key, asked first and alone (or `given`, one already pasted); then the vendor's menus answered from the
 * route that accepts it (catalog loginKeyRoutes). A menu the route does not
 * name, or any other screen, still goes to the user; so does the vendor's
 * whole sign-in when no key is given (its browser sign-ins). */
export async function keyRoutedScreen(
  spec: NativeHarnessSpec, routes: readonly AiHarnessKeyRoute[], screen: SignInScreen,
  providers: Readonly<Record<AiKeyProviderId, AiKeyProvider>> = keyProviders(),
  given?: string,
): Promise<SignInUi> {
  const key = given ?? await askKey(spec, screen);
  if (!key) return screen;
  const route = await routeFor(spec, routes, key, screen.signal, providers);
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

/** The key, asked first and alone; '' when the user gave none (Enter: the
 * vendor's own sign-in). */
async function askKey(spec: NativeHarnessSpec, screen: SignInScreen): Promise<string> {
  const key = (await screen.ask(`${spec.displayName} API key, or Enter to choose a provider`, true, true)).trim();
  if (screen.signal.aborted) throw new Error(`sign-in to ${spec.displayName} was cancelled`);
  return key;
}

/** The first route whose endpoint takes `key`. Throws when none does. */
async function routeFor(
  spec: NativeHarnessSpec, routes: readonly AiHarnessKeyRoute[], key: string, signal: AbortSignal,
  providers: Readonly<Record<AiKeyProviderId, AiKeyProvider>> = keyProviders(),
): Promise<AiHarnessKeyRoute> {
  const candidates = keyCandidates(routes, key, providers);
  const accepted = await Promise.all(candidates.map((route) => acceptsKey(route, key, providers, signal)));
  const route = candidates[accepted.indexOf(true)];
  if (!route) throw new Error(`no provider ${spec.displayName} signs in to accepts that key -- check it was copied whole`);
  return route;
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
