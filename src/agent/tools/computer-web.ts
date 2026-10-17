/** Page-level browser actions in ClikCode's own Chrome profile. */
import { defineTool } from '../tool-contract.js';
import { closeComputerBrowser, computerPage, openComputerPage } from '../computer/browser.js';
import { COMPUTER_OFF, computerEnabled } from '../computer/settings.js';
import { MAX_TOOL_IMAGE_BYTES, sniffImage } from '../images.js';
import { privateLoginPage } from '../computer/private-page.js';
import { loginComputerPage, loginOutcomeMessage } from '../computer/login-page.js';
import { LoginError } from '../computer/login-error.js';
import { loginFields, loginFieldSummary, loginOptions, pageControls } from '../computer/login-fields.js';
import { showsSecret } from '../computer/secret-scrubber.js';
import { hideKeyLikeText } from '../computer/secret-finder.js';
import { dialogNote, withDialogs } from '../computer/page-dialogs.js';
import { captureSecret } from '../computer/secret-capture.js';
import { runTailcatHandoff } from '../computer/tailcat-handoff.js';
import type { Page } from 'playwright-core';
import type { ToolContext, ToolRunResult } from '../tool-contract.js';

type WebArgs = {
  action: 'open' | 'close' | 'observe' | 'click' | 'fill' | 'press' | 'scroll' | 'login' | 'handoff' | 'capture_secret';
  url?: string; role?: 'button' | 'link' | 'textbox' | 'checkbox' | 'combobox' | 'tab' | 'menuitem' | 'option' | 'radio' | 'switch';
  name?: string; text?: string; key?: string; direction?: 'up' | 'down'; new_account?: boolean; secret_name?: string; remote?: boolean; accept_dialog?: boolean;
};

export function webAddress(value: string | undefined): string {
  if (!value) throw new Error('Open needs a website URL.');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Open needs an HTTP or HTTPS website URL without credentials.');
  return parsed.href;
}

function element(page: Page, args: WebArgs) {
  if (!args.role || !args.name?.trim()) throw new Error('Choose an exact role and name from the latest browser observation.');
  return page.getByRole(args.role, { name: args.name, exact: true });
}

/** Runs in the page: the visible text and every input value, for the secret check. */
function visibleText(): string {
  const doc = (globalThis as unknown as { document: { body: { innerText: string }; querySelectorAll(selector: string): ArrayLike<{ value?: string }> } }).document;
  return `${doc.body.innerText}\n${Array.from(doc.querySelectorAll('input, textarea')).map(element => element.value ?? '').join('\n')}`;
}

export async function observeComputerPage(page: Page, acceptsImages: boolean): Promise<ToolRunResult> {
  // Login pages remain observable by field name and type. No DOM values,
  // accessibility snapshot or screenshot crosses into the model context.
  if (await privateLoginPage(page)) {
    const fields = await loginFields(page);
    return { output: loginFieldSummary(new URL(page.url()).origin, fields, await loginOptions(page), await pageControls(page)) };
  }
  const raw = (await page.ariaSnapshot({ timeout: 10_000 })).slice(0, 25_000);
  // A key the page is showing is not for the model to read: capture_secret takes it.
  const { text: snapshot, hidden } = hideKeyLikeText(raw);
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
  description: 'Open a URL in one action; Chrome starts automatically. Observe shows sign-in field names without values. Login uses the one saved account for the site, lets the user pick when several are saved, otherwise privately requests the visible fields, follows ordinary sign-in pages, and saves new answers only after the browser advances past sign-in. When a sign-in page offers different ways in (root or IAM, another account), ask the user with ask_user, click their choice, then login. A one-time code is asked for privately each time and never saved. Use handoff for a CAPTCHA, or MFA that needs remote control. Never request a password or code in chat. To get an API key without seeing it: go to the site\'s keys page, set the permissions, then call capture_secret with a secret_name and the role and name of the final Create button; the worker clicks it, finds the new key itself and saves it to ClikCode Secrets Manager. With no button given it takes a key the page is already showing (an account\'s current key), which does not change the key. Never click Regenerate or Reset just to see a key. You get only the length. If it cannot tell, the user is asked to tap Copy or paste (set remote when they are on their phone). Then use store_secret to put it where it belongs.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['open', 'close', 'observe', 'click', 'fill', 'press', 'scroll', 'login', 'handoff', 'capture_secret'] },
    url: { type: 'string', description: 'Website URL for open.' },
    role: { type: 'string', enum: ['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'menuitem', 'option', 'radio', 'switch'] },
    name: { type: 'string', description: 'Exact accessible name from observe.' },
    text: { type: 'string', description: 'Text for fill. Never include credentials.' },
    key: { type: 'string', description: 'Keyboard key for press, for example Enter or Escape.' },
    direction: { type: 'string', enum: ['up', 'down'] },
    accept_dialog: { type: 'boolean', description: 'For click: answer yes to a browser confirm/alert dialog the click raises (for example "delete this token?"). Default: the dialog is declined and reported.' },
    secret_name: { type: 'string', description: 'For capture_secret: the name to save the key under, such as salad/api-key.' },
    remote: { type: 'boolean', description: 'For capture_secret: also print a phone link so the user can tap Copy on the page remotely.' },
    new_account: { type: 'boolean', description: 'For login: the user wants a different account than the saved one, so ask for it instead of reusing.' },
  } },
  label: (args) => `Web ${args.action}${args.url ? ` ${args.url.slice(0, 80)}` : ''}`,
  describe: async (args) => `ClikCode browser: ${args.action}${args.url ? ` ${args.url}` : ''}${args.name ? ` ${args.role} ${args.name}` : ''}${args.action === 'fill' ? ` (${args.text?.length ?? 0} characters)` : ''}`,
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
      if (args.action === 'login' || args.action === 'capture_secret') return { output: error instanceof LoginError ? error.message : args.action === 'login' ? 'Private login did not finish. Check the browser and try again.' : 'The secret could not be saved. Check the browser and try again.', isError: true };
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  },
});

async function act(page: Page, args: WebArgs, ctx: ToolContext): Promise<ToolRunResult> {
  switch (args.action) {
    case 'open': await page.goto(webAddress(args.url), { waitUntil: 'domcontentloaded', timeout: 30_000 }); return observeComputerPage(page, ctx.acceptsImages === true);
    case 'observe': return observeComputerPage(page, ctx.acceptsImages === true);
    case 'login': {
      const outcome = await loginComputerPage({ stateDir: ctx.stateDir, page, signal: ctx.signal, newAccount: args.new_account === true,
        ask: async (site, fields, signal) => {
          if (!ctx.requestPrivateLogin) throw new LoginError('This chat cannot show private login fields.');
          return ctx.requestPrivateLogin(site, fields, signal);
        }, onVerification: () => ctx.emitOutput?.('Approve the sign-in or finish verification in the open browser.\n') });
      return { output: loginOutcomeMessage(outcome), ...(outcome === 'unverified' || outcome === 'saved_login_rejected' ? { isError: true } : {}) };
    }
    case 'capture_secret': {
      if (!args.secret_name) throw new Error('capture_secret needs a secret_name.');
      const { length, found } = await captureSecret({ stateDir: ctx.stateDir, page, name: args.secret_name, remote: args.remote === true, signal: ctx.signal,
        ...(args.role && args.name ? { trigger: () => clickOrHint(page, args) } : {}),
        ask: async (name, hint, signal) => {
          if (!ctx.requestPrivateSecret) throw new LoginError('This chat cannot show a private prompt.');
          return ctx.requestPrivateSecret(name, hint, signal);
        }, onLink: link => ctx.emitOutput?.(`Open this link on your phone, then tap Copy on the page: ${link}\n`) });
      return { output: `Saved secret "${args.secret_name}" (${length} characters) in ClikCode Secrets Manager${found ? ', found on the page' : ', supplied by the user'}. Its value was not shown to you. Use store_secret to send it where it belongs.` };
    }
    case 'handoff': {
      await runTailcatHandoff({ stateDir: ctx.stateDir, signal: ctx.signal,
        onLink: link => ctx.emitOutput?.(`Open this link on your phone to finish the browser step: ${link}\n`) });
      return { output: 'The user finished the browser step. Continue from the current page.' };
    }
    case 'click': {
    const { dialogs } = await withDialogs(page, args.accept_dialog === true, () => clickOrHint(page, args));
    return { output: `Clicked ${args.role} ${args.name}.${dialogNote(dialogs, args.accept_dialog === true)} Observe the page to verify the result.` };
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
  try { await element(page, args).click({ timeout: 10_000 }); }
  catch (error) {
    if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
    throw new Error(`${error.message.split('\n')[0]} If a popup window or browser dialog is in front of the page, use computer_desktop to see and answer it.`);
  }
}
