/** Gets an API key from the page into the Secrets Manager without it passing
 * through the model. First the worker finds the key itself (the site's own
 * response and new key-looking text on the page). Only when that is not clear
 * does a person step in: tap the site's Copy button (on the computer or through
 * the phone link) or paste into the private prompt. */
import type { Page } from 'playwright-core';
import { saveNamedSecret } from './credential-vault.js';
import { copyWithSiteButton, waitForCopiedSecret } from './clipboard-watch.js';
import { captureDownload, secretParts } from './download-capture.js';
import { LoginError } from './login-error.js';
import { armFinder } from './secret-finder.js';
import { checkKey, type KeyCheck } from './key-check.js';
import { sendToDestinations, type Delivery, type Destination } from './secret-destinations.js';
import { registerSecret } from './secret-scrubber.js';
import { runTailcatHandoff } from './tailcat-handoff.js';

const LOOK_POLLS = 20;

export async function captureSecret(input: {
  stateDir: string; page: Page; name: string; remote: boolean; signal?: AbortSignal;
  /** The click that makes the site show the key, done after the page is watched. */
  trigger?(): Promise<void>;
  /** Take a key the page already shows, instead of one that appears after a click. Default: when there is no click. */
  existing?: boolean;
  ask(name: string, hint: string, signal: AbortSignal): Promise<string | undefined>;
  onLink(link: string): void;
  /** Tests the value against its service before it is saved. Default: the built-in checks by site. */
  check?(pageUrl: string, value: string): Promise<KeyCheck>;
  /** Where the key goes once it is captured and checked, decided and approved beforehand. */
  sendTo?: readonly Destination[];
  /** `download`: the key is a file the site hands over, taken instead of looking at the page. */
  source?: 'page' | 'download';
}): Promise<{ length: number; found: boolean; check: KeyCheck; sent: Delivery[] }> {
  const stop = new AbortController();
  const outer = (): void => stop.abort();
  input.signal?.addEventListener('abort', outer, { once: true });
  if (input.signal?.aborted) stop.abort();
  const finder = await armFinder(input.page, input.existing ?? !input.trigger);
  try {
    let value: string | undefined;
    let ambiguous = false;
    if (input.source === 'download') value = await captureDownload(input.page, input.trigger);
    else await input.trigger?.();
    for (let poll = 0; input.source !== 'download' && poll < LOOK_POLLS && !value; poll++) {
      if (stop.signal.aborted) throw new LoginError('Secret capture cancelled.');
      await input.page.waitForTimeout(500);
      const decision = await finder.look();
      // After a Create, the site's own Copy button is the exact answer. Without a click
      // (a key already on the page) the page's own text is trusted first, because a
      // bare "Copy" there may copy something else.
      if (input.trigger || decision.kind !== 'found') value = await copyWithSiteButton(input.page);
      if (value) break;
      if (decision.kind === 'found') value = decision.value;
      else if (decision.kind === 'ambiguous') { ambiguous = true; break; }
    }
    const found = !!value;
    if (!value) {
      const hint = (ambiguous ? 'More than one possible key on the page. ' : input.source === 'download' ? 'No file was downloaded. ' : 'Could not find the key on its own. ')
        + (input.remote ? 'Tap Copy on the page at the link, or paste the key here' : 'Copy the key on the page, or paste it here');
      if (input.remote) void runTailcatHandoff({ stateDir: input.stateDir, signal: stop.signal, onLink: input.onLink }).catch(() => undefined);
      value = await new Promise<string | undefined>((resolve, reject) => {
        void waitForCopiedSecret(input.page, stop.signal).then(copied => { if (copied) resolve(copied); }, () => undefined);
        input.ask(input.name, hint, stop.signal).then(resolve, reject);
      });
    }
    if (!value || input.signal?.aborted) throw new LoginError('Secret capture cancelled.');
    registerSecret(value);
    for (const part of secretParts(value)) registerSecret(part);
    const check = await (input.check ?? checkKey)(input.page.url(), value);
    // A value its own service refuses is not the key (an id, a page blob): saving it would only hide the problem.
    if (check.verdict === 'rejected') throw new LoginError(`Not saved: ${check.detail}. What was on the page is not a working key (it may be the key's id or another value).`);
    await saveNamedSecret(input.stateDir, input.name, value);
    // Saved first: if a destination fails, the key is still safe in Secrets Manager and can be sent again.
    const sent = input.sendTo?.length ? await sendToDestinations(input.sendTo, value, input.signal) : [];
    return { length: value.length, found, check, sent };
  } finally {
    finder.dispose();
    stop.abort();
    input.signal?.removeEventListener('abort', outer);
  }
}
