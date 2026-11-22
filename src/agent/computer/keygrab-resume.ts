/** `clikcode computer keygrab-resume <name>`: reattach to the hidden tab a keygrab run left open, optionally press one thing or go to one address,
 * and carry on with keygrab from there. The recorder journal parked with the tab is restored, so a key captured here saves the recipe
 * like an uninterrupted run would. When it still cannot finish, the tab is left parked again with a fresh record. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { DriveOutcome, KeygrabDelivery } from './keygrab-types.js';
import { DEFAULT_TAB, liveKeygrab, liveKeygrabPort } from './keygrab-live.js';
import { loadParked, markerFor, type ParkedRecord } from './keygrab-park.js';

interface ResumeOptions { stateDir: string; id: string; delivery?: KeygrabDelivery; click?: string; goto?: string; /** Press or go, then report the page without running keygrab (a form that needs several plain presses). */ only?: boolean; maxMs?: number; maxSteps?: number; signal?: AbortSignal; screenshotDir?: () => Promise<string> }
interface ResumeResult { id: string; reattached: 'tab' | 'reopened'; pressed?: string; outcome: DriveOutcome; record: ParkedRecord }

export async function resumeKeygrab(options: ResumeOptions): Promise<ResumeResult> {
  const record = await loadParked(options.stateDir, options.id);
  if (!record) throw new Error(`Nothing is parked for ${options.id}: run \`clikcode computer keygrab ${options.id} <url>\` first (a run that cannot finish leaves its tab parked).`);
  if (options.goto && !/^https:\/\/[^\s]+$/.test(options.goto)) throw new Error('--goto is an https address.');
  const browser = await import('./browser.js');
  // The run's own tab and delivery: a key captured here goes where the caller of the first run asked, from the tab it used.
  const tab = record.tab ?? DEFAULT_TAB;
  const delivery = options.delivery ?? record.delivery;
  let reattached: ResumeResult['reattached'] = 'tab';
  const found = await browser.reattachParkedPage(options.stateDir, tab, markerFor(options.id));
  if (!found) {
    // The tab is gone (the browser was restarted): the profile keeps the sign-in, so open the last page again.
    reattached = 'reopened';
    await browser.openComputerPage(options.stateDir, tab);
    const port = await liveKeygrabPort({ stateDir: options.stateDir, id: options.id, tab, ...(delivery ? { delivery } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    const err = await port.open(record.url.startsWith('https://') ? record.url : record.vendorUrl);
    if (err) throw new Error(`The parked tab is gone and its last page could not be reopened: ${err}`);
  }
  // The recorder's journal rides with the tab, so a key captured after this carries the whole path into the recipe.
  if (record.journal) (await import('./recipe-recorder.js')).importJournal(`${options.stateDir}#${tab}`, record.journal);
  let pressed: string | undefined;
  if (options.click || options.goto) {
    const port = await liveKeygrabPort({ stateDir: options.stateDir, id: options.id, tab, ...(delivery ? { delivery } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    const err = options.goto ? await port.open(options.goto) : await port.click(options.click!);
    pressed = options.goto ? `goto ${options.goto}` : `click ${options.click}`;
    if (err) {
      await browser.parkComputerPage(options.stateDir, tab, markerFor(options.id));
      await browser.releaseComputerBrowser(options.stateDir).catch(quiet('agent/computer/keygrab-resume'));
      return { id: options.id, reattached, pressed, record, outcome: { ok: false, stop: { kind: 'unknown', message: `${pressed} failed: ${err}`.slice(0, 300), url: record.url, pageText: '', controls: record.controls, trail: record.trail, parked: true, vendorUrl: record.vendorUrl, visited: record.visited, menus: record.menus } } };
    }
    // Keep what the press did in the carried-over trail.
    record.trail = [...record.trail, pressed].slice(-40);
  }
  if (options.only) {
    const port = await liveKeygrabPort({ stateDir: options.stateDir, id: options.id, tab, ...(delivery ? { delivery } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    const seen = await port.look();
    const { pageExcerpt } = await import('./oauth-consent.js');
    const { safeControlNames } = await import('./keygrab.js');
    const { hideKeyLikeText } = await import('./secret-finder.js');
    const { exportJournal } = await import('./recipe-recorder.js');
    const { saveParked } = await import('./keygrab-park.js');
    const trail = [...record.trail, ...(pressed ? [pressed] : [])].slice(-40);
    let url = seen.url; try { const u = new URL(seen.url); url = `${u.origin}${u.pathname}`; } catch { /* fail-open-ok: keep as is */ }
    const journal = exportJournal(`${options.stateDir}#${tab}`);
    const next: ParkedRecord = { ...record, tab, ...(delivery ? { delivery } : {}), parkedAt: new Date().toISOString(), url, trail, controls: safeControlNames(seen.controls.filter(c => !c.leaf), 40), ...(journal ? { journal } : {}) };
    await browser.parkComputerPage(options.stateDir, tab, markerFor(options.id));
    await saveParked(options.stateDir, next);
    await browser.releaseComputerBrowser(options.stateDir).catch(quiet('agent/computer/keygrab-resume'));
    return { id: options.id, reattached, ...(pressed ? { pressed } : {}), record: next, outcome: { ok: false, stop: { kind: 'unknown', message: `${pressed ?? 'nothing'} pressed; keygrab was not run (--only)`, url, pageText: pageExcerpt(hideKeyLikeText(seen.text).text), controls: safeControlNames(seen.controls, 60), trail, parked: true, vendorUrl: record.vendorUrl, visited: record.visited, menus: record.menus } } };
  }
  const outcome = await liveKeygrab(
    { stateDir: options.stateDir, tab, ...(delivery ? { delivery } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.screenshotDir ? { screenshotDir: options.screenshotDir } : {}) },
    options.id, record.vendorUrl, { maxMs: options.maxMs ?? 240_000, ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}), ...(record.alternates?.length ? { alternates: record.alternates } : {}), resume: record },
  );
  return { id: options.id, reattached, ...(pressed ? { pressed } : {}), outcome, record };
}
