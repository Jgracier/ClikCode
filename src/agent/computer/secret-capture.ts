/** Gets an API key from the page into the Secrets Manager without it passing
 * through the model, and on to wherever the agent said it should go.
 *
 * The worker does everything it can by itself, in this order: press the site's own
 * Copy button, read a file the site hands over, or recognise the key on the page.
 * Only when none of that is clear does a person step in, by pasting into the private
 * prompt. Every failure says "Not saved" and why; nothing is ever saved half-way. */
import type { Page } from 'playwright-core';
import { saveNamedSecret } from './credential-vault.js';
import { copyWithSiteButton, waitForCopiedSecret } from './clipboard-watch.js';
import { secretParts, watchDownload } from './download-capture.js';
import { LoginError } from './login-error.js';
import { checkKey, type KeyCheck } from './key-check.js';
import { armFinder } from './secret-finder.js';
import { sendToDestinations, type Delivery, type Destination } from './secret-destinations.js';
import { registerSecret } from './secret-scrubber.js';

const LOOK_POLLS = 20;

export async function captureSecret(input: {
  stateDir: string; page: Page; name: string; signal?: AbortSignal;
  /** The click that makes the site show or hand over the key, done after the page is watched. */
  trigger?(): Promise<void>;
  /** Take a key the page already shows, instead of one that appears after a click. Default: when there is no click. */
  existing?: boolean;
  ask(name: string, hint: string, signal: AbortSignal): Promise<string | undefined>;
  /** Tests the value against its service before it is saved. Default: the built-in checks by site. */
  check?(pageUrl: string, value: string): Promise<KeyCheck>;
  /** Where the key goes once it is captured and checked, decided and approved beforehand. */
  sendTo?: readonly Destination[];
}): Promise<{ length: number; found: boolean; check: KeyCheck; sent: Delivery[] }> {
  const stop = new AbortController();
  const outer = (): void => stop.abort();
  input.signal?.addEventListener('abort', outer, { once: true });
  if (input.signal?.aborted) stop.abort();
  const finder = await armFinder(input.page, input.existing ?? !input.trigger);
  const download = watchDownload(input.page);
  try {
    await input.trigger?.();
    let value: string | undefined;
    let ambiguous = false;
    for (let poll = 0; poll < LOOK_POLLS && !value; poll++) {
      if (stop.signal.aborted) throw new LoginError('Not saved: capture was cancelled.');
      await input.page.waitForTimeout(500);
      value = await download.result();
      if (value) break;
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
      const hint = `${ambiguous ? 'More than one possible key on the page' : 'Could not find the key on its own'}. Copy it on the page, or paste it here`;
      value = await new Promise<string | undefined>((resolve, reject) => {
        void waitForCopiedSecret(input.page, stop.signal).then(copied => { if (copied) resolve(copied); }, () => undefined);
        input.ask(input.name, hint, stop.signal).then(resolve, reject);
      });
    }
    if (!value || input.signal?.aborted) throw new LoginError('Not saved: no key was found and none was pasted.');
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
    download.stop();
    stop.abort();
    input.signal?.removeEventListener('abort', outer);
  }
}
