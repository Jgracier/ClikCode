/** A wall is what a driver or an agent saw and named, mapped to the step a person takes. Never a reading of words in a page or task. */
import { paymentWall } from './keygrab.js';
import type { HumanStep, StopInfo } from './connector-types.js';

/** A wall only a person clears, from where the browser stopped; undefined when it is just a screen the runner does not know. */
export function humanStepFor(id: string, stop: StopInfo): HumanStep | undefined {
  const url = cleanUrl(stop.url);
  // A wall is what a driver or an agent saw and named (`stop.kind`), never words found in the text of the stop. That text can be the task's own
  // prompt or a marketing page: a vendor whose home page said "captcha" was parked for an hour on one, with nothing tried.
  const at = url ? { url } : {};
  if (stop.kind === 'captcha') return { kind: 'captcha', ...at, reasonCode: 'captcha', instructions: `Solve the captcha at ${hostOf(url)} for ${id}, then the runner can carry on.` };
  if (stop.kind === 'mfa') return { kind: 'mfa', ...at, reasonCode: 'verification-code', instructions: `Enter the verification code (SMS or authenticator) at ${hostOf(url)} for ${id}.` };
  if (stop.kind === 'payment') return { kind: 'payment', ...at, reasonCode: paymentWall(`${stop.message} ${stop.pageText}`), instructions: `${hostOf(url)} wants a card, credits or a paid plan before ${id} can continue; nothing was paid.` };
  if (stop.kind === 'unrecognized-client') return { kind: 'app-registration', ...at, reasonCode: 'oauth-client-unknown', instructions: `${hostOf(url)} does not recognize ClikDeploy's OAuth client for ${id}: register the app there and save its client id and secret.` };
  if (stop.kind === 'password') return { kind: 'worker-setup', ...at, reasonCode: 'sign-in-needed', instructions: `The ClikCode browser is signed out at ${hostOf(url)}: sign in once (Google), then run the connectors again.` };
  return undefined;
}

export const hostOf = (url: string | undefined): string => { try { return new URL(url ?? '').host; } catch { return 'the vendor'; } };
function cleanUrl(url: string | undefined): string | undefined {
  try { const u = new URL(url ?? ''); return u.protocol === 'https:' ? `${u.origin}${u.pathname}` : undefined; } catch { return undefined; }
}

