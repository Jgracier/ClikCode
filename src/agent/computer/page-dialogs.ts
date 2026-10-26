/** A page's own alert/confirm/prompt/beforeunload boxes. With nobody listening, the browser driver dismisses
 * them (confirm answers "cancel"), so a delete that asks "are you sure?" silently does nothing, and the agent
 * never learns that a box was shown. A listener stays on every tab for its whole life:
 *  - during a click it answers by the click's own rule (declined unless `accept_dialog`), and says what was asked;
 *  - on a tab the agent is working in, a box that arrives at any other time (a timer, a form submitted with Enter)
 *    is HELD: the page waits, the agent is shown the question and answers it with the `dialog` action. If nobody
 *    answers within two minutes it is dismissed, the safe answer;
 *  - on any other tab, or during an action that does not expect one (a sign-in), it is dismissed and reported. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { Dialog, Page } from 'playwright-core';
import { sharedState } from './shared-state.js';

type Pending = { dialog: Dialog; type: string; message: string; defaultValue: string; timer: ReturnType<typeof setTimeout> };
type Tab = { hold: boolean; policy?: { accept: boolean; seen: string[] }; pending?: Pending; notices: string[] };
const tabs = sharedState('page-dialog-state', () => new WeakMap<Page, Tab>());

export const HELD_DIALOG_MS = 120_000;

const clip = (text: string): string => text.replace(/\s+/g, ' ').slice(0, 200);
const describe = (dialog: Dialog): string => `${dialog.type()}: "${clip(dialog.message())}"`;

/** Starts listening on this tab for its whole life. Safe to call again for the same page. */
export function watchDialogs(page: Page): Tab {
  const known = tabs.get(page);
  if (known) return known;
  const tab: Tab = { hold: false, notices: [] };
  tabs.set(page, tab);
  const clear = (): void => { if (tab.pending) { clearTimeout(tab.pending.timer); tab.pending = undefined; } };
  page.on('dialog', (dialog: Dialog) => {
    const fail = quiet('agent/computer/page-dialogs');
    if (tab.policy) {
      tab.policy.seen.push(`${describe(dialog)} (${tab.policy.accept ? 'accepted' : 'declined'})`);
      void (tab.policy.accept ? dialog.accept() : dialog.dismiss()).catch(fail);
      return;
    }
    // An alert has one button: accepting it is the same as dismissing it, and the agent only needs to know it was shown.
    if (!tab.hold || dialog.type() === 'alert') {
      tab.notices.push(`${describe(dialog)} (${dialog.type() === 'alert' ? 'closed' : 'declined'})`);
      void dialog.dismiss().catch(fail);
      return;
    }
    clear();
    const timer = setTimeout(() => {
      if (tab.pending?.dialog !== dialog) return;
      tab.pending = undefined;
      tab.notices.push(`${describe(dialog)} (declined after two minutes without an answer)`);
      void dialog.dismiss().catch(fail);
    }, HELD_DIALOG_MS);
    timer.unref?.();
    tab.pending = { dialog, type: dialog.type(), message: clip(dialog.message()), defaultValue: dialog.defaultValue(), timer };
  });
  // A dialog goes with the page that raised it (a reload or navigation answers it).
  page.on('close', clear);
  return tab;
}

/** Marks this tab as one the agent is working in. `hold` is true for actions that can answer a held box. */
export function bindDialogs(page: Page, hold: boolean): void { watchDialogs(page).hold = hold; }

/** What to tell the agent about a box that is waiting for an answer, or undefined. */
export function pendingDialogNote(page: Page): string | undefined {
  const pending = tabs.get(page)?.pending;
  if (!pending) return undefined;
  const kind = pending.type === 'beforeunload' ? 'a "leave this page?" box (beforeunload)' : `a ${pending.type} box`;
  return `The page is showing ${kind}${pending.message ? `: "${pending.message}"` : ''}${pending.type === 'prompt' && pending.defaultValue ? ` (default answer "${pending.defaultValue}")` : ''}. It waits for an answer, and nothing else on the page works until then. Answer with the dialog action: accept_dialog true to accept${pending.type === 'prompt' ? ' (text is the answer to type)' : ''}, or leave it out to dismiss.`;
}

export const hasPendingDialog = (page: Page): boolean => !!tabs.get(page)?.pending;

/** Boxes that were closed without waiting for the agent since it last looked (an alert, a box outside a click). */
export function takeDialogNotices(page: Page): string[] { return tabs.get(page)?.notices.splice(0) ?? []; }

/** Answers the box that is waiting. Returns what was done. */
export async function answerDialog(page: Page, accept: boolean, text?: string): Promise<string> {
  const tab = tabs.get(page);
  const pending = tab?.pending;
  if (!tab || !pending) {
    const missed = tab?.notices.splice(0) ?? [];
    return `No dialog is waiting on the page.${missed.length ? ` Since you last looked: ${missed.join('; ')}.` : ''}`;
  }
  clearTimeout(pending.timer);
  tab.pending = undefined;
  if (accept) await pending.dialog.accept(pending.type === 'prompt' ? text ?? pending.defaultValue : undefined);
  else await pending.dialog.dismiss();
  return `The ${pending.type} box ("${pending.message}") was ${accept ? `accepted${pending.type === 'prompt' ? ` with ${(text ?? pending.defaultValue).length} characters of text` : ''}` : 'dismissed'}.`;
}

/** Answers a waiting box with the safe answer (dismiss; accept for a beforeunload when the agent is leaving the page itself). */
export async function settleWaitingDialog(page: Page, accept: boolean): Promise<string | undefined> {
  const pending = tabs.get(page)?.pending;
  if (!pending) return undefined;
  const accepted = accept && pending.type === 'beforeunload';
  return answerDialog(page, accepted);
}

/** Runs `act` with a rule for the boxes it raises (accept or decline), and returns what was asked. */
export async function withDialogs<T>(page: Page, accept: boolean, act: () => Promise<T>, linger = 300): Promise<{ result: T; dialogs: string[] }> {
  const tab = watchDialogs(page);
  const policy = { accept, seen: [] as string[] };
  const outer = tab.policy;
  tab.policy = policy;
  try {
    const result = await act();
    // A dialog raised by the click's own script can arrive just after the click returns.
    if (linger) await page.waitForTimeout(linger);
    return { result, dialogs: policy.seen };
  } finally { tab.policy = outer; }
}

export function dialogNote(dialogs: readonly string[], accepted: boolean): string {
  if (!dialogs.length) return '';
  return ` The page showed a browser dialog: ${dialogs.join('; ')}.${accepted ? '' : ' To answer yes, click again with accept_dialog true.'}`;
}

/** Adds any boxes that were closed without waiting for the agent to a result. */
export function withDialogNotices<R extends { output: string }>(result: R, page: Page): R {
  const notices = takeDialogNotices(page);
  return notices.length ? { ...result, output: `${result.output}\n\nBrowser dialogs closed without waiting: ${notices.join('; ')}.` } : result;
}

/** For the process that owns Chrome. A Playwright process with no dialog listener dismisses every box at once, which
 * would race the connected worker's answer and win (an accepted confirm came out as "cancel"). Listening here stops
 * that; a box nobody answered for longer than any worker holds one is dismissed, so no page is left blocked. */
export function leaveDialogsToWorkers(context: { pages(): Page[]; on(event: 'page', listener: (page: Page) => void): unknown }): void {
  const listen = (page: Page): void => {
    page.on('dialog', dialog => {
      const timer = setTimeout(() => { void dialog.dismiss().catch(quiet('agent/computer/page-dialogs')); }, HELD_DIALOG_MS + 30_000);
      timer.unref?.();
    });
  };
  context.pages().forEach(listen);
  context.on('page', listen);
}
