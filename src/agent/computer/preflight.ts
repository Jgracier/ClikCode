/** `clikcode computer preflight`: one deterministic check that the machine can do onboarding work, with no agent in it.
 *
 * It answers five questions with a yes or no and, for each no, one line of why:
 *   browserOk       ClikCode's Chrome starts and opens a tab.
 *   googleSignedIn  accounts.google.com, opened in a throwaway tab, lands on the account (signed in) and not on the sign-in form.
 *   gmailReadable   Gmail's inbox view renders in that tab (so sign-up codes and links can be read).
 *   buildId         the commit (else the version) of the running build.
 *   depsLinkOk      the installed release's node_modules link resolves playwright-core and yaml and is not inside the temp folder
 *                   (a link into /tmp breaks the installed CLI on the next cleanup or reboot).
 * Only the page's address and whether a few controls exist are looked at: no page text, field value or cookie is read.
 * Nothing here throws; a check that cannot run is a no with its reason. */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { CLIKCODE_COMMIT, CLIKCODE_VERSION } from '../../version.js';
import { runCli } from './run-cli.js';
import { defaultProfile, listProfiles } from './profiles.js';
import { firstJsonObject } from './secret-destinations.js';

export type PreflightResult = {
  browserOk: boolean; googleSignedIn: boolean; gmailReadable: boolean; buildId: string; depsLinkOk: boolean;
  /** All four checks pass. */
  ok: boolean;
  /** One line for each check that failed. */
  reasons: string[];
  checkedAt: string;
  /** Where the result went in ClikDeploy: `posted`, `not posted: connector_preflight does not exist there`, ... */
  clikdeploy?: string;
};

/** The few things of a page this check touches. A real Playwright Page satisfies it. */
export type PreflightPage = {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  url(): string;
  locator(selector: string): { count(): Promise<number>; first(): { waitFor(options: { timeout: number }): Promise<unknown> } };
  waitForLoadState?(state: 'load', options: { timeout: number }): Promise<unknown>;
  close(): Promise<unknown>;
};

/** Where a visit to accounts.google.com ended: signed in, or at a sign-in step. By address and the presence of an
 * email box, never by reading the page. */
export function classifyGoogleSignIn(url: string, controls: { emailBox: boolean }): { signedIn: boolean; reason?: string } {
  let at: URL;
  try { at = new URL(url); } catch { return { signedIn: false, reason: 'the browser did not reach Google (no address)' }; }
  if (at.hostname === 'myaccount.google.com' || at.hostname.endsWith('.myaccount.google.com')) return { signedIn: true };
  if (at.hostname !== 'accounts.google.com') return { signedIn: false, reason: `the browser ended on ${at.hostname || 'a blank page'}, not on a Google account page` };
  if (/accountchooser/i.test(at.pathname)) return { signedIn: false, reason: 'Google shows its account chooser: the session has expired or no account is signed in' };
  if (controls.emailBox || /signin|identifier|servicelogin|challenge/i.test(at.pathname)) return { signedIn: false, reason: 'Google shows its sign-in form: no account is signed in in ClikCode\'s browser' };
  // accounts.google.com with no sign-in step is the account home a signed-in browser is sent to.
  return { signedIn: true };
}

/** Gmail's inbox view, not a sign-in page. */
export function classifyGmail(url: string, rendered: boolean): { readable: boolean; reason?: string } {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* no address */ }
  if (host === 'accounts.google.com') return { readable: false, reason: 'Gmail sent the browser to Google sign-in' };
  if (host !== 'mail.google.com') return { readable: false, reason: `Gmail did not open (the browser is on ${host || 'a blank page'})` };
  return rendered ? { readable: true } : { readable: false, reason: 'Gmail opened but its inbox did not render in time' };
}

/** Whether a release folder's node_modules link will keep working: it resolves, holds playwright-core and yaml, and is not in the temp folder. */
export function checkDepsLink(releaseDir: string | undefined, temp: string = tmpdir()): { ok: boolean; reason?: string; target?: string } {
  if (!releaseDir || !existsSync(releaseDir)) return { ok: false, reason: 'no installed release found (run: node scripts/install-local.mjs)' };
  const link = path.join(releaseDir, 'node_modules');
  let target: string;
  try { lstatSync(link); target = realpathSync(link); } catch { return { ok: false, reason: `${link} is missing or points at nothing` }; }
  const tempReal = (() => { try { return realpathSync(temp); } catch { return temp; } })();
  if (target === tempReal || target.startsWith(`${tempReal}${path.sep}`)) return { ok: false, target, reason: `${link} resolves into the temp folder (${target}); reinstall from a checkout with its own node_modules` };
  const need = createRequire(path.join(releaseDir, 'package.json'));
  for (const name of ['playwright-core', 'yaml']) {
    try { need.resolve(`${name}/package.json`); } catch { return { ok: false, target, reason: `${name} does not resolve from ${link}` }; }
  }
  return { ok: true, target };
}

/** The installed release (where the `clikcode` command lives), if there is one. */
export function installedReleaseDir(): string | undefined {
  const dir = process.env.CLIKCODE_RELEASE_DIR || path.join(homedir(), '.local', 'share', 'clikcode', 'release');
  return existsSync(dir) ? dir : undefined;
}

export type PreflightDeps = {
  stateDir: string;
  /** A tab for the check, closed by it. */
  openPage: () => Promise<PreflightPage>;
  releaseDir?: string | undefined;
  temp?: string;
  /** Reports the result to ClikDeploy; absent means it is not tried. Returns one line. */
  post?: (result: PreflightResult) => Promise<string>;
  buildId?: string;
};

const settle = async (page: PreflightPage): Promise<void> => { await page.waitForLoadState?.('load', { timeout: 8_000 }).catch(() => undefined); };

export async function runPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const reasons: string[] = [];
  const buildId = deps.buildId ?? CLIKCODE_COMMIT ?? `${CLIKCODE_VERSION}-nocommit`;
  let browserOk = false; let googleSignedIn = false; let gmailReadable = false;
  let page: PreflightPage | undefined;
  try { page = await deps.openPage(); browserOk = true; }
  catch (error) { reasons.push(`browserOk: ${oneLine(error)}`); }
  if (page) {
    try {
      try {
        await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await settle(page);
        const verdict = classifyGoogleSignIn(page.url(), { emailBox: await page.locator('input[type="email"], #identifierId').count().then(n => n > 0, () => false) });
        googleSignedIn = verdict.signedIn;
        if (!verdict.signedIn) reasons.push(`googleSignedIn: ${verdict.reason}`);
      } catch (error) { reasons.push(`googleSignedIn: ${oneLine(error)}`); }
      if (googleSignedIn) {
        try {
          // The mailbox is the default profile's sign-in account, as the email tools use it.
          const mailbox = (defaultProfile(await listProfiles(deps.stateDir).catch(() => []))?.fields.sso_email) || '0';
          await page.goto(`https://mail.google.com/mail/u/${encodeURIComponent(mailbox)}/#inbox`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const rendered = await page.locator('[role="main"], tr.zA').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
          const verdict = classifyGmail(page.url(), rendered);
          gmailReadable = verdict.readable;
          if (!verdict.readable) reasons.push(`gmailReadable: ${verdict.reason}`);
        } catch (error) { reasons.push(`gmailReadable: ${oneLine(error)}`); }
      } else reasons.push('gmailReadable: not checked, Google is not signed in');
    } finally { await page.close().catch(() => undefined); }
  } else reasons.push('googleSignedIn: not checked, the browser did not start', 'gmailReadable: not checked, the browser did not start');
  const deps_ = checkDepsLink('releaseDir' in deps ? deps.releaseDir : installedReleaseDir(), deps.temp);
  if (!deps_.ok) reasons.push(`depsLinkOk: ${deps_.reason}`);
  const result: PreflightResult = { browserOk, googleSignedIn, gmailReadable, buildId, depsLinkOk: deps_.ok, ok: browserOk && googleSignedIn && gmailReadable && deps_.ok, reasons, checkedAt: new Date().toISOString() };
  if (deps.post) result.clikdeploy = await deps.post(result).catch(error => `not posted: ${oneLine(error)}`);
  return result;
}

const oneLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);

/** Report a result to ClikDeploy's connector_preflight tool when ClikDeploy has one; otherwise say so. Never blocks the check for long. */
export async function postToClikDeploy(result: PreflightResult, signal?: AbortSignal): Promise<string> {
  const found = await runCli('clikdeploy', ['tools', 'search', 'connector_preflight'], { signal, timeoutMs: 20_000 });
  if (found.missing) return 'not posted: the clikdeploy command is not installed here';
  const listed = firstJsonObject<{ data?: { name?: string }[] }>(found.text)?.data;
  if (!Array.isArray(listed)) return 'not posted: could not ask ClikDeploy which tools exist';
  if (!listed.some(tool => tool.name === 'connector_preflight')) return 'not posted: ClikDeploy has no connector_preflight tool yet';
  const { clikdeploy: _skip, ...body } = result;
  const sent = await runCli('clikdeploy', ['tools', 'run', 'connector_preflight', '--args-json', '-', '--confirm'], { stdin: JSON.stringify(body), signal, timeoutMs: 30_000 });
  const reply = firstJsonObject<{ status?: string; message?: string }>(sent.text);
  return sent.code === 0 && reply?.status !== 'error' ? 'posted' : `not posted: ${(reply?.message ?? sent.text.trim() ?? 'no answer').split('\n')[0]!.slice(0, 160)}`;
}

/** The real run: ClikCode's Chrome, the installed release, ClikDeploy. */
export async function runPreflightHere(stateDir: string, options: { post?: boolean; signal?: AbortSignal } = {}): Promise<PreflightResult> {
  const { throwawayComputerPage } = await import('./browser.js');
  return runPreflight({ stateDir, openPage: () => throwawayComputerPage(stateDir) as unknown as Promise<PreflightPage>,
    ...(options.post === false ? {} : { post: result => postToClikDeploy(result, options.signal) }) });
}
