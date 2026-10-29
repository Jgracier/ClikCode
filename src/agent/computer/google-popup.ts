/** A "Sign in with Google" button opens Google's account chooser in a popup. The popup is followed and, when the browser is
 * already signed in to the account, completed: the account is chosen and Continue / Allow pressed, until Google hands back to
 * the page that opened it (the popup closes) or leaves Google. It never types: a password, a verification code, a captcha or
 * a screen it does not know is where it stops, with a plain reason, and the popup is left open for the agent to look at. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { Page } from 'playwright-core';
import { googleStep, nextPress, press, readControls, stopReason, type Control } from './oauth-consent.js';

const GOOGLE_HOST = /(^|\.)accounts\.google\.com$/i;
/** A click that may open a sign-in popup a moment later (the button fetches before it opens the window). */
export const SIGN_IN_CLICK = /google|sign ?in|log ?in|continue with|connect with/i;

export interface PopupOutcome {
  /** The page the chat is on after the popup: the opener once the popup closed, else the popup itself. */
  page: Page;
  /** One line for the agent, or undefined when the popup was not a Google sign-in. */
  note?: string;
}

const hostOf = (url: string): string => { try { return new URL(url).hostname; } catch { return ''; } };

/** Waits for a popup to leave about:blank, so its first address can be read. */
async function addressOf(popup: Page): Promise<string> {
  await popup.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(quiet('agent/computer/google-popup'));
  if (popup.url() === 'about:blank') await popup.waitForURL(url => url.href !== 'about:blank', { timeout: 5_000 }).catch(quiet('agent/computer/google-popup'));
  return popup.url();
}

export async function followPopup(opener: Page, popup: Page, options: { email?: string; timeoutMs?: number; signal?: AbortSignal; isGoogle?: (host: string) => boolean } = {}): Promise<PopupOutcome> {
  const isGoogle = options.isGoogle ?? ((host: string) => GOOGLE_HOST.test(host));
  if (!isGoogle(hostOf(await addressOf(popup)))) return { page: popup };
  const steps: string[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  let last = { key: '', at: 0 }, accountPresses = 0, stuck = 0;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    if (popup.isClosed()) return { page: opener, note: `A Google sign-in popup opened and was completed${steps.length ? ` (${steps.join(' ')})` : ''}; the page that opened it is current.` };
    const url = popup.url();
    if (!isGoogle(hostOf(url))) return { page: popup, note: `The Google sign-in popup handed back to ${hostOf(url) || 'the site'}${steps.length ? ` (${steps.join(' ')})` : ''}; that popup is now the page.` };
    const text = await popup.evaluate(() => ((globalThis as unknown as { document: { body?: { innerText?: string } } }).document.body?.innerText ?? '').slice(0, 6000)).catch(() => '');
    const step = googleStep(url, text);
    const hasPassword = await popup.locator('input[type=password]:visible').count().catch(() => 0) > 0;
    const why = step === 'challenge' || step === 'error' ? `Google ${step === 'challenge' ? 're-verification' : 'error page'}` : stopReason(text, hasPassword, await popup.locator('input[autocomplete=one-time-code]:visible').count().catch(() => 0) > 0);
    if (why) return { page: popup, note: `The Google sign-in popup is open and stopped at ${why}. Nothing was typed. It is the current page: sign in to Google first with login, or finish the step yourself.` };
    const controls: Control[] = await readControls(popup).catch(() => []);
    const next = nextPress(hostOf(url), controls, text, { ...(options.email ? { email: options.email } : {}), account: step === undefined || step === 'chooser' });
    const control = next && controls[next.index];
    if (next && control && next.phase !== 'sign-in' && !(last.key === `${url}|${control.name}` && Date.now() - last.at < 2_500)) {
      if (next.phase === 'account' && ++accountPresses > 2) return { page: popup, note: 'The Google account chooser keeps coming back after the account was chosen: the browser is probably not signed in to that account. The popup is the current page.' };
      if (await press(popup, control)) { last = { key: `${url}|${control.name}`, at: Date.now() }; steps.push(next.note); stuck = 0; }
    } else if (++stuck >= 12) {
      return { page: popup, note: `The Google sign-in popup is open on a screen this does not recognize (${hostOf(url)}${new URL(url).pathname}). It is the current page: look at it and press what is needed.` };
    }
    await popup.waitForTimeout(600).catch(quiet('agent/computer/google-popup'));
  }
  return { page: popup, note: `The Google sign-in popup did not finish in time${steps.length ? ` (${steps.join(' ')})` : ''}. It is the current page.` };
}
