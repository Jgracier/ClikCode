/** A page's own confirm/alert/prompt boxes. With nobody listening, the browser
 * driver dismisses them (confirm answers "cancel"), so a delete that asks "are
 * you sure?" silently does nothing. Listening lets the agent see what was asked
 * and choose: declined by default, accepted when the agent says so. */
import type { Dialog, Page } from 'playwright-core';

export async function withDialogs<T>(page: Page, accept: boolean, act: () => Promise<T>): Promise<{ result: T; dialogs: string[] }> {
  const seen: string[] = [];
  const onDialog = (dialog: Dialog): void => {
    seen.push(`${dialog.type()}: "${dialog.message().replace(/\s+/g, ' ').slice(0, 200)}" (${accept ? 'accepted' : 'declined'})`);
    void (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
  };
  page.on('dialog', onDialog);
  try {
    const result = await act();
    // A dialog raised by the click's own script can arrive just after the click returns.
    await page.waitForTimeout(300);
    return { result, dialogs: seen };
  } finally { page.off('dialog', onDialog); }
}

export function dialogNote(dialogs: readonly string[], accepted: boolean): string {
  if (!dialogs.length) return '';
  return ` The page showed a browser dialog: ${dialogs.join('; ')}.${accepted ? '' : ' To answer yes, click again with accept_dialog true.'}`;
}
