/** Page-level browser actions in ClikCode's own Chrome profile. */
import { defineTool } from '../tool-contract.js';
import { closeComputerBrowser, computerPage, openComputerPage } from '../computer/browser.js';
import { computerEnabled } from '../computer/settings.js';
import { callComputerDriver } from '../computer/driver.js';
import { MAX_TOOL_IMAGE_BYTES, sniffImage } from '../images.js';
import type { Page } from 'playwright-core';
import type { ToolRunResult } from '../tool-contract.js';

type WebArgs = {
  action: 'open' | 'close' | 'observe' | 'click' | 'fill' | 'press' | 'scroll' | 'autofill';
  url?: string; role?: 'button' | 'link' | 'textbox' | 'checkbox' | 'combobox' | 'tab' | 'menuitem';
  name?: string; text?: string; key?: string; direction?: 'up' | 'down';
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
  // Playwright's accessibility snapshot includes the literal value of a
  // password input. Keep the entire login form out of the model result until
  // the private sign-in broker and takeover flow are in place.
  if (await page.locator('input[type="password"]:visible').count()) {
    return { output: `Page: ${new URL(page.url()).origin}\n\nSign-in form detected. Browser contents are hidden until the user completes sign-in.` };
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
  description: 'Open a URL in ClikCode\'s browser in one action: Chrome starts automatically if closed. Observe and act on the page, then close it when done. For a visible password field, autofill triggers the installed Bitwarden extension\'s shortcut and verifies a password was filled without showing it. If the vault is locked or missing, hand the browser to the user. Never request a password in chat.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['open', 'close', 'observe', 'click', 'fill', 'press', 'scroll', 'autofill'] },
    url: { type: 'string', description: 'Website URL for open.' },
    role: { type: 'string', enum: ['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'menuitem'] },
    name: { type: 'string', description: 'Exact accessible name from observe.' },
    text: { type: 'string', description: 'Text for fill. Never include credentials.' },
    key: { type: 'string', description: 'Keyboard key for press, for example Enter or Escape.' },
    direction: { type: 'string', enum: ['up', 'down'] },
  } },
  label: (args) => `Web ${args.action}${args.url ? ` ${args.url.slice(0, 80)}` : ''}`,
  describe: async (args) => `ClikCode browser: ${args.action}${args.url ? ` ${args.url}` : ''}${args.name ? ` ${args.role} ${args.name}` : ''}${args.action === 'fill' ? ` (${args.text?.length ?? 0} characters)` : ''}`,
  async run(args, ctx) {
    try {
      if (!(await computerEnabled(ctx.stateDir))) throw new Error('Computer use is off. Run `clikcode computer on` to enable it.');
      if (args.action === 'close') { await closeComputerBrowser(ctx.stateDir); return { output: 'ClikCode browser closed.' }; }
      if (args.action === 'open') webAddress(args.url);
      const page = args.action === 'open' ? await openComputerPage(ctx.stateDir) : await computerPage(ctx.stateDir);
      const onAbort = (): void => { void page.context().close().catch(() => undefined); };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (ctx.signal?.aborted) throw new Error('Stopped.');
        switch (args.action) {
          case 'open': await page.goto(webAddress(args.url), { waitUntil: 'domcontentloaded', timeout: 30_000 }); return observeComputerPage(page, ctx.acceptsImages === true);
          case 'observe': return observeComputerPage(page, ctx.acceptsImages === true);
          case 'click': await element(page, args).click({ timeout: 10_000 }); return { output: `Clicked ${args.role} ${args.name}. Observe the page to verify the result.` };
          case 'fill':
            if (typeof args.text !== 'string' || args.text.length > 20_000) throw new Error('Fill needs text of at most 20,000 characters.');
            await element(page, args).fill(args.text, { timeout: 10_000 });
            return { output: `Filled ${args.role} ${args.name}. Observe the page to verify the result.` };
          case 'press':
            if (!args.key || !/^[A-Za-z0-9+_-]{1,30}$/.test(args.key)) throw new Error('Press needs a simple key.');
            await page.keyboard.press(args.key); return { output: `Pressed ${args.key}. Observe the page to verify the result.` };
          case 'autofill': {
            const password = page.locator('input[type="password"]:visible').first();
            if (!await password.count()) throw new Error('No visible password field on this page.');
            await page.bringToFront();
            const sent = await callComputerDriver('hotkey', {
              target: { kind: 'desktop', display_id: 'primary' }, keys: ['ctrl', 'shift', 'l'],
            }, ctx.signal);
            if (sent.isError) throw new Error('Could not trigger Bitwarden in the ClikCode browser. Use the phone handoff.');
            await page.waitForTimeout(750);
            if (!await password.inputValue()) throw new Error('Bitwarden did not fill this page. Unlock or install its extension in the ClikCode browser, or use the phone handoff.');
            return { output: 'Bitwarden filled the sign-in form. The password was not included in the tool result. Submit the form if the user asked to sign in.' };
          }
          case 'scroll': await page.mouse.wheel(0, args.direction === 'up' ? -600 : 600); return { output: 'Scrolled. Observe the page to verify the result.' };
          default: throw new Error('Unknown web action.');
        }
      } finally { ctx.signal?.removeEventListener('abort', onAbort); }
    } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
  },
});
