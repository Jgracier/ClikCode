/** Gets an API key from the page into the Secrets Manager without it passing
 * through the model, and on to wherever the agent said it should go.
 *
 * The worker does everything it can by itself, in this order: press the site's own
 * Copy button, read a file the site hands over, or recognise the key on the page.
 * Only when none of that is clear does a person step in, by pasting into the private
 * prompt. Every failure says "Not saved" and why; nothing is ever saved half-way. */
import type { Page } from 'playwright-core';
import { namedSecretNames, readNamedSecret, saveNamedSecret } from './credential-vault.js';
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
  /** Skip looking and ask the user to paste it (the agent knows the page hides it or shows it as an image). */
  paste?: boolean;
}): Promise<{ length: number; found: boolean; shape: string; via: string; check: KeyCheck; sent: Delivery[] }> {
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
    let via = 'the page';
    let ambiguous = false;
    let presses = 0; // the site's Copy button is pressed a couple of times at most: a button that copies nothing is not worth 3 s a poll
    for (let poll = 0; poll < (input.paste ? 0 : LOOK_POLLS) && !value; poll++) {
      if (!clicked && stop.signal.aborted) throw new LoginError('Not saved: capture was cancelled.');
      await input.page.waitForTimeout(500);
      value = await download.result();
      if (value) { via = 'a file the site handed over'; break; }
      value = await copiedSince(input.page);
      if (value) { via = 'the Copy button that was pressed'; break; }
      const decision = await finder.look();
      // After a Create, the site's own Copy button is the exact answer. Without a click
      // (a key already on the page) the page's own text is trusted first, because a
      // bare "Copy" there may copy something else.
      if ((input.trigger || decision.kind !== 'found') && presses < 2) {
        presses++;
        const copied = await copyWithSiteButton(input.page);
        if (copied) { value = copied.value; via = `the site's Copy button${copied.label ? ` next to "${copied.label}"` : ''}`; }
      }
      if (value) break;
      if (decision.kind === 'found') { value = decision.value; via = 'text on the page'; }
      else if (decision.kind === 'ambiguous') { ambiguous = true; break; }
    }
    const found = !!value;
    if (!value) {
      const hint = `${input.paste ? `Copy the ${input.name} from the site` : ambiguous ? 'More than one possible key on the page' : 'Could not find the key on its own'}. Paste it here`;
      value = await input.ask(input.name, hint, input.signal ? AbortSignal.any([stop.signal, input.signal]) : stop.signal);
    }
    if (!value) throw new LoginError('Not saved: no key was found and none was pasted.');
    if (!found) via = 'pasted by the user';
    registerSecret(value);
    for (const part of secretParts(value)) registerSecret(part);
    // A second value that equals one already saved under another name is the first value again (an
    // access key id taken twice for a pair), never a new secret.
    for (const other of await namedSecretNames(input.stateDir)) {
      if (other.toLowerCase() !== input.name.toLowerCase() && await readNamedSecret(input.stateDir, other).catch(() => undefined) === value) {
        throw new LoginError(`Not saved: this is the same value already saved as "${other}", not a different secret. Press the Copy button for the other value, or paste it.`);
      }
    }
    const check = await (input.check ?? ((url, key, options) => checkKey(url, key, fetch, options)))(input.page.url(), value, { fresh: clicked });
    // A value its own service refuses, from a page that already showed it, is not the key (an id, a page
    // blob): saving it would only hide the problem. A key just made by the click is different: the site
    // shows it once, so it is kept (and held back from every destination) rather than lost.
    if (check.verdict === 'rejected' && !clicked) throw new LoginError(`Not saved: ${check.detail}. What was on the page is not a working key (it may be the key's id or another value).`);
    await saveNamedSecret(input.stateDir, input.name, value);
    // Saved first: if a destination fails, the key is still safe in Secrets Manager and can be sent again.
    const sent = input.sendTo?.length && check.verdict !== 'rejected' ? await sendToDestinations(input.stateDir, input.sendTo, value, input.signal) : [];
    return { length: value.length, found, shape: describeShape(value), via, check, sent };
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

/** What kind of text the value is, never the text: enough for the agent to notice an id where a secret should be. */
export function describeShape(value: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return 'a UUID';
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value) && value.startsWith('eyJ')) return 'a JWT';
  if (/^\s*\{/.test(value)) return 'JSON';
  if (/^[0-9a-f]+$/i.test(value)) return 'hexadecimal';
  if (/^[A-Z0-9]+$/.test(value)) return 'upper-case letters and digits';
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return 'letters and digits (base64-like)';
  return 'mixed characters';
}
