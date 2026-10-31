/** Keeps the shared Chrome from growing without end: closes tabs nobody holds (tab-registry.ts) and, when the browser has
 * more renderers or memory than a ceiling, recycles it -- the URLs of the named tabs used lately are saved, Chrome is
 * restarted, and only those tabs come back.
 *
 * MEASURED 2026-10-31: one Chrome, 2d11h old, 139 processes, 41 renderers older than two days, 16.6 GB in one scope. A
 * long-lived renderer fragments and leaks; a restart is the only reliable reset. */
import { readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';
import { ACTIVE_MS, readTabRecords, sweepTabs, writeTabRecord, type TabRecord } from './tab-registry.js';

export interface RecycleLimits { renderers: number; bytes: number }

const GIB = 2 ** 30;

/** 40 renderers or 6 GB. CLIKCODE_BROWSER_MAX_RENDERERS and CLIKCODE_BROWSER_MAX_GB change them. */
export function recycleLimits(env: NodeJS.ProcessEnv = process.env): RecycleLimits {
  const number = (name: string, fallback: number): number => { const value = Number(env[name]); return Number.isFinite(value) && value > 0 ? value : fallback; };
  return { renderers: Math.floor(number('CLIKCODE_BROWSER_MAX_RENDERERS', 40)), bytes: number('CLIKCODE_BROWSER_MAX_GB', 6) * GIB };
}

export interface BrowserLoad { renderers: number; bytes: number }

/** Only tabs used within this long come back after a recycle. */
export const RESTORE_WITHIN_MS = 10 * 60_000;

/** Why the browser should be restarted now, or undefined. A tab used in the last seconds defers it, unless the browser is
 * over twice a ceiling: a restart mid-call costs that call; a runaway browser costs the machine. */
export function recycleVerdict(load: BrowserLoad, limits: RecycleLimits, lastUsedAt: number, now: number): string | undefined {
  const reasons: string[] = [];
  if (load.renderers > limits.renderers) reasons.push(`${load.renderers} renderers over ${limits.renderers}`);
  if (load.bytes > limits.bytes) reasons.push(`${(load.bytes / GIB).toFixed(1)} GB over ${(limits.bytes / GIB).toFixed(1)} GB`);
  if (!reasons.length) return undefined;
  const far = load.renderers > limits.renderers * 2 || load.bytes > limits.bytes * 2;
  if (!far && now - lastUsedAt < ACTIVE_MS) return undefined;
  return reasons.join(', ');
}

// ── measuring (Linux; elsewhere the browser's own tab cap is the only bound) ─────────────────────────────────

interface ProcRoot { list(): string[]; read(pid: number, file: string): string | undefined }

const realProc: ProcRoot = {
  list: () => { try { return readdirSync('/proc').filter(name => /^\d+$/.test(name)); } catch { return []; } },
  read: (pid, file) => { try { return readFileSync(`/proc/${pid}/${file}`, 'utf8'); } catch { return undefined; } },
};

/** Renderers below `rootPid`, and the memory the browser holds: its cgroup's memory.current when it has a scope of its
 * own (clikcode-browser-host), else the sum of its processes' proportional memory (PSS, which does not count shared pages
 * once per process the way RSS does). */
export function measureBrowser(rootPid: number, proc: ProcRoot = realProc, cgroupBytes: (cgroupLine: string) => number | undefined = ownScopeBytes): BrowserLoad {
  const parents = new Map<number, number>();
  for (const name of proc.list()) {
    const stat = proc.read(Number(name), 'stat');
    if (!stat) continue;
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (Number.isFinite(parent)) parents.set(Number(name), parent);
  }
  const members = new Set<number>([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, parent] of parents) if (!members.has(pid) && members.has(parent)) { members.add(pid); grew = true; }
  }
  let renderers = 0;
  let pss = 0;
  for (const pid of members) {
    if (/--type=renderer/.test((proc.read(pid, 'cmdline') ?? '').replace(/\0/g, ' '))) renderers++;
    const rollup = proc.read(pid, 'smaps_rollup');
    const kb = Number(/^Pss:\s+(\d+) kB/m.exec(rollup ?? '')?.[1]);
    if (Number.isFinite(kb)) pss += kb * 1024;
    else {
      const resident = Number((proc.read(pid, 'statm') ?? '').split(' ')[1]);
      if (Number.isFinite(resident)) pss += resident * 4096;
    }
  }
  const fromScope = cgroupBytes(proc.read(rootPid, 'cgroup') ?? '');
  return { renderers, bytes: fromScope ?? pss };
}

/** memory.current of this process's cgroup when it is the browser host's own unit. */
function ownScopeBytes(cgroupLine: string): number | undefined {
  const where = /^0::(.*)$/m.exec(cgroupLine)?.[1];
  if (!where || !/clikcode-browser-host[^/]*\.(?:scope|service)/.test(where)) return undefined;
  const unit = where.slice(0, where.search(/clikcode-browser-host[^/]*\.(?:scope|service)/)) + /clikcode-browser-host[^/]*\.(?:scope|service)/.exec(where)![0];
  const value = Number(readFileSyncOr(`/sys/fs/cgroup${unit}/memory.current`));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readFileSyncOr(file: string): string | undefined {
  try { return readFileSync(file, 'utf8'); } catch { return undefined; }
}

// ── what survives a recycle ──────────────────────────────────────────────────────────────────────────────────

export const recycleFile = (stateDir: string): string => path.join(stateDir, 'computer', 'recycle.json');

export interface SavedTab { tab: string; url: string }

/** The named tabs used within RESTORE_WITHIN_MS that have an address worth reopening. */
export function tabsToRestore(records: readonly TabRecord[], now: number): SavedTab[] {
  const seen = new Set<string>();
  const saved: SavedTab[] = [];
  for (const record of [...records].sort((a, b) => b.lastUsedAt - a.lastUsedAt)) {
    if (!record.tab || record.parked || now - record.lastUsedAt > RESTORE_WITHIN_MS || !/^https?:/i.test(record.url ?? '') || seen.has(record.tab)) continue;
    seen.add(record.tab);
    saved.push({ tab: record.tab, url: record.url! });
  }
  return saved;
}

export async function saveRecycle(stateDir: string, tabs: readonly SavedTab[], now: number): Promise<void> {
  await fs.writeFile(recycleFile(stateDir), JSON.stringify({ at: now, tabs }), { mode: 0o600 });
}

/** The tabs a recycle saved, once: the file is removed as it is read. Ignored when older than a minute-scale restart. */
export async function takeRecycle(stateDir: string, now: number = Date.now()): Promise<SavedTab[]> {
  try {
    const saved = JSON.parse(await fs.readFile(recycleFile(stateDir), 'utf8')) as { at?: number; tabs?: SavedTab[] };
    await fs.unlink(recycleFile(stateDir)).catch(() => undefined);
    if (typeof saved.at !== 'number' || now - saved.at > RESTORE_WITHIN_MS) return [];
    return (saved.tabs ?? []).filter(tab => typeof tab.tab === 'string' && /^https?:/i.test(tab.url));
  } catch { return []; }
}

/** What the host needs of Chrome: open a page and say its id. */
export interface RestoreHost { openPage(url: string): Promise<string | undefined> }

/** Reopen the saved tabs, each as an unclaimed record for the worker that names that label. */
export async function restoreTabs(stateDir: string, tabs: readonly SavedTab[], host: RestoreHost, now: number = Date.now()): Promise<number> {
  let count = 0;
  for (const saved of tabs) {
    const id = await host.openPage(saved.url).catch(quiet('agent/computer/browser-janitor'));
    if (!id) continue;
    await writeTabRecord(stateDir, { id, tab: saved.tab, ownerPid: 0, owner: 'restored after a browser restart', openedAt: now, lastUsedAt: now, url: saved.url, restoreFor: saved.tab });
    count++;
  }
  if (count) lifecycle('browser.restored', { tabs: count });
  return count;
}

// ── the loop the host runs ───────────────────────────────────────────────────────────────────────────────────

export interface JanitorDeps {
  stateDir: string;
  hostPid: number;
  /** End Chrome so the host exits; the next worker that needs the browser starts a new host. */
  recycle: () => Promise<void>;
  measure?: () => BrowserLoad;
  limits?: RecycleLimits;
  now?: () => number;
}

/** One pass: sweep tabs, then recycle when the browser is over a ceiling. Returns the recycle reason when it recycled. */
export async function janitorTick(deps: JanitorDeps): Promise<string | undefined> {
  const now = (deps.now ?? Date.now)();
  await sweepTabs(deps.stateDir, { now }).catch(quiet('agent/computer/browser-janitor'));
  const load = (deps.measure ?? (() => measureBrowser(deps.hostPid)))();
  const records = await readTabRecords(deps.stateDir);
  const lastUsed = records.reduce((latest, record) => Math.max(latest, record.lastUsedAt), 0);
  const reason = recycleVerdict(load, deps.limits ?? recycleLimits(), lastUsed, now);
  if (!reason) return undefined;
  const tabs = tabsToRestore(records, now);
  lifecycle('browser.recycle', { reason, renderers: load.renderers, gb: Number((load.bytes / GIB).toFixed(1)), restore: tabs.length });
  await saveRecycle(deps.stateDir, tabs, now);
  await deps.recycle();
  return reason;
}

export const JANITOR_INTERVAL_MS = 30_000;

export function startBrowserJanitor(deps: JanitorDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void janitorTick(deps).catch(quiet('agent/computer/browser-janitor')).finally(() => { running = false; });
  }, JANITOR_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
