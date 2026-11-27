/** Who owns each tab of the shared Chrome, and when it was last used.
 *
 * MEASURED 2026-10-31: the hidden Chrome had run 2d11h with 139 processes and 41 renderers older than two days. Tabs named
 * with `tab: "<label>"` by parallel workers and sub-agents were never closed when the worker ended, and the owner's map of
 * pages lives in that worker's memory, so no other chat could list or close them.
 *
 * Every worker writes one small file per tab it holds (`computer/tabs/<targetId>.json`): the owner process, the label, when it
 * was opened and last used. A sweep, run by the browser host, by any worker using the browser, and by `clikcode doctor`, reads
 * them next to the browser's own target list (the DevTools HTTP endpoint, no Playwright needed) and closes what no one holds:
 * a tab whose owner process has ended, a tab no one recorded, a tab idle past a limit, and past a cap the tabs no one is working in.
 * Every close is logged.
 *
 * MEASURED 2026-11-27: one-shot `computer page read` commands left a tab behind per call, unrecorded (the record write raced the
 * process exit). Each sweeping process kept "first seen" for those in its own memory, so to a short-lived sweeper they were always
 * new: they outlived the cap while live agents' tabs, idle a dozen seconds between two clicks, were closed for it (5 closures of one
 * checkout in 8 minutes). Now a tab no one recorded gets a stand-in record on disk, so every process sees its true age, and it goes
 * after a short grace; the cap takes unrecorded and ownerless tabs first and never a running owner's working tab. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { lifecycle, quiet, swallowed } from '../../runtime/lifecycle-log.js';
import { pidIsAlive } from '../../session/store/locks.js';
import { atomicWriteFile } from '../../session/store/files.js';
import { deskHeldTargets } from './handoff-desk-store.js';

export interface TabRecord {
  /** The browser's own id for the page (CDP target id). */
  id: string;
  /** The `tab` name the agent gave; absent for a chat's default tab. */
  tab?: string;
  /** The worker process that holds the Page. 0: held by no process (a tab restored after a recycle, a parked tab). */
  ownerPid: number;
  /** A readable owner, for lists: "worker 1234 (session abc)". */
  owner: string;
  openedAt: number;
  lastUsedAt: number;
  url?: string;
  /** Kept open for a later command (a keygrab waiting for the user): exempt from owner and idle closing, until PARKED_MS. */
  parked?: boolean;
  /** A tab the host reopened after a recycle, for the worker that names this label to claim. */
  restoreFor?: string;
  /** The egress the page's traffic leaves through (egress.ts); absent for home. A recycle restores it into that egress's context. */
  egress?: string;
  /** The address a live view of this tab is served at (show), while one is. */
  liveView?: string;
  /** A stand-in written by a sweep for a page no worker recorded: `openedAt` is when a sweep first saw it. A worker's own record
   * replaces it. */
  unrecorded?: boolean;
  /** The browser host's own blank page, kept so Chrome never quits for its last tab closing (browser-host.ts). Never closed by a
   * sweep or a cap while the host lives, and not counted toward the cap. */
  anchor?: boolean;
}

export interface BrowserTarget { id: string; type: string; url: string; title?: string }

interface TabLimits { idleMs: number; maxTabs: number }

const envNumber = (name: string, fallback: number, env: NodeJS.ProcessEnv): number => {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** 20 minutes idle, 12 tabs. CLIKCODE_BROWSER_TAB_IDLE_MS and CLIKCODE_BROWSER_MAX_TABS change them. */
export function tabLimits(env: NodeJS.ProcessEnv = process.env): TabLimits {
  return { idleMs: envNumber('CLIKCODE_BROWSER_TAB_IDLE_MS', 20 * 60_000, env), maxTabs: Math.floor(envNumber('CLIKCODE_BROWSER_MAX_TABS', 12, env)) };
}

const PARKED_MS = 6 * 3_600_000;
/** A tab used this recently is never evicted for the cap. */
export const ACTIVE_MS = 10_000;
/** A page no one has recorded for this long is no one's: a worker writes its record before its open returns. */
export const UNRECORDED_GRACE_MS = 30_000;

const tabsDirectory = (stateDir: string): string => path.join(stateDir, 'computer', 'tabs');
const tabFile = (stateDir: string, id: string): string => path.join(tabsDirectory(stateDir), `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export async function writeTabRecord(stateDir: string, record: TabRecord): Promise<void> {
  try {
    await atomicWriteFile(tabFile(stateDir, record.id), JSON.stringify(record), { durable: false });
  } catch (error) { quiet('agent/computer/tab-registry')(error); }
}

/** A stand-in for a page no worker recorded, written only when no record exists (a worker's own record always wins). */
async function writeStandIn(stateDir: string, record: TabRecord): Promise<void> {
  try {
    await fs.mkdir(tabsDirectory(stateDir), { recursive: true });
    await fs.writeFile(tabFile(stateDir, record.id), JSON.stringify(record), { flag: 'wx' });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') quiet('agent/computer/tab-registry')(error); }
}

async function removeTabRecord(stateDir: string, id: string): Promise<void> {
  await fs.unlink(tabFile(stateDir, id)).catch(quiet('agent/computer/tab-registry'));
}

export async function readTabRecords(stateDir: string): Promise<TabRecord[]> {
  const names = await fs.readdir(tabsDirectory(stateDir)).catch(() => [] as string[]);
  const records: TabRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(tabsDirectory(stateDir), name), 'utf8')) as TabRecord;
      if (typeof record.id === 'string' && Number.isFinite(record.lastUsedAt) && Number.isFinite(record.openedAt)) records.push(record);
    } catch (error) { /* being rewritten, or damaged: the next sweep sees it whole */ swallowed('agent/computer/tab-registry', error); }
  }
  return records;
}

type CloseReason = 'owner ended' | 'not recorded' | 'idle' | 'over the tab cap' | 'asked to close';
interface Closure { id: string; reason: CloseReason }

/** Which tabs to close, and which records to forget (their page is gone). Pure.
 * `records` should already include a stand-in record for each page Chrome has that no worker recorded. */
export function planTabClosures(input: {
  records: readonly TabRecord[]; liveIds: ReadonlySet<string>; now: number; limits: TabLimits; alive: (pid: number) => boolean;
  /** Tabs the handoff desk holds for the user: never closed here, whatever their owner or age. */
  deskHeld?: ReadonlySet<string>;
}): { close: Closure[]; forget: string[] } {
  const { records, liveIds, now, limits, alive } = input;
  const deskHeld = input.deskHeld ?? new Set<string>();
  const forget = records.filter(record => !liveIds.has(record.id)).map(record => record.id);
  const live = records.filter(record => liveIds.has(record.id));
  const close: Closure[] = [];
  const kept: TabRecord[] = [];
  for (const record of live) {
    const idle = now - record.lastUsedAt;
    if (record.anchor && alive(record.ownerPid)) continue;
    if (deskHeld.has(record.id)) kept.push(record);
    else if (record.parked) {
      if (idle >= PARKED_MS) close.push({ id: record.id, reason: 'idle' }); else kept.push(record);
    } else if (record.unrecorded) {
      if (now - record.openedAt >= UNRECORDED_GRACE_MS) close.push({ id: record.id, reason: 'not recorded' }); else kept.push(record);
    } else if (record.ownerPid > 0 && !alive(record.ownerPid)) close.push({ id: record.id, reason: 'owner ended' });
    else if (idle >= limits.idleMs) close.push({ id: record.id, reason: 'idle' });
    else kept.push(record);
  }
  // Past the cap: tabs no one recorded first, then tabs no process holds, then live owners' spare tabs, least recently used first.
  // A running owner's working tab (its most recently used one under each tab name) is never closed for the cap: an agent thinking
  // between two clicks is not idle, and closing its page mid-flow loses the work. Over the cap with only working tabs is allowed.
  const holder = (record: TabRecord): string => `${record.ownerPid}\u0000${record.tab ?? ''}`;
  const working = new Map<string, TabRecord>();
  for (const record of kept) {
    if (record.ownerPid <= 0 || record.unrecorded) continue;
    const current = working.get(holder(record));
    if (!current || record.lastUsedAt > current.lastUsedAt) working.set(holder(record), record);
  }
  const rank = (record: TabRecord): number => record.unrecorded ? 0 : record.ownerPid <= 0 ? 1 : 2;
  let excess = kept.length - limits.maxTabs;
  for (const record of [...kept].sort((a, b) => rank(a) - rank(b) || a.lastUsedAt - b.lastUsedAt)) {
    if (excess <= 0) break;
    if (record.parked || deskHeld.has(record.id) || now - record.lastUsedAt < ACTIVE_MS) continue;
    if (working.get(holder(record)) === record) continue;
    close.push({ id: record.id, reason: 'over the tab cap' });
    excess--;
  }
  return { close, forget };
}

// ── the browser's own list of tabs ──────────────────────────────────────────────────────────────────────────────

async function devToolsBase(stateDir: string): Promise<string | undefined> {
  try {
    const port = Number((await fs.readFile(path.join(stateDir, 'computer', 'chrome', 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : undefined;
  } catch { return undefined; }
}

/** The pages Chrome has open, by its DevTools endpoint. Undefined when the browser is not running. */
async function listBrowserTargets(stateDir: string): Promise<BrowserTarget[] | undefined> {
  const base = await devToolsBase(stateDir);
  if (!base) return undefined;
  try {
    const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const all = await response.json() as BrowserTarget[];
    return all.filter(target => target.type === 'page' && !/^devtools:/.test(target.url));
  } catch { return undefined; }
}

async function closeBrowserTarget(stateDir: string, id: string): Promise<boolean> {
  const base = await devToolsBase(stateDir);
  if (!base) return false;
  try { return (await fetch(`${base}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5_000) })).ok; }
  catch { return false; }
}

/** Bring a page to the front of the shared Chrome's window. */
export async function activateBrowserTarget(stateDir: string, id: string): Promise<boolean> {
  const base = await devToolsBase(stateDir);
  if (!base) return false;
  try { return (await fetch(`${base}/json/activate/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5_000) })).ok; }
  catch { return false; }
}

interface SweepDeps {
  now?: number;
  limits?: TabLimits;
  alive?: (pid: number) => boolean;
  list?: () => Promise<BrowserTarget[] | undefined>;
  close?: (id: string) => Promise<boolean>;
}

/** A page's address without its query or fragment: a sign-in's carries state, codes and tokens, and this list is printed. */
export function listedUrl(url: string): string {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}${parsed.pathname}${parsed.search || parsed.hash ? '?…' : ''}` : url; }
  catch { return url.replace(/[?#].*$/, ''); }
}

export interface TabView extends TabRecord { title?: string; recorded: boolean }

const standIn = (target: Pick<BrowserTarget, 'id' | 'url'>, now: number): TabRecord => ({ id: target.id, ownerPid: 0, owner: 'not recorded', openedAt: now, lastUsedAt: now, url: target.url, unrecorded: true });

/** Every page in the shared Chrome with its owner, joined from the records and the browser's own list. */
export async function allTabs(stateDir: string, deps: Pick<SweepDeps, 'now' | 'list'> = {}): Promise<TabView[] | undefined> {
  const now = deps.now ?? Date.now();
  const targets = await (deps.list ?? (() => listBrowserTargets(stateDir)))();
  if (!targets) return undefined;
  const byId = new Map((await readTabRecords(stateDir)).map(record => [record.id, record]));
  return targets.map((target): TabView => {
    const record = byId.get(target.id);
    if (record) return { ...record, url: target.url || record.url, ...(target.title ? { title: target.title } : {}), recorded: true };
    return { ...standIn(target, now), ...(target.title ? { title: target.title } : {}), recorded: false };
  });
}

function logName(view: TabRecord): { tab: string; owner: string; url: string } {
  let url = view.url ?? '';
  try { const parsed = new URL(url); url = `${parsed.origin}${parsed.pathname}`; } catch { /* fail-open-ok: about:blank */ }
  return { tab: view.tab ?? '(default)', owner: view.owner, url: url.slice(0, 120) };
}

/** Close one tab and log it. */
async function closeTabLogged(stateDir: string, view: TabRecord, reason: CloseReason, deps: SweepDeps = {}): Promise<boolean> {
  const now = deps.now ?? Date.now();
  const closed = await (deps.close ?? (id => closeBrowserTarget(stateDir, id)))(view.id);
  if (closed) {
    await removeTabRecord(stateDir, view.id);
    lifecycle('browser.tab.closed', { id: view.id, reason, ageMs: now - view.openedAt, idleMs: now - view.lastUsedAt, ...logName(view) });
  }
  return closed;
}

/** One pass: close the tabs nobody holds, forget records of pages that are gone. Never closes the last page (Chrome would quit).
 * Returns what it closed. */
export async function sweepTabs(stateDir: string, deps: SweepDeps = {}): Promise<{ view: TabView; reason: CloseReason }[]> {
  const now = deps.now ?? Date.now();
  const views = await allTabs(stateDir, { now, ...(deps.list ? { list: deps.list } : {}) });
  if (!views) return [];
  const live = new Set(views.map(view => view.id));
  const records = await readTabRecords(stateDir);
  const deskHeld = await deskHeldTargets(stateDir, now).catch(() => new Set<string>());
  const plan = planTabClosures({ records: views, liveIds: live, now, limits: deps.limits ?? tabLimits(), alive: deps.alive ?? pidIsAlive, deskHeld });
  for (const id of records.map(record => record.id)) if (!live.has(id)) await removeTabRecord(stateDir, id);
  // A page no one recorded gets its stand-in on disk, so the next sweep, in whatever process, sees how long it has been there.
  for (const view of views) if (!view.recorded) await writeStandIn(stateDir, standIn({ id: view.id, url: view.url ?? '' }, now));
  // Chrome quits with its last window: leave the most recently used page.
  let closes = plan.close;
  if (closes.length >= views.length && views.length) {
    const spare = [...views].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]!.id;
    closes = closes.filter(entry => entry.id !== spare);
  }
  const done: { view: TabView; reason: CloseReason }[] = [];
  for (const entry of closes) {
    const view = views.find(item => item.id === entry.id)!;
    if (await closeTabLogged(stateDir, view, entry.reason, { ...deps, now })) done.push({ view, reason: entry.reason });
  }
  return done;
}

/** Close one tab by the browser's id, whoever holds it (the user asked: `clikcode computer browsers close`). */
export async function closeTabById(stateDir: string, id: string, deps: SweepDeps = {}): Promise<boolean> {
  const view = ((await allTabs(stateDir, deps.list ? { list: deps.list } : {})) ?? []).find(item => item.id === id);
  return view && !view.anchor ? closeTabLogged(stateDir, view, 'asked to close', deps) : false;
}

/** Close every tab carrying this label, whoever holds it. Returns the tabs closed. */
export async function closeTabsByLabel(stateDir: string, label: string, deps: SweepDeps = {}): Promise<TabView[]> {
  const views = (await allTabs(stateDir, deps.list ? { list: deps.list } : {})) ?? [];
  const closed: TabView[] = [];
  const deskHeld = await deskHeldTargets(stateDir).catch(() => new Set<string>());
  for (const view of views.filter(item => item.tab === label && !item.anchor && !deskHeld.has(item.id))) if (await closeTabLogged(stateDir, view, 'asked to close', deps)) closed.push(view);
  return closed;
}

/** Close every tab a process holds (its worker is stopping). */
export async function closeTabsOfOwner(stateDir: string, pid: number, deps: SweepDeps = {}): Promise<number> {
  const views = (await allTabs(stateDir, deps.list ? { list: deps.list } : {})) ?? [];
  let count = 0;
  const deskHeld = await deskHeldTargets(stateDir).catch(() => new Set<string>());
  for (const view of views.filter(item => item.ownerPid === pid && !item.parked && !item.anchor && !deskHeld.has(item.id))) if (await closeTabLogged(stateDir, view, 'owner ended', deps)) count++;
  return count;
}

/** `40s`, `12m`, `3h`, `2d`: a tab's age, rounded to one unit -- coarser than
 * harness/protocol/format.ts's formatDuration, which is a call's run time. */
function roughAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1_000))}s`;
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** One line per tab of the shared Chrome, with owner, age and idle time. */
export function describeTabs(views: readonly TabView[], now: number = Date.now(), options: { mine?: string | undefined; limits?: TabLimits } = {}): string {
  const shown = views.filter(view => !view.anchor);
  if (!shown.length) return 'No tab is open in the shared browser.';
  const limits = options.limits ?? tabLimits();
  const lines = [...shown].sort((a, b) => a.openedAt - b.openedAt).map(view => {
    const name = view.tab ? `tab "${view.tab}"` : 'default tab';
    const state = view.parked ? ', parked' : view.restoreFor !== undefined && view.ownerPid === 0 ? ', restored, unclaimed' : '';
    const title = view.title ? `"${view.title.replace(/\s+/g, ' ').slice(0, 60)}" ` : '';
    return `- ${name} · ${view.owner}${state} · open ${roughAge(now - view.openedAt)}, idle ${roughAge(now - view.lastUsedAt)} · ${title}${(view.url ?? '').slice(0, 100)}`;
  });
  return `All tabs in the shared browser (${shown.length}; tabs idle ${roughAge(limits.idleMs)} or whose worker ended are closed, at most ${limits.maxTabs} are kept; close any with tab: "<name>"):\n${lines.join('\n')}`;
}
