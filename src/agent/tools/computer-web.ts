/** Page-level browser actions in ClikCode's own Chrome profile. */
import { defineTool } from '../tool-contract.js';
import { closeComputerBrowser, computerPage, frontPage, openComputerPage } from '../computer/browser.js';
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
import { destinationProblem, normalizeSendTo, type Destination } from '../computer/secret-destinations.js';
import { captureSecret } from '../computer/secret-capture.js';
import { runTailcatHandoff } from '../computer/tailcat-handoff.js';
import type { Locator, Page } from 'playwright-core';
import type { ToolContext, ToolRunResult } from '../tool-contract.js';

type Step = { do: 'click' | 'fill' | 'press' | 'scroll'; target?: string; text?: string; key?: string; direction?: 'up' | 'down'; accept_dialog?: boolean };
type WebArgs = {
  action: 'open' | 'close' | 'observe' | 'click' | 'fill' | 'press' | 'scroll' | 'steps' | 'login' | 'handoff' | 'capture_secret';
  url?: string; target?: string; text?: string; key?: string; direction?: 'up' | 'down'; steps?: Step[]; full?: boolean; accept_dialog?: boolean;
  new_account?: boolean; secret_name?: string; send_to?: Destination[] | Destination | string;
};

export function webAddress(value: string | undefined): string {
  if (!value) throw new Error('Open needs a website URL.');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Open needs an HTTP or HTTPS website URL without credentials.');
  return parsed.href;
}

const REF = /^(?:f\d+)?e\d+$/;

/** What `target` points at: a [ref=eN] from the last view (any element, named or not, in any frame),
 * or visible text for the controls of a sign-in page, which are listed by name without references. */
async function locate(page: Page, target: string | undefined): Promise<Locator> {
  const wanted = target?.trim();
  if (!wanted) throw new Error('Say what to act on: a [ref=…] from the page view, or its visible text.');
  if (REF.test(wanted)) {
    const byRef = page.locator(`aria-ref=${wanted}`);
    if (await byRef.count()) return byRef;
    throw new Error(`Nothing on the page has the reference ${wanted}: the page has changed since it was read.`);
  }
  for (const candidate of [page.getByText(wanted, { exact: true }), page.getByLabel(wanted, { exact: true }), page.getByPlaceholder(wanted, { exact: true }), page.getByTitle(wanted, { exact: true })]) {
    const visible = candidate.locator('visible=true');
    if (await visible.count()) return visible.first();
  }
  throw new Error(`Nothing on the page shows "${wanted}".`);
}

/** Radios, checkboxes and switches are often visually hidden behind a styled label, and a
 * click can land on something in front: fall back to clicking the element itself. */
async function press(target: Locator): Promise<void> {
  try { await target.click({ timeout: 6_000 }); }
  catch (error) {
    if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
    await target.evaluate(node => (node as unknown as { click(): void }).click(), undefined, { timeout: 3_000 });
  }
}

/** Runs in the page: the visible text and every input value, for the secret check. */
function visibleText(): string {
  const doc = (globalThis as unknown as { document: { body: { innerText: string }; querySelectorAll(selector: string): ArrayLike<{ value?: string }> } }).document;
  return `${doc.body.innerText}\n${Array.from(doc.querySelectorAll('input, textarea')).map(element => element.value ?? '').join('\n')}`;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const OVERLAY = /^\s*- (?:dialog|alertdialog|menu|listbox)\b/;
const EDGE = /^\s*- (?:banner|contentinfo)\b/;

/** The page as read for the agent: what is open comes first (a role dialog or a dropdown is the
 * thing being acted on, and sits at the END of a big page, where a cut-off would lose it), a
 * page's header and footer menus are folded to a line, and a very long middle is trimmed.
 * `full` keeps the header and footer and allows a longer view. */
export function arrangeSnapshot(snapshot: string, full = false): string {
  const lines = snapshot.split('\n');
  const end = (from: number): number => { let at = from + 1; while (at < lines.length && indentOf(lines[at]!) > indentOf(lines[from]!)) at++; return at; };
  const hasMain = lines.some(line => /^\s*- main\b/.test(line));
  const kept: string[] = [];
  const overlays: string[] = [];
  let folded = false;
  for (let at = 0; at < lines.length;) {
    const line = lines[at]!;
    if (OVERLAY.test(line)) { const to = end(at); const base = indentOf(line); overlays.push(...lines.slice(at, to).map(item => item.slice(base))); at = to; continue; }
    if (!full && hasMain && EDGE.test(line)) { folded = true; at = end(at); continue; }
    kept.push(line); at++;
  }
  const cap = full ? 40_000 : 14_000;
  let body = kept.join('\n');
  if (body.length > cap) {
    const rows = body.split('\n');
    let head = 0; let headSize = 0;
    while (head < rows.length && headSize < cap * 0.65) headSize += rows[head++]!.length + 1;
    let tail = rows.length; let tailSize = 0;
    while (tail > head && tailSize < cap * 0.35) tailSize += rows[--tail]!.length + 1;
    body = [...rows.slice(0, head), `- (… ${tail - head} lines trimmed from the middle of a long page; scroll, or observe with full: true …)`, ...rows.slice(tail)].join('\n');
  }
  return [overlays.length ? `Open now (dialogs and menus):\n${overlays.join('\n')}\n` : '', body, folded ? '- (header and footer folded away; observe with full: true to see them)' : ''].filter(Boolean).join('\n');
}

export async function observeComputerPage(page: Page, acceptsImages: boolean, full = false): Promise<ToolRunResult> {
  // Login pages remain observable by field name and type. No DOM values,
  // accessibility snapshot or screenshot crosses into the model context.
  if (await privateLoginPage(page)) {
    const fields = await loginFields(page);
    return { output: loginFieldSummary(new URL(page.url()).origin, fields, await pageControls(page)) };
  }
  const raw = await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 } as never) as string;
  // A key the page is showing is not for the model to read: capture_secret takes it.
  const { text: shown, hidden } = hideKeyLikeText(raw);
  const snapshot = arrangeSnapshot(shown, full);
  const output = `Page: ${page.url()}\n\n${snapshot}${hidden ? `\n\n[${hidden} key-like value${hidden === 1 ? '' : 's'} hidden. Use capture_secret to save it without reading it.]` : ''}`;
  if (!acceptsImages) return { output };
  if (hidden || showsSecret(snapshot) || showsSecret(await page.evaluate(visibleText).catch(() => ''))) return { output: `${output}\n\n[Screenshot withheld: the page shows a saved secret.]` };
  let bytes = await page.screenshot({ type: 'jpeg', quality: 65, animations: 'disabled', timeout: 10_000 });
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) bytes = await page.screenshot({ type: 'jpeg', quality: 35, animations: 'disabled', timeout: 10_000 });
  const found = sniffImage(bytes);
  if (!found || bytes.length > MAX_TOOL_IMAGE_BYTES) return { output: `${output}\n\n[Screenshot too large to show.]` };
  return { output, images: [{ mimeType: found.mimeType, data: bytes.toString('base64') }] };
}

/** Wait for what an action started to land, so the view that follows is a finished page, not a spinner. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => undefined);
  await page.waitForTimeout(250).catch(() => undefined);
}

export const computerWebTool = defineTool<WebArgs>({
  name: 'computer_web', class: 'exec',
  description: [
    "Drive ClikCode's own Chrome (its own saved profile; it starts by itself). Every action returns the page as it is now, with a [ref=…] on each element: pass a ref as target (or visible text) to click or fill. Open dialogs come first; a new tab or popup is followed automatically.",
    'Actions: open (a URL) · observe (the page again; full: true adds header and footer) · click · fill · press · scroll · steps (several of those in order, one call, stops at the first failure) · login · handoff · capture_secret · close.',
    'Sign-in pages show only field names. login uses a saved login, or asks the user privately (never ask for a password or code in chat). When a sign-in page offers different ways in (root or IAM, another account), ask the user with ask_user, click their choice, then login. handoff gives the user a phone link for a CAPTCHA or MFA.',
    'Work through the whole task you were given without checking in at each step. Ask real choices (project, account, role set) once, up front, in one question; after that ask only when genuinely blocked (a sign-in they must type, a payment).',
    'API keys: go to the key page, set the options, then capture_secret with target = the final Create button and a send_to plan. It presses the site\'s Copy button or reads the file it hands over, checks the key against its service, saves it to ClikCode Secrets Manager and sends it where send_to says. You never see the key. With no target it takes a key the page already shows; never click Regenerate just to see one.',
  ].join('\n'),
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['open', 'close', 'observe', 'click', 'fill', 'press', 'scroll', 'steps', 'login', 'handoff', 'capture_secret'] },
    url: { type: 'string', description: 'open: the website address.' },
    target: { type: 'string', description: 'click, fill, capture_secret: a [ref=…] from the page view (e5, or f1e2 inside a frame), or the visible text of a sign-in page control.' },
    text: { type: 'string', description: 'fill: the text. Never a credential.' },
    key: { type: 'string', description: 'press: a key such as Enter or Escape.' },
    direction: { type: 'string', enum: ['up', 'down'], description: 'scroll.' },
    steps: { type: 'array', description: 'steps: what to do, in order, e.g. [{do:"fill", target:"e4", text:"My key"}, {do:"click", target:"e9"}].',
      items: { type: 'object', additionalProperties: false, required: ['do'], properties: {
        do: { type: 'string', enum: ['click', 'fill', 'press', 'scroll'] }, target: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down'] }, accept_dialog: { type: 'boolean' },
      } } },
    full: { type: 'boolean', description: 'observe: include the header and footer and a longer view.' },
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
      case 'click': return `Click ${args.target ?? ''}`.trim();
      case 'fill': return `Fill ${args.target ?? ''}`.trim();
      case 'press': return `Press ${args.key ?? ''}`.trim();
      case 'steps': return `${args.steps?.length ?? 0} steps on the page`;
      case 'login': return 'Sign in';
      case 'handoff': return 'Hand off to phone';
      case 'capture_secret': return `Capture key${args.secret_name ? ` as ${args.secret_name}` : ''}`;
      case 'close': return 'Close browser';
      default: return `Web ${args.action}`;
    }
  },
  describe: async (args) => `ClikCode browser: ${args.action}${args.url ? ` ${args.url}` : ''}${args.target ? ` ${args.target}` : ''}${args.action === 'fill' ? ` (${args.text?.length ?? 0} characters)` : ''}`,
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
      if (args.action === 'capture_secret') {
        const why = error instanceof Error ? error.message : String(error);
        // A click that creates a key at the site cannot be undone from here: say so, or a live key is left behind unnoticed.
        const clicked = (error as { afterClick?: boolean }).afterClick ? ` The click on "${args.target ?? 'the button'}" may already have created a key at the site; if so, delete it there.` : '';
        return { output: scrubSecrets(`${why.startsWith('Not saved') ? why : `Not saved: ${why}`}${clicked}`), isError: true };
      }
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  },
});

const INTERACTIONS: ReadonlySet<string> = new Set(['click', 'fill', 'press', 'scroll']);

/** One thing done to the page, in words. Throws with the reason it could not be done. */
async function doStep(page: Page, step: Step): Promise<string> {
  switch (step.do) {
    case 'click': {
      const target = await locate(page, step.target);
      const { dialogs } = await withDialogs(page, step.accept_dialog === true, () => clickOrHint(target));
      return `Clicked ${step.target}.${dialogNote(dialogs, step.accept_dialog === true)}`;
    }
    case 'fill':
      if (typeof step.text !== 'string' || step.text.length > 20_000) throw new Error('Fill needs text of at most 20,000 characters.');
      await (await locate(page, step.target)).fill(step.text, { timeout: 10_000 });
      return `Filled ${step.target}.`;
    case 'press':
      if (!step.key || !/^[A-Za-z0-9+_-]{1,30}$/.test(step.key)) throw new Error('Press needs a simple key.');
      await page.keyboard.press(step.key);
      return `Pressed ${step.key}.`;
    case 'scroll':
      await page.mouse.wheel(0, step.direction === 'up' ? -600 : 600);
      return 'Scrolled.';
    default: throw new Error(`Unknown step "${String((step as { do?: unknown }).do)}".`);
  }
}

/** Does the steps in order, following a new tab or popup, and returns the page as it ends up. */
async function runSteps(page: Page, steps: readonly Step[], ctx: ToolContext): Promise<ToolRunResult> {
  const notes: string[] = [];
  let current = page;
  for (const [index, step] of steps.entries()) {
    try {
      notes.push(await doStep(current, step));
      await settle(current);
    } catch (error) {
      const view = await observeComputerPage(current, false).catch(() => undefined);
      return { output: `${[...notes, `Step ${index + 1} (${step.do}${step.target ? ` ${step.target}` : ''}) failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`].join('\n')}${view ? `\n\n${view.output}` : ''}`, isError: true };
    }
    const next = await frontPage(current.context());
    if (next && next !== current && !next.isClosed()) {
      current = next;
      await settle(current);
      notes.push(`A new tab opened and is now the page: ${current.url()}`);
    }
  }
  const view = await observeComputerPage(current, false);
  return { output: `${notes.join('\n')}\n\n${view.output}` };
}

async function act(page: Page, args: WebArgs, ctx: ToolContext): Promise<ToolRunResult> {
  if (INTERACTIONS.has(args.action)) {
    const one: Step = { do: args.action as Step['do'], ...(args.target ? { target: args.target } : {}), ...(args.text !== undefined ? { text: args.text } : {}), ...(args.key ? { key: args.key } : {}), ...(args.direction ? { direction: args.direction } : {}), ...(args.accept_dialog ? { accept_dialog: true } : {}) };
    return runSteps(page, [one], ctx);
  }
  switch (args.action) {
    case 'open': await page.goto(webAddress(args.url), { waitUntil: 'domcontentloaded', timeout: 30_000 }); await settle(page); return observeComputerPage(page, ctx.acceptsImages === true);
    case 'observe': return observeComputerPage(page, ctx.acceptsImages === true, args.full === true);
    case 'steps':
      if (!args.steps?.length) throw new Error('steps needs a list, e.g. [{"do":"click","target":"e5"}].');
      return runSteps(page, args.steps, ctx);
    case 'login': {
      const outcome = await loginComputerPage({ stateDir: ctx.stateDir, page, signal: ctx.signal, newAccount: args.new_account === true,
        ask: async (site, fields, signal) => {
          if (!ctx.requestPrivateLogin) throw new LoginError('This chat cannot show private login fields.');
          return ctx.requestPrivateLogin(site, fields, signal);
        }, onVerification: () => ctx.emitOutput?.('Approve the sign-in or finish verification in the open browser.\n') });
      const failed = outcome === 'unverified' || outcome === 'saved_login_rejected';
      // Signed in: the page you landed on comes with it, so there is nothing more to ask for.
      const landed = failed ? undefined : await (async () => {
        try { return await observeComputerPage(await frontPage(page.context()) ?? page, false); }
        catch { return undefined; } // the sign-in worked whether or not the page can be read
      })();
      return { output: `${loginOutcomeMessage(outcome)}${landed ? `\n\n${landed.output}` : ''}`, ...(failed ? { isError: true } : {}) };
    }
    case 'capture_secret': {
      // Before anything is clicked: a key must not be created for a plan that cannot deliver it.
      const plan = normalizeSendTo(args.send_to);
      const planProblem = plan?.length ? await destinationProblem(ctx.stateDir, plan) : undefined;
      if (planProblem) throw new Error(`${planProblem} Nothing was clicked.`);
      const name = args.secret_name?.trim() || `${new URL(page.url()).hostname.replace(/^www\./, '')}/key`;
      const { length, found, check, sent } = await captureSecret({ stateDir: ctx.stateDir, page, name, signal: ctx.signal,
        ...(plan?.length ? { sendTo: plan } : {}),
        ...(args.target ? { trigger: async () => { await clickOrHint(await locate(page, args.target)); } } : {}),
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
    default: throw new Error('Unknown web action.');
  }
}

/** A native dialog or separate popup window is outside the page, so a click
 * that never lands is most often that: point the agent at the desktop tool. */
async function clickOrHint(target: Locator): Promise<void> {
  try { await press(target); }
  catch (error) {
    if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
    throw new Error(`${error.message.split('\n')[0]} If a popup window or browser dialog is in front of the page, use computer_desktop to see and answer it.`);
  }
}
