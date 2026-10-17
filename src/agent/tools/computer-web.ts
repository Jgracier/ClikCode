/** Page-level browser actions in ClikCode's own Chrome profile. */
import { defineTool } from '../tool-contract.js';
import { closeComputerBrowser, computerPage, openComputerPage } from '../computer/browser.js';
import { COMPUTER_OFF, computerEnabled } from '../computer/settings.js';
import { MAX_TOOL_IMAGE_BYTES, sniffImage } from '../images.js';
import { privateLoginPage } from '../computer/private-page.js';
import { loginComputerPage, loginOutcomeMessage } from '../computer/login-page.js';
import { LoginError } from '../computer/login-error.js';
import { loginFields, loginFieldSummary, loginOptions } from '../computer/login-fields.js';
import { runTailcatHandoff } from '../computer/tailcat-handoff.js';
import type { Page } from 'playwright-core';
import type { ToolContext, ToolRunResult } from '../tool-contract.js';

type WebArgs = {
  action: 'open' | 'close' | 'observe' | 'click' | 'fill' | 'press' | 'scroll' | 'login' | 'handoff';
  url?: string; role?: 'button' | 'link' | 'textbox' | 'checkbox' | 'combobox' | 'tab' | 'menuitem';
  name?: string; text?: string; key?: string; direction?: 'up' | 'down'; new_account?: boolean;
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

export async function observeComputerPage(page: Page, acceptsImages: boolean): Promise<ToolRunResult> {
  // Login pages remain observable by field name and type. No DOM values,
  // accessibility snapshot or screenshot crosses into the model context.
  if (await privateLoginPage(page)) {
    const fields = await loginFields(page);
    return { output: loginFieldSummary(new URL(page.url()).origin, fields, await loginOptions(page)) };
  }
  const snapshot = (await page.ariaSnapshot({ timeout: 10_000 })).slice(0, 25_000);
  const output = `Page: ${page.url()}\n\n${snapshot}`;
  if (!acceptsImages) return { output };
  let bytes = await page.screenshot({ type: 'jpeg', quality: 65, animations: 'disabled', timeout: 10_000 });
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) bytes = await page.screenshot({ type: 'jpeg', quality: 35, animations: 'disabled', timeout: 10_000 });
  const found = sniffImage(bytes);
  if (!found || bytes.length > MAX_TOOL_IMAGE_BYTES) return { output: `${output}\n\n[Screenshot too large to show.]` };
  return { output, images: [{ mimeType: found.mimeType, data: bytes.toString('base64') }] };
}

export const computerWebTool = defineTool<WebArgs>({
  name: 'computer_web', class: 'exec',
  description: 'Open a URL in one action; Chrome starts automatically. Observe shows sign-in field names without values. Login uses the one saved account for the site, lets the user pick when several are saved, otherwise privately requests the visible fields, follows ordinary sign-in pages, and saves new answers only after the browser advances past sign-in. When a sign-in page offers different ways in (root or IAM, another account), ask the user with ask_user, click their choice, then login. A one-time code is asked for privately each time and never saved. Use handoff for a CAPTCHA, or MFA that needs remote control. Never request a password or code in chat.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['open', 'close', 'observe', 'click', 'fill', 'press', 'scroll', 'login', 'handoff'] },
    url: { type: 'string', description: 'Website URL for open.' },
    role: { type: 'string', enum: ['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'menuitem'] },
    name: { type: 'string', description: 'Exact accessible name from observe.' },
    text: { type: 'string', description: 'Text for fill. Never include credentials.' },
    key: { type: 'string', description: 'Keyboard key for press, for example Enter or Escape.' },
    direction: { type: 'string', enum: ['up', 'down'] },
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
      if (args.action === 'login') return { output: error instanceof LoginError ? error.message : 'Private login did not finish. Check the browser and try again.', isError: true };
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
    case 'handoff': {
      await runTailcatHandoff({ stateDir: ctx.stateDir, signal: ctx.signal,
        onLink: link => ctx.emitOutput?.(`Open this link on your phone to finish the browser step: ${link}\n`) });
      return { output: 'The user finished the browser step. Continue from the current page.' };
    }
    case 'click': await clickOrHint(page, args); return { output: `Clicked ${args.role} ${args.name}. Observe the page to verify the result.` };
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
