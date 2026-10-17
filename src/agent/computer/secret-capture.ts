/** Gets an API key from the page into the Secrets Manager without it passing
 * through the model, and on to wherever the agent said it should go.
 *
 * The worker does everything it can by itself, in this order: press the site's own
 * Copy button, read a file the site hands over, or recognise the key on the page.
 * Only when none of that is clear does a person step in, by pasting into the private
 * prompt. Every failure says "Not saved" and why; nothing is ever saved half-way. */
import type { Page } from 'playwright-core';
import { saveNamedSecret } from './credential-vault.js';
import { copyWithSiteButton, listenForCopies, copiedSince } from './clipboard-watch.js';
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
  check?(pageUrl: string, value: string, options: { fresh: boolean }): Promise<KeyCheck>;
  /** Where the key goes once it is captured and checked, decided and approved beforehand. */
  sendTo?: readonly Destination[];
}): Promise<{ length: number; found: boolean; check: KeyCheck; sent: Delivery[] }> {
  const stop = new AbortController();
  // Before the click, a stop simply stops. After it the site may already have made a key, so what is
  // under way is finished and saved rather than abandoned half-way; only waiting for a person gives up.
  let clicked = false;
  const outer = (): void => { if (!clicked) stop.abort(); };
  input.signal?.addEventListener('abort', outer, { once: true });
  if (input.signal?.aborted) stop.abort();
  const finder = await armFinder(input.page, input.existing ?? !input.trigger);
  const download = watchDownload(input.page);
  await listenForCopies(input.page);
  try {
    if (input.trigger) { clicked = true; await input.trigger(); }
    let value: string | undefined;
    let ambiguous = false;
    for (let poll = 0; poll < LOOK_POLLS && !value; poll++) {
      if (!clicked && stop.signal.aborted) throw new LoginError('Not saved: capture was cancelled.');
      await input.page.waitForTimeout(500);
      value = await download.result();
      if (value) break;
      value = await copiedSince(input.page);
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
      const hint = `${ambiguous ? 'More than one possible key on the page' : 'Could not find the key on its own'}. Paste it here`;
      value = await input.ask(input.name, hint, input.signal ? AbortSignal.any([stop.signal, input.signal]) : stop.signal);
    }
    if (!value) throw new LoginError('Not saved: no key was found and none was pasted.');
    registerSecret(value);
    for (const part of secretParts(value)) registerSecret(part);
    const check = await (input.check ?? ((url, key, options) => checkKey(url, key, fetch, options)))(input.page.url(), value, { fresh: clicked });
    // A value its own service refuses, from a page that already showed it, is not the key (an id, a page
    // blob): saving it would only hide the problem. A key just made by the click is different: the site
    // shows it once, so it is kept (and held back from every destination) rather than lost.
    if (check.verdict === 'rejected' && !clicked) throw new LoginError(`Not saved: ${check.detail}. What was on the page is not a working key (it may be the key's id or another value).`);
    await saveNamedSecret(input.stateDir, input.name, value);
    // Saved first: if a destination fails, the key is still safe in Secrets Manager and can be sent again.
    const sent = input.sendTo?.length && check.verdict !== 'rejected' ? await sendToDestinations(input.stateDir, input.sendTo, value, input.signal) : [];
    return { length: value.length, found, check, sent };
  } catch (error) {
    // The click may have made the site create a key: whoever reports the failure must be able to say so.
    throw clicked && error instanceof Error ? Object.assign(error, { afterClick: true }) : error;
  } finally {
    finder.dispose();
    download.stop();
    stop.abort();
    input.signal?.removeEventListener('abort', outer);
  }
}
