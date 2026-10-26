/** HTTP Basic/Digest sign-in ("401, WWW-Authenticate") for a tab. The page is already open in a shared Chrome, so
 * Playwright's httpCredentials (a context option) cannot be set; the same thing is done over CDP: Fetch.authRequired
 * is answered with the credentials of the saved login for that origin. The credentials come from the encrypted login
 * vault (or one private prompt to the user), are used only for that origin and are never put in a result. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { CDPSession, Page } from 'playwright-core';
import { savedLoginFields, savedLoginsForSite, saveLoginFields } from './credential-vault.js';
import type { LoginField } from './login-fields.js';
import { registerSecret } from './secret-scrubber.js';
import { sharedState } from './shared-state.js';

export type HttpCredentials = { username: string; password: string };
type Active = { origin: string; session: CDPSession; attempts: Map<string, number> };
const active = sharedState('page-http-auth', () => new WeakMap<Page, Active>());

type AuthRequired = { requestId: string; request: { url: string }; authChallenge: { source?: string; origin: string; scheme: string; realm: string } };
type Paused = { requestId: string };

/** Answers the origin's authentication challenges for this tab. Replaces an earlier setting for the tab. */
export async function enableHttpAuth(page: Page, origin: string, credentials: HttpCredentials): Promise<void> {
  await disableHttpAuth(page);
  registerSecret(credentials.password);
  const session = await page.context().newCDPSession(page);
  const state: Active = { origin, session, attempts: new Map() };
  active.set(page, state);
  session.on('Fetch.requestPaused', (event: Paused) => { void session.send('Fetch.continueRequest', { requestId: event.requestId }).catch(quiet('agent/computer/http-auth')); });
  session.on('Fetch.authRequired', (event: AuthRequired) => {
    const tries = (state.attempts.get(event.requestId) ?? 0) + 1;
    state.attempts.set(event.requestId, tries);
    let sameOrigin = false;
    try { sameOrigin = new URL(event.request.url).origin === origin; } catch { /* not a URL */ }
    // Only the origin the agent named, only from the site itself (never a proxy), and once per request: a refused
    // password is not sent again in a loop.
    const provide = sameOrigin && event.authChallenge.source !== 'Proxy' && tries === 1;
    void session.send('Fetch.continueWithAuth', { requestId: event.requestId, authChallengeResponse: provide ? { response: 'ProvideCredentials', username: credentials.username, password: credentials.password } : { response: 'CancelAuth' } }).catch(quiet('agent/computer/http-auth'));
  });
  await session.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: `${origin}/*`, requestStage: 'Request' }] });
  page.once('close', () => { active.delete(page); });
}

export async function disableHttpAuth(page: Page): Promise<boolean> {
  const state = active.get(page);
  if (!state) return false;
  active.delete(page);
  await state.session.send('Fetch.disable').catch(quiet('agent/computer/http-auth'));
  await state.session.detach().catch(quiet('agent/computer/http-auth'));
  return true;
}

export const httpAuthOrigin = (page: Page): string | undefined => active.get(page)?.origin;

/** The credentials to use for an https origin: the saved login (the one whose username or email is `label`, else the first the site did not refuse), or what the user types into one private prompt (then saved for next time). Undefined when there is none and no way to ask. */
export async function httpCredentialsFor(stateDir: string, url: string, options: { label?: string; ask?: (site: string, fields: readonly LoginField[]) => Promise<Record<string, string> | undefined> } = {}): Promise<HttpCredentials | undefined> {
  const logins = (await savedLoginsForSite(stateDir, url)).filter(login => !login.rejected);
  const wanted = options.label?.trim().toLowerCase();
  const chosen = wanted ? logins.find(login => login.label.toLowerCase().split(' · ').includes(wanted) || login.label.toLowerCase() === wanted) : logins[0];
  if (chosen) {
    const fields = await savedLoginFields(stateDir, url, chosen.id);
    const username = fields.username ?? fields.email ?? fields.user;
    const password = fields.password;
    if (username && password) return { username, password };
  }
  if (!options.ask) return undefined;
  const origin = new URL(url).origin;
  const answers = await options.ask(origin, [
    { index: 0, key: 'username', label: 'Username for the site\'s HTTP sign-in', kind: 'text', required: true },
    { index: 1, key: 'password', label: 'Password', kind: 'password', required: true },
  ]);
  const username = answers?.username?.trim();
  const password = answers?.password;
  if (!username || !password) return undefined;
  await saveLoginFields(stateDir, url, { username, password }).catch(quiet('agent/computer/http-auth'));
  return { username, password };
}
