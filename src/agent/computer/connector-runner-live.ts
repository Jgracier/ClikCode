/** The real ports of the connector runner: ClikDeploy through its CLI (the saved admin key is its own sign-in), the ClikCode browser
 * through the consent driver and the saved signup recipes. Nothing here prints or logs a key. The arguments (ids, plain-words reasons and notes) hold no secret, so they go on the command line: clikdeploy 1.0.34 cannot read them from stdin. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { BrowserDriver, DeployClient, DriveOutcome, OnboardResult, StopInfo } from './connector-runner.js';
import { runCli } from './run-cli.js';
import { scrubSecrets } from './secret-scrubber.js';

export const WORKER = 'cc-runner';

/** The `data` of a `clikdeploy tools run` answer, or the error it gave. */
export function unwrapTool(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(scrubSecrets(text.trim().split('\n').slice(-2).join(' ').slice(0, 200)) || 'ClikDeploy gave no answer');
  let envelope: { status?: string; message?: string; error?: { message?: string }; data?: { success?: boolean; error?: unknown; data?: unknown } };
  try { envelope = JSON.parse(text.slice(start)); } catch { throw new Error('ClikDeploy gave an answer that is not JSON'); }
  if (envelope.status === 'error' || envelope.data?.success === false) {
    const said = envelope.error?.message ?? envelope.message ?? (typeof envelope.data?.error === 'string' ? envelope.data.error : (envelope.data?.error as { message?: string } | undefined)?.message);
    throw new Error(scrubSecrets(String(said ?? 'ClikDeploy refused').split('\n')[0]!).slice(0, 240));
  }
  return envelope.data && 'data' in envelope.data ? envelope.data.data : envelope.data ?? envelope;
}

function findResults(value: unknown): { results: OnboardResult[]; skipped: Array<{ id: string; why: string }> } {
  const walk = (v: unknown): Record<string, unknown> | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const r = v as Record<string, unknown>;
    if (Array.isArray(r.results)) return r;
    for (const child of Object.values(r)) { const found = walk(child); if (found) return found; }
    return undefined;
  };
  const found = walk(value);
  return { results: (found?.results as OnboardResult[] | undefined) ?? [], skipped: (found?.skipped as Array<{ id: string; why: string }> | undefined) ?? [] };
}

export function liveClient(signal?: AbortSignal): DeployClient {
  const call = async (name: string, args: Record<string, unknown>, timeoutMs = 90_000): Promise<unknown> => {
    const run = await runCli('clikdeploy', ['tools', 'run', name, '--args-json', JSON.stringify(args), '--confirm'], { ...(signal ? { signal } : {}), timeoutMs });
    if (run.missing) throw new Error('The clikdeploy command is not installed on this computer.');
    return unwrapTool(run.text);
  };
  const withLease = async (id: string, run: () => Promise<unknown>): Promise<void> => {
    try { await run(); } catch (error) {
      if (!/lease/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await call('connector_work_claim', { id, worker: WORKER });
      await run();
    }
  };
  return {
    async waiting() {
      const data = await call('connector_pipeline_status', {}) as { status?: { needsAgent?: Array<{ id: string; reason: string; task: string }> } };
      return data.status?.needsAgent ?? [];
    },
    async batch(input) { return findResults(await call('connector_onboard_batch', { ...input, worker: WORKER }, 120_000)); },
    async onboard(id) {
      const data = await call('connector_onboard', { id, worker: WORKER }, 120_000);
      const result = findOnboard(data);
      if (!result) throw new Error(`connector_onboard gave no result for ${id}`);
      return result;
    },
    // A step that hands the lease back leaves the item unclaimed; a note or report needs a lease, so claim it again once and retry.
    async report(input) { await withLease(input.id, () => call('connector_work_report', { ...input, worker: WORKER })); },
    async note(id, text) { await withLease(id, () => call('connector_work_note', { id, text, append: true, worker: WORKER })); },
    tool: (name, args) => call(name, args, 100_000),
  };
}

function findOnboard(value: unknown): OnboardResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.id === 'string' && typeof r.state === 'string' && r.next) return r as unknown as OnboardResult;
  for (const child of Object.values(r)) { const found = findOnboard(child); if (found) return found; }
  return undefined;
}

export interface LiveDriverOptions { stateDir: string; signal?: AbortSignal; screenshotDir?: () => Promise<string> }

/** Page text and the names of what can be pressed, for a stop that has no detail of its own. */
async function look(page: Page): Promise<{ text: string; controls: string[] }> {
  const text = await page.evaluate(() => ((globalThis as unknown as { document: { body?: { innerText?: string } } }).document.body?.innerText ?? '').slice(0, 4000)).catch(() => '');
  const controls = await page.evaluate(() => Array.from((globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document.querySelectorAll('button, [role=button], a')).map(n => (n.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length <= 60).slice(0, 12)).catch(() => [] as string[]);
  return { text, controls };
}

async function shoot(page: Page | undefined, id: string, dir: () => Promise<string>): Promise<string | undefined> {
  if (!page || page.isClosed()) return undefined;
  try { const path = join(await dir(), `${id}.png`); await page.screenshot({ path, timeout: 10_000 }); return path; } catch { return undefined; }
}

export function liveDriver(options: LiveDriverOptions): BrowserDriver {
  const shotDir = options.screenshotDir ?? (() => mkdtemp(join(tmpdir(), 'clikcode-connector-shots-')));
  return {
    async oauthConnect(id): Promise<DriveOutcome> {
      const { oauthConnect, ConsentStop, pageExcerpt } = await import('./oauth-consent.js');
      const { openNewComputerPage, closeOwnedPage, closeComputerPage, releaseComputerBrowser } = await import('./browser.js');
      const { listProfiles } = await import('./profiles.js');
      const email = (await listProfiles(options.stateDir)).map(profile => profile.fields.sso_email).find(Boolean);
      // A fresh tab this run owns, closed afterwards; the consent driver reopens one if Google asks to re-verify.
      let page = await openNewComputerPage(options.stateDir, 'connectors');
      const reopen = async (old: typeof page): Promise<typeof page> => { await closeOwnedPage(options.stateDir, old, 'connectors').catch(quiet('agent/computer/connector-runner-live')); page = await openNewComputerPage(options.stateDir, 'connectors'); return page; };
      try {
        const done = await oauthConnect(id, page, { email, stateDir: options.stateDir, reopen, ...(options.signal ? { signal: options.signal } : {}) });
        return { ok: true, note: `consent finished: ${done.steps.length} presses, ClikDeploy shows an active connection` };
      } catch (error) {
        const message = scrubSecrets(error instanceof Error ? error.message : String(error));
        if (!(error instanceof ConsentStop)) return { ok: false, stop: { kind: 'unknown', message: message.slice(0, 300), url: '', pageText: '', controls: [] } };
        const looked = error.detail ? undefined : await look(page);
        const seen: Pick<StopInfo, 'kind' | 'url' | 'pageText' | 'controls'> = error.detail ?? { kind: 'unknown', url: '', pageText: pageExcerpt(looked?.text ?? ''), controls: looked?.controls ?? [] };
        const screenshot = await shoot(page, id, shotDir);
        return { ok: false, stop: { ...seen, message: message.slice(0, 300), ...(screenshot ? { screenshot } : {}) } };
      } finally {
        await closeComputerPage(options.stateDir, 'connectors').catch(quiet('agent/computer/connector-runner-live'));
        await releaseComputerBrowser(options.stateDir).catch(quiet('agent/computer/connector-runner-live'));
      }
    },
    async backoff(id) { return (await import('./keygrab-park.js')).backoffUntil(options.stateDir, id); },
    async recordBackoff(id) { return (await import('./keygrab-park.js')).recordBackoff(options.stateDir, id); },
    async hasRecipe(id, url) {
      const { listRecipes } = await import('./signup-recipes.js');
      return !!(await findRecipe(options.stateDir, id, url, listRecipes));
    },
    async keygrab(id, url, budget): Promise<DriveOutcome> {
      const { liveKeygrab } = await import('./keygrab-live.js');
      return liveKeygrab({ stateDir: options.stateDir, ...(options.signal ? { signal: options.signal } : {}), screenshotDir: shotDir }, id, url, budget);
    },
    async captureKey(id, url): Promise<DriveOutcome> {
      const { listRecipes } = await import('./signup-recipes.js');
      const recipe = await findRecipe(options.stateDir, id, url, listRecipes);
      if (!recipe) return { ok: false, stop: { kind: 'unknown', message: 'no saved recipe fits this connector', url: '', pageText: '', controls: [] } };
      const { computerWebTool } = await import('../tools/computer-web.js');
      const { detectBlocker } = await import('./signup-recipes.js');
      const ctx = { stateDir: options.stateDir, ...(options.signal ? { signal: options.signal } : {}) } as Parameters<typeof computerWebTool.run>[1];
      const run = (args: Record<string, unknown>) => computerWebTool.run({ tab: 'connectors', ...args } as never, ctx);
      const stop = async (message: string): Promise<DriveOutcome> => {
        const { computerPage } = await import('./browser.js');
        const { pageExcerpt } = await import('./oauth-consent.js');
        const page = await computerPage(options.stateDir, 'connectors').catch(quiet('agent/computer/connector-runner-live'));
        const seen = page ? await look(page) : { text: '', controls: [] as string[] };
        const blocker = detectBlocker(seen.text);
        const kind: StopInfo['kind'] = blocker === 'a captcha' ? 'captcha' : blocker === 'an SMS or authenticator code' ? 'mfa' : blocker === 'a payment page' ? 'payment' : 'unknown';
        const screenshot = await shoot(page, id, shotDir);
        let pageUrl = '';
        try { pageUrl = page ? new URL(page.url()).origin + new URL(page.url()).pathname : ''; } catch { /* none */ }
        return { ok: false, stop: { kind, message: scrubSecrets(message).slice(0, 300), url: pageUrl, pageText: pageExcerpt(seen.text), controls: seen.controls, ...(screenshot ? { screenshot } : {}) } };
      };
      try {
        const opened = await run({ action: 'open', url: recipe.keyPage ?? `https://${recipe.host}` });
        if (opened.isError) return await stop(opened.output);
        const replayed = await run({ action: 'recipe', recipe_op: 'run', host: recipe.host, login_route: recipe.loginRoute });
        if (replayed.isError) return await stop(replayed.output);
        const label = /"([^"]{2,60})"/.exec(recipe.captureHint ?? '')?.[1];
        const captured = await run({ action: 'capture_secret', ...(label ? { target: label } : {}), secret_name: `${id}/key`, vendor: id, send_to: [{ to: 'clikdeploy-connection', with: { integration: id } }] });
        if (captured.isError) return await stop(captured.output);
        return { ok: true, note: 'key captured and sent to ClikDeploy; it was not shown' };
      } finally {
        const { closeComputerPage, releaseComputerBrowser } = await import('./browser.js');
        await closeComputerPage(options.stateDir, 'connectors').catch(quiet('agent/computer/connector-runner-live'));
        await releaseComputerBrowser(options.stateDir).catch(quiet('agent/computer/connector-runner-live'));
      }
    },
  };
}

async function findRecipe(stateDir: string, id: string, url: string | undefined, listRecipes: typeof import('./signup-recipes.js').listRecipes) {
  const all = await listRecipes(stateDir);
  let host = '';
  try { host = new URL(url ?? '').hostname.replace(/^www\./, ''); } catch { host = ''; }
  return all.find(r => host && (r.host === host || host.endsWith(`.${r.host}`))) ?? all.find(r => r.keyPage && r.host.split('.').some(part => part === id || id.startsWith(`${part}-`) && part.length > 3));
}
