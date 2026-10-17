/** Page-level browser actions in ClikCode's own Chrome profile. */
import { defineTool } from '../tool-contract.js';
import { closeComputerBrowser, computerPage, openComputerPage } from '../computer/browser.js';
import { COMPUTER_OFF, computerEnabled } from '../computer/settings.js';
import { MAX_TOOL_IMAGE_BYTES, sniffImage } from '../images.js';
import { privateLoginPage } from '../computer/private-page.js';
import { loginComputerPage, loginOutcomeMessage } from '../computer/login-page.js';
import { LoginError } from '../computer/login-error.js';
import { loginFields, loginFieldSummary, pageControls } from '../computer/login-fields.js';
import { scrubSecrets, showsSecret } from '../computer/secret-scrubber.js';
import { hideKeyLikeText } from '../computer/secret-finder.js';
import { dialogNote, withDialogs } from '../computer/page-dialogs.js';
import { SEND_TO_HELP, SEND_TO_SCHEMA } from './store-secret.js';
import { destinationProblem, type Destination } from '../computer/secret-destinations.js';
import { captureSecret } from '../computer/secret-capture.js';
import { runTailcatHandoff } from '../computer/tailcat-handoff.js';
import type { Page } from 'playwright-core';
import type { ToolContext, ToolRunResult } from '../tool-contract.js';

type WebArgs = {
  action: 'open' | 'close' | 'observe' | 'click' | 'fill' | 'press' | 'scroll' | 'login' | 'handoff' | 'capture_secret';
  url?: string; role?: 'button' | 'link' | 'textbox' | 'checkbox' | 'combobox' | 'tab' | 'menuitem' | 'option' | 'radio' | 'switch';
  name?: string; text?: string; key?: string; direction?: 'up' | 'down'; new_account?: boolean; secret_name?: string; accept_dialog?: boolean; send_to?: Destination[]; full?: boolean;
};

export function webAddress(value: string | undefined): string {
  if (!value) throw new Error('Open needs a website URL.');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Open needs an HTTP or HTTPS website URL without credentials.');
  return parsed.href;
}

function element(page: Page, args: WebArgs) {
  if (!args.name?.trim()) throw new Error('Choose an exact name (and role, when known) from the latest browser observation.');
  // No role: match the visible text, for controls the accessibility tree names badly.
  return args.role ? page.getByRole(args.role, { name: args.name, exact: true }) : page.getByText(args.name, { exact: true }).locator('visible=true').first();
}

/** Radios, checkboxes and switches are often visually hidden behind a styled
 * label, so a plain click cannot reach them: set them directly instead. */
async function press(page: Page, args: WebArgs): Promise<void> {
  const target = element(page, args);
  if (args.role === 'radio' || args.role === 'checkbox' || args.role === 'switch') {
    try { await target.check({ timeout: 4_000 }); return; }
    catch { await target.evaluate(node => (node as unknown as { click(): void }).click(), undefined, { timeout: 4_000 }); return; }
  }
  await target.click({ timeout: 10_000 });
}

/** Runs in the page: the visible text and every input value, for the secret check. */
function visibleText(): string {
  const doc = (globalThis as unknown as { document: { body: { innerText: string }; querySelectorAll(selector: string): ArrayLike<{ value?: string }> } }).document;
  return `${doc.body.innerText}\n${Array.from(doc.querySelectorAll('input, textarea')).map(element => element.value ?? '').join('\n')}`;
}

/** A page's header menus and footer are most of its accessibility text and rarely what a task needs.
 * With a `main` area present they are folded to one line; `full` brings them back. */
export function compactSnapshot(snapshot: string): string {
  const blocks: string[][] = [];
  for (const line of snapshot.split('\n')) { if (line.startsWith('- ') || !blocks.length) blocks.push([line]); else blocks.at(-1)!.push(line); }
  if (!blocks.some(block => /^- main\b/.test(block[0] ?? ''))) return snapshot;
  const kept: string[] = [];
  let folded = false;
  for (const block of blocks) {
    if (/^- (banner|contentinfo)\b/.test(block[0] ?? '')) { folded = true; continue; }
    kept.push(...block);
  }
  return folded ? `${kept.join('\n')}\n- (header and footer folded away; observe with full: true to see them)` : snapshot;
}

export async function observeComputerPage(page: Page, acceptsImages: boolean, full = false): Promise<ToolRunResult> {
  // Login pages remain observable by field name and type. No DOM values,
  // accessibility snapshot or screenshot crosses into the model context.
  if (await privateLoginPage(page)) {
    const fields = await loginFields(page);
    return { output: loginFieldSummary(new URL(page.url()).origin, fields, await pageControls(page)) };
  }
  const raw = (await page.ariaSnapshot({ timeout: 10_000 })).slice(0, 25_000);
  // A key the page is showing is not for the model to read: capture_secret takes it.
  const { text: shown, hidden } = hideKeyLikeText(raw);
  const snapshot = full ? shown : compactSnapshot(shown);
  const output = `Page: ${page.url()}\n\n${snapshot}${hidden ? `\n\n[${hidden} key-like value${hidden === 1 ? '' : 's'} hidden. Use capture_secret to save it without reading it.]` : ''}`;
  if (!acceptsImages) return { output };
  if (hidden || showsSecret(snapshot) || showsSecret(await page.evaluate(visibleText).catch(() => ''))) return { output: `${output}\n\n[Screenshot withheld: the page shows a saved secret.]` };
  let bytes = await page.screenshot({ type: 'jpeg', quality: 65, animations: 'disabled', timeout: 10_000 });
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) bytes = await page.screenshot({ type: 'jpeg', quality: 35, animations: 'disabled', timeout: 10_000 });
  const found = sniffImage(bytes);
  if (!found || bytes.length > MAX_TOOL_IMAGE_BYTES) return { output: `${output}\n\n[Screenshot too large to show.]` };
  return { output, images: [{ mimeType: found.mimeType, data: bytes.toString('base64') }] };
}

export const computerWebTool = defineTool<WebArgs>({
  name: 'computer_web', class: 'exec',
  description: [
    "Drive ClikCode's own Chrome (its own saved profile; it starts by itself).",
    'Actions: open (a URL, then shows the page) · observe · click · fill · press · scroll · login · handoff · capture_secret · close.',
    'click/fill take a role and the exact name from observe; leave the role out to match visible text. observe hides the page header and footer unless full is true.',
    'Sign-in pages show only field names. login uses a saved login, or asks the user privately (never ask for a password or code in chat). When a sign-in page offers different ways in (root or IAM, another account), ask the user with ask_user, click their choice, then login. handoff gives the user a phone link for a CAPTCHA or MFA.',
    'Do the whole task you were given without checking in at each step; ask the user only when you are genuinely blocked (a sign-in they must type, a choice between accounts, a payment).',
    'API keys: go to the site\'s key page, set the options, then capture_secret with the final Create button as role+name and a send_to plan. It presses the site\'s Copy button or reads the file it hands over, checks the key against its service, saves it to ClikCode Secrets Manager and sends it where send_to says. You never see the key. With no button it takes a key the page already shows; never click Regenerate just to see one.',
  ].join('\n'),
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['open', 'close', 'observe', 'click', 'fill', 'press', 'scroll', 'login', 'handoff', 'capture_secret'] },
    url: { type: 'string', description: 'open: the website address.' },
    role: { type: 'string', enum: ['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'menuitem', 'option', 'radio', 'switch'], description: 'click, fill, capture_secret: the control\'s role. Leave out to match visible text.' },
    name: { type: 'string', description: 'click, fill, capture_secret: the exact name (or visible text) from observe.' },
    text: { type: 'string', description: 'fill: the text. Never a credential.' },
    key: { type: 'string', description: 'press: a key such as Enter or Escape.' },
    direction: { type: 'string', enum: ['up', 'down'], description: 'scroll.' },
    full: { type: 'boolean', description: 'observe: include the header and footer.' },
    accept_dialog: { type: 'boolean', description: 'click: answer yes to a browser confirm dialog the click raises ("delete this token?"). Default: declined and reported.' },
    new_account: { type: 'boolean', description: 'login: ask for a different account instead of the saved one.' },
    secret_name: { type: 'string', description: 'capture_secret: name to save the key under (default: the site\'s name plus "/key").' },
    send_to: { ...SEND_TO_SCHEMA, description: 'capture_secret: ' + SEND_TO_HELP },
  } },
  label: (args) => {
    const host = (): string => { try { return new URL(args.url ?? '').hostname.replace(/^www\./, ''); } catch { return args.url?.slice(0, 60) ?? ''; } };
    switch (args.action) {
      case 'open': return `Open ${host()}`;
      case 'observe': return 'Look at the page';
      case 'click': return `Click ${args.name ?? ''}`.trim();
      case 'fill': return `Fill ${args.name ?? ''}`.trim();
      case 'press': return `Press ${args.key ?? ''}`.trim();
      case 'login': return 'Sign in';
      case 'handoff': return 'Hand off to phone';
      case 'capture_secret': return `Capture key${args.secret_name ? ` as ${args.secret_name}` : ''}`;
      case 'close': return 'Close browser';
      default: return `Web ${args.action}`;
    }
  },
  describe: async (args) => `ClikCode browser: ${args.action}${args.url ? ` ${args.url}` : ''}${args.name ? ` ${args.name}` : ''}${args.action === 'fill' ? ` (${args.text?.length ?? 0} characters)` : ''}`,
  async run(args, ctx) {
    try {
      if (!(await computerEnabled(ctx.stateDir))) throw new Error(COMPUTER_OFF);
      if (args.action === 'close') { await closeComputerBrowser(ctx.stateDir); return { output: 'ClikCode browser closed.' }; }
      if (args.action === 'open') webAddress(args.url);
      let page = args.action === 'open' ? await openComputerPage(ctx.stateDir) : await computerPage(ctx.stateDir);
      if (args.action === 'open' && await privateLoginPage(page)) {
        const old = page;
        page = await old.context().newPage();
        await old.close();
      }
      // Playwright cannot be interrupted mid-call, so a stop returns at once
      // and the browser carries on harmlessly in the background.
      let onAbort = (): void => undefined;
      const stopped = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error('Stopped.')); });
      stopped.catch(() => undefined);
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (ctx.signal?.aborted) throw new Error('Stopped.');
        return await Promise.race([stopped, act(page, args, ctx)]);
      } finally { ctx.signal?.removeEventListener('abort', onAbort); }
    } catch (error) {
      // A sign-in's own errors may echo what was typed, so only its planned messages are shown; a capture's are always the real reason.
      if (args.action === 'login') return { output: error instanceof LoginError ? error.message : 'Private login did not finish. Check the browser and try again.', isError: true };
      if (args.action === 'capture_secret') { const why = error instanceof Error ? error.message : String(error); return { output: scrubSecrets(why.startsWith('Not saved') ? why : `Not saved: ${why}`), isError: true }; }
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  },
});

async function act(page: Page, args: WebArgs, ctx: ToolContext): Promise<ToolRunResult> {
  switch (args.action) {
    case 'open': await page.goto(webAddress(args.url), { waitUntil: 'domcontentloaded', timeout: 30_000 }); return observeComputerPage(page, ctx.acceptsImages === true);
    case 'observe': return observeComputerPage(page, ctx.acceptsImages === true, args.full === true);
    case 'login': {
      const outcome = await loginComputerPage({ stateDir: ctx.stateDir, page, signal: ctx.signal, newAccount: args.new_account === true,
        ask: async (site, fields, signal) => {
          if (!ctx.requestPrivateLogin) throw new LoginError('This chat cannot show private login fields.');
          return ctx.requestPrivateLogin(site, fields, signal);
        }, onVerification: () => ctx.emitOutput?.('Approve the sign-in or finish verification in the open browser.\n') });
      return { output: loginOutcomeMessage(outcome), ...(outcome === 'unverified' || outcome === 'saved_login_rejected' ? { isError: true } : {}) };
    }
    case 'capture_secret': {
      // Before anything is clicked: a key must not be created for a plan that cannot deliver it.
      const planProblem = args.send_to?.length ? await destinationProblem(ctx.stateDir, args.send_to) : undefined;
      if (planProblem) throw new Error(planProblem);
      const name = args.secret_name?.trim() || `${new URL(page.url()).hostname.replace(/^www\./, '')}/key`;
      const { length, found, check, sent } = await captureSecret({ stateDir: ctx.stateDir, page, name, signal: ctx.signal,
        ...(args.send_to?.length ? { sendTo: args.send_to } : {}),
        ...(args.name ? { trigger: () => clickOrHint(page, args) } : {}),
        ask: async (secretName, hint, signal) => {
          if (!ctx.requestPrivateSecret) throw new LoginError('Not saved: this chat cannot show a private prompt, and the key could not be found on its own.');
          return ctx.requestPrivateSecret(secretName, hint, signal);
        } });
      const lines = [
        `SAVED "${name}" in ClikCode Secrets Manager (${length} characters, ${found ? 'found on the page' : 'pasted by the user'}). You were not shown the key.`,
        check.verdict === 'works' ? `Checked: ${check.detail}.` : `Not checked: ${check.detail}.`,
        ...sent.map(delivery => `${delivery.ok ? 'SENT' : 'NOT SENT'} - ${delivery.label}: ${delivery.message}`),
        ...(sent.some(delivery => !delivery.ok) ? ['The key is still saved. Fix the cause, then send it again with store_secret.'] : sent.length ? [] : ['Nothing was sent anywhere: use send_to to send it on, or store_secret later.']),
      ];
      return { output: lines.join('\n'), ...(sent.some(delivery => !delivery.ok) ? { isError: true } : {}) };
    }
    case 'handoff': {
      await runTailcatHandoff({ stateDir: ctx.stateDir, signal: ctx.signal,
        onLink: link => ctx.emitOutput?.(`Open this link on your phone to finish the browser step: ${link}\n`) });
      return { output: 'The user finished the browser step. Continue from the current page.' };
    }
    case 'click': {
      const { dialogs } = await withDialogs(page, args.accept_dialog === true, () => clickOrHint(page, args));
      return { output: `Clicked ${args.name}.${dialogNote(dialogs, args.accept_dialog === true)} Observe the page to see the result.` };
    }
    case 'fill':
      if (typeof args.text !== 'string' || args.text.length > 20_000) throw new Error('Fill needs text of at most 20,000 characters.');
      await element(page, args).fill(args.text, { timeout: 10_000 });
      return { output: `Filled ${args.role} ${args.name}. Observe the page to verify the result.` };
    case 'press':
      if (!args.key || !/^[A-Za-z0-9+_-]{1,30}$/.test(args.key)) throw new Error('Press needs a simple key.');
      await page.keyboard.press(args.key); return { output: `Pressed ${args.key}. Observe the page to verify the result.` };
    case 'scroll': await page.mouse.wheel(0, args.direction === 'up' ? -600 : 600); return { output: 'Scrolled. Observe the page to verify the result.' };
    default: throw new Error('Unknown web action.');
  }
}

/** A native dialog or separate popup window is outside the page, so a click
 * that never lands is most often that: point the agent at the desktop tool. */
async function clickOrHint(page: Page, args: WebArgs): Promise<void> {
  try { await press(page, args); }
  catch (error) {
    if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
    throw new Error(`${error.message.split('\n')[0]} If a popup window or browser dialog is in front of the page, use computer_desktop to see and answer it.`);
  }
}
