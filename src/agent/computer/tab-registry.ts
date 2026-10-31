/** Who owns each tab of the shared Chrome, and when it was last used.
 *
 * MEASURED 2026-10-31: the hidden Chrome had run 2d11h with 139 processes and 41 renderers older than two days. Tabs named
 * with `tab: "<label>"` by parallel workers and sub-agents were never closed when the worker ended, and the owner's map of
 * pages lives in that worker's memory, so no other chat could list or close them.
 *
 * Every worker writes one small file per tab it holds (`computer/tabs/<targetId>.json`): the owner process, the label, when it
 * was opened and last used. A sweep, run by the browser host, by any worker using the browser, and by `clikcode doctor`, reads
 * them next to the browser's own target list (the DevTools HTTP endpoint, no Playwright needed) and closes what no one holds:
 * a tab whose owner process has ended, a tab idle past a limit, and the least recently used tabs past a cap. Every close is
 * logged. A Chrome tab nobody recorded (opened before this existed) is treated as idle from the moment it was first seen. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';

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
}

export interface BrowserTarget { id: string; type: string; url: string; title?: string }

export interface TabLimits { idleMs: number; maxTabs: number }

const envNumber = (name: string, fallback: number, env: NodeJS.ProcessEnv): number => {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** 20 minutes idle, 12 tabs. CLIKCODE_BROWSER_TAB_IDLE_MS and CLIKCODE_BROWSER_MAX_TABS change them. */
export function tabLimits(env: NodeJS.ProcessEnv = process.env): TabLimits {
  return { idleMs: envNumber('CLIKCODE_BROWSER_TAB_IDLE_MS', 20 * 60_000, env), maxTabs: Math.floor(envNumber('CLIKCODE_BROWSER_MAX_TABS', 12, env)) };
}

export const PARKED_MS = 6 * 3_600_000;
/** A tab used this recently is never evicted for the cap. */
export const ACTIVE_MS = 10_000;

export const tabsDirectory = (stateDir: string): string => path.join(stateDir, 'computer', 'tabs');
const tabFile = (stateDir: string, id: string): string => path.join(tabsDirectory(stateDir), `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export async function writeTabRecord(stateDir: string, record: TabRecord): Promise<void> {
  try {
    await fs.mkdir(tabsDirectory(stateDir), { recursive: true, mode: 0o700 });
    const file = tabFile(stateDir, record.id);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) { quiet('agent/computer/tab-registry')(error); }
}

export async function removeTabRecord(stateDir: string, id: string): Promise<void> {
  await fs.unlink(tabFile(stateDir, id)).catch(() => undefined);
}

export async function readTabRecords(stateDir: string): Promise<TabRecord[]> {
  const names = await fs.readdir(tabsDirectory(stateDir)).catch(() => [] as string[]);
  const records: TabRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(tabsDirectory(stateDir), name), 'utf8')) as TabRecord;
      if (typeof record.id === 'string' && Number.isFinite(record.lastUsedAt) && Number.isFinite(record.openedAt)) records.push(record);
    } catch { /* being rewritten, or damaged: the next sweep sees it whole */ }
  }
  return records;
}

export type CloseReason = 'owner ended' | 'idle' | 'over the tab cap' | 'asked to close';
export interface Closure { id: string; reason: CloseReason }

/** Which tabs to close, and which records to forget (their page is gone). Pure.
 * `records` should already include a stand-in record for each page Chrome has that no worker recorded. */
export function planTabClosures(input: {
  records: readonly TabRecord[]; liveIds: ReadonlySet<string>; now: number; limits: TabLimits; alive: (pid: number) => boolean;
}): { close: Closure[]; forget: string[] } {
  const { records, liveIds, now, limits, alive } = input;
  const forget = records.filter(record => !liveIds.has(record.id)).map(record => record.id);
  const live = records.filter(record => liveIds.has(record.id));
  const close: Closure[] = [];
  const kept: TabRecord[] = [];
  for (const record of live) {
    const idle = now - record.lastUsedAt;
    if (record.parked) {
      if (idle >= PARKED_MS) close.push({ id: record.id, reason: 'idle' }); else kept.push(record);
    } else if (record.ownerPid > 0 && !alive(record.ownerPid)) close.push({ id: record.id, reason: 'owner ended' });
    else if (idle >= limits.idleMs) close.push({ id: record.id, reason: 'idle' });
    else kept.push(record);
  }
  // Past the cap, the least recently used go first; a tab used in the last seconds is in use, not idle.
  let excess = kept.length - limits.maxTabs;
  for (const record of [...kept].sort((a, b) => a.lastUsedAt - b.lastUsedAt)) {
    if (excess <= 0) break;
    if (record.parked || now - record.lastUsedAt < ACTIVE_MS) continue;
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
export async function listBrowserTargets(stateDir: string): Promise<BrowserTarget[] | undefined> {
  const base = await devToolsBase(stateDir);
  if (!base) return undefined;
  try {
    const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const all = await response.json() as BrowserTarget[];
    return all.filter(target => target.type === 'page' && !/^devtools:/.test(target.url));
  } catch { return undefined; }
}

export async function closeBrowserTarget(stateDir: string, id: string): Promise<boolean> {
  const base = await devToolsBase(stateDir);
  if (!base) return false;
  try { return (await fetch(`${base}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5_000) })).ok; }
  catch { return false; }
}

export const processExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Pages first seen without a record, by target id: how long a tab no one recorded has been there, for this process. */
const firstSeen = new Map<string, number>();

export interface SweepDeps {
  now?: number;
  limits?: TabLimits;
  alive?: (pid: number) => boolean;
  list?: () => Promise<BrowserTarget[] | undefined>;
  close?: (id: string) => Promise<boolean>;
}

export interface TabView extends TabRecord { title?: string; recorded: boolean }

/** Every page in the shared Chrome with its owner, joined from the records and the browser's own list. */
export async function allTabs(stateDir: string, deps: Pick<SweepDeps, 'now' | 'list'> = {}): Promise<TabView[] | undefined> {
  const now = deps.now ?? Date.now();
  const targets = await (deps.list ?? (() => listBrowserTargets(stateDir)))();
  if (!targets) return undefined;
  const byId = new Map((await readTabRecords(stateDir)).map(record => [record.id, record]));
  return targets.map((target): TabView => {
    const record = byId.get(target.id);
    if (record) return { ...record, url: target.url || record.url, ...(target.title ? { title: target.title } : {}), recorded: true };
    if (!firstSeen.has(target.id)) firstSeen.set(target.id, now);
    const since = firstSeen.get(target.id)!;
    return { id: target.id, ownerPid: 0, owner: 'not recorded (opened before tracking)', openedAt: since, lastUsedAt: since, url: target.url, ...(target.title ? { title: target.title } : {}), recorded: false };
  });
}

function logName(view: TabRecord): { tab: string; owner: string; url: string } {
  let url = view.url ?? '';
  try { const parsed = new URL(url); url = `${parsed.origin}${parsed.pathname}`; } catch { /* about:blank */ }
  return { tab: view.tab ?? '(default)', owner: view.owner, url: url.slice(0, 120) };
}

/** Close one tab and log it. */
export async function closeTabLogged(stateDir: string, view: TabRecord, reason: CloseReason, deps: SweepDeps = {}): Promise<boolean> {
  const now = deps.now ?? Date.now();
  const closed = await (deps.close ?? (id => closeBrowserTarget(stateDir, id)))(view.id);
  if (closed) {
    await removeTabRecord(stateDir, view.id);
    firstSeen.delete(view.id);
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
  const plan = planTabClosures({ records: views, liveIds: live, now, limits: deps.limits ?? tabLimits(), alive: deps.alive ?? processExists });
  for (const id of records.map(record => record.id)) if (!live.has(id)) await removeTabRecord(stateDir, id);
  for (const id of firstSeen.keys()) if (!live.has(id)) firstSeen.delete(id);
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

/** Close every tab carrying this label, whoever holds it. Returns the tabs closed. */
export async function closeTabsByLabel(stateDir: string, label: string, deps: SweepDeps = {}): Promise<TabView[]> {
  const views = (await allTabs(stateDir, deps.list ? { list: deps.list } : {})) ?? [];
  const closed: TabView[] = [];
  for (const view of views.filter(item => item.tab === label)) if (await closeTabLogged(stateDir, view, 'asked to close', deps)) closed.push(view);
  return closed;
}

/** Close every tab a process holds (its worker is stopping). */
export async function closeTabsOfOwner(stateDir: string, pid: number, deps: SweepDeps = {}): Promise<number> {
  const views = (await allTabs(stateDir, deps.list ? { list: deps.list } : {})) ?? [];
  let count = 0;
  for (const view of views.filter(item => item.ownerPid === pid && !item.parked)) if (await closeTabLogged(stateDir, view, 'owner ended', deps)) count++;
  return count;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1_000))}s`;
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** One line per tab of the shared Chrome, with owner, age and idle time. */
export function describeTabs(views: readonly TabView[], now: number = Date.now(), options: { mine?: string | undefined; limits?: TabLimits } = {}): string {
  if (!views.length) return 'No tab is open in the shared browser.';
  const limits = options.limits ?? tabLimits();
  const lines = [...views].sort((a, b) => a.openedAt - b.openedAt).map(view => {
    const name = view.tab ? `tab "${view.tab}"` : 'default tab';
    const state = view.parked ? ', parked' : view.restoreFor !== undefined && view.ownerPid === 0 ? ', restored, unclaimed' : '';
    const title = view.title ? `"${view.title.replace(/\s+/g, ' ').slice(0, 60)}" ` : '';
    return `- ${name} · ${view.owner}${state} · open ${formatDuration(now - view.openedAt)}, idle ${formatDuration(now - view.lastUsedAt)} · ${title}${(view.url ?? '').slice(0, 100)}`;
  });
  return `All tabs in the shared browser (${views.length}; tabs idle ${formatDuration(limits.idleMs)} or whose worker ended are closed, at most ${limits.maxTabs} are kept; close any with tab: "<name>"):\n${lines.join('\n')}`;
}
