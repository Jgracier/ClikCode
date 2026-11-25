/** Every page ClikCode's shared Chrome has open, who holds it, and what is waiting on the person: `clikcode computer browsers` and
 * `/browsers`. Read from what is already written down (the tab records, tab-registry.ts, and the handoff desk, handoff-desk-store.ts)
 * joined with the browser's own list of pages; nothing here keeps a list of its own. A page the browser has and no record names is
 * shown as unrecorded. */
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { quiet } from '../../runtime/lifecycle-log.js';
import { atomicWriteFile } from '../../session/store/files.js';
import { pidIsAlive } from '../../session/store/locks.js';
import { measureBrowser, type BrowserLoad } from './browser-janitor.js';
import { computerHostFile, runningHostDisplay, type HostDisplay } from './browser-host.js';
import { deskItemAddress, listDeskItems, readDeskInfo, deskAddress, type DeskInfo, type DeskItem } from './handoff-desk-store.js';
import { listNotices, noticesText, type Notice } from './notices.js';
import { allTabs, type TabView } from './tab-registry.js';

export interface BrowserTabRow {
  /** 1, 2, 3...: how the actions name a tab. */
  n: number;
  id: string;
  /** The tab name the agent gave; absent for a chat's default tab. */
  name?: string;
  owner: string;
  ownerPid: number;
  /** The chat whose worker holds it, when one does. */
  chat?: string;
  /** The holder is a running process (a parked or restored tab is held by none). */
  ownerAlive: boolean;
  url: string;
  title?: string;
  ageMs: number;
  idleMs: number;
  parked: boolean;
  egress?: string;
  recorded: boolean;
  /** On the handoff desk, waiting on the person. */
  waiting?: { label: string; kind: string; note?: string; waitedMs: number; address?: string };
  /** A live view of it is being served (show, or `browsers watch`) at this address. */
  liveView?: string;
}

export interface BrowsersOverview {
  running: boolean;
  display?: HostDisplay;
  hostPid?: number;
  ageMs?: number;
  renderers?: number;
  bytes?: number;
  desk?: string;
  tabs: BrowserTabRow[];
  /** What background programs told the person (`clikcode notify`), open until dismissed or cleared. */
  notices: Notice[];
  totals: { tabs: number; waiting: number; longestWaitMs: number; unrecorded: number };
}

export interface OverviewDeps {
  now?: number;
  tabs?: () => Promise<TabView[] | undefined>;
  hostPid?: () => Promise<number | undefined>;
  display?: () => Promise<HostDisplay | undefined>;
  measure?: (pid: number) => BrowserLoad;
  ageOf?: (pid: number) => number | undefined;
  desk?: () => Promise<{ info: DeskInfo | undefined; items: DeskItem[] }>;
  chats?: () => Promise<Map<number, string>>;
  alive?: (pid: number) => boolean;
  notices?: () => Promise<Notice[]>;
  /** Live views served by a process outside the chats (`browsers watch`, `/browsers watch`), by tab id. */
  watchViews?: () => Promise<Map<string, string>>;
}

// ── live views a command serves: the chat's own (show) are on the tab's record; a watch is served by a process that holds no tab ──

interface WatchRecord { id: string; address: string; pid: number }
const watchDir = (stateDir: string): string => path.join(stateDir, 'computer', 'watch-views');
const watchFile = (stateDir: string, id: string): string => path.join(watchDir(stateDir), `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

/** Write down that this process serves a live view of tab `id` at `address`, so the list shows it as open. */
export async function recordWatchView(stateDir: string, id: string, address: string): Promise<void> {
  await fs.mkdir(watchDir(stateDir), { recursive: true, mode: 0o700 });
  await atomicWriteFile(watchFile(stateDir, id), JSON.stringify({ id, address, pid: process.pid } satisfies WatchRecord), { mode: 0o600, durable: false });
}
export async function forgetWatchView(stateDir: string, id: string): Promise<void> {
  await fs.unlink(watchFile(stateDir, id)).catch(quiet('agent/computer/browsers-overview'));
}
/** The watch views whose serving process still runs; a record left by one that ended is removed. */
export async function watchViews(stateDir: string, alive: (pid: number) => boolean = pidIsAlive): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const name of await fs.readdir(watchDir(stateDir)).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(watchDir(stateDir), name), 'utf8')) as WatchRecord;
      if (typeof record.id !== 'string' || typeof record.address !== 'string') continue;
      if (Number.isSafeInteger(record.pid) && alive(record.pid)) found.set(record.id, record.address);
      else await fs.unlink(path.join(watchDir(stateDir), name)).catch(quiet('agent/computer/browsers-overview'));
    } catch { /* being written */ }
  }
  return found;
}

async function hostPidOf(stateDir: string): Promise<number | undefined> {
  try {
    const pid = Number((JSON.parse(await fs.readFile(computerHostFile(stateDir), 'utf8')) as { pid?: unknown }).pid);
    return Number.isSafeInteger(pid) && pid > 1 && pidIsAlive(pid) ? pid : undefined;
  } catch { return undefined; }
}

/** How long a process has run, from /proc (Linux); undefined elsewhere. */
export function processAgeMs(pid: number, read: (file: string) => string = file => readFileSync(file, 'utf8')): number | undefined {
  try {
    const stat = read(`/proc/${pid}/stat`);
    const startTicks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const uptime = Number(read('/proc/uptime').split(' ')[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptime)) return undefined;
    return Math.max(0, Math.round((uptime - startTicks / 100) * 1000));
  } catch { return undefined; }
}

async function workerChats(): Promise<Map<number, string>> {
  const { listWorkerRecords } = await import('../../worker/registry.js');
  return new Map((await listWorkerRecords().catch(() => [])).map(record => [record.pid, record.sessionId]));
}

/** A page's address without its query or fragment: a sign-in's carries state, codes and tokens, and this list is printed. */
export function listedUrl(url: string): string {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}${parsed.pathname}${parsed.search || parsed.hash ? '?…' : ''}` : url; }
  catch { return url.replace(/[?#].*$/, ''); }
}

export async function browsersOverview(stateDir: string, deps: OverviewDeps = {}): Promise<BrowsersOverview> {
  const now = deps.now ?? Date.now();
  const alive = deps.alive ?? pidIsAlive;
  const [views, hostPid, display, desk, chats, notices, watching] = await Promise.all([
    (deps.tabs ?? (() => allTabs(stateDir, { now })))(),
    (deps.hostPid ?? (() => hostPidOf(stateDir)))(),
    (deps.display ?? (() => runningHostDisplay(stateDir)))(),
    (deps.desk ?? (async () => ({ info: await readDeskInfo(stateDir), items: await listDeskItems(stateDir) })))().catch(() => ({ info: undefined, items: [] as DeskItem[] })),
    (deps.chats ?? workerChats)().catch(() => new Map<number, string>()),
    (deps.notices ?? (() => listNotices(stateDir)))().catch(() => [] as Notice[]),
    (deps.watchViews ?? (() => watchViews(stateDir, alive)))().catch(() => new Map<string, string>()),
  ]);
  const waitingOn = new Map(desk.items.filter(item => item.status === 'waiting').map(item => [item.targetId, item]));
  const tabs = (views ?? []).map((view, index): BrowserTabRow => {
    const item = waitingOn.get(view.id);
    const chat = view.ownerPid ? chats.get(view.ownerPid) : undefined;
    const liveView = view.liveView ?? watching.get(view.id);
    return {
      n: index + 1, id: view.id, ...(view.tab ? { name: view.tab } : {}), owner: view.owner, ownerPid: view.ownerPid, ...(chat ? { chat } : {}),
      ownerAlive: view.ownerPid > 0 && alive(view.ownerPid), url: listedUrl(view.url ?? ''), ...(view.title ? { title: view.title } : {}),
      ageMs: Math.max(0, now - view.openedAt), idleMs: Math.max(0, now - view.lastUsedAt), parked: view.parked === true,
      ...(view.egress ? { egress: view.egress } : {}), recorded: view.recorded,
      ...(item ? { waiting: { label: item.label, kind: item.kind, ...(item.note ? { note: item.note } : {}), waitedMs: Math.max(0, now - item.createdAt), ...(desk.info ? { address: deskItemAddress(desk.info, item.id) } : {}) } } : {}),
      ...(liveView ? { liveView } : {}),
    };
  });
  const load = hostPid ? (deps.measure ?? (pid => measureBrowser(pid)))(hostPid) : undefined;
  const ageMs = hostPid ? (deps.ageOf ?? processAgeMs)(hostPid) : undefined;
  const waits = tabs.flatMap(tab => tab.waiting ? [tab.waiting.waitedMs] : []);
  return {
    running: views !== undefined,
    ...(display ? { display } : {}),
    ...(hostPid ? { hostPid } : {}),
    ...(ageMs !== undefined ? { ageMs } : {}),
    ...(load ? { renderers: load.renderers, bytes: load.bytes } : {}),
    ...(desk.info ? { desk: deskAddress(desk.info) } : {}),
    tabs,
    notices,
    totals: { tabs: tabs.length, waiting: waits.length, longestWaitMs: waits.length ? Math.max(...waits) : 0, unrecorded: tabs.filter(tab => !tab.recorded).length },
  };
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function shortUrl(url: string): string {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`.slice(0, 70) : url.slice(0, 70); }
  catch { return url.slice(0, 70); }
}

function ownerText(tab: BrowserTabRow): string {
  if (!tab.recorded) return 'unrecorded (no record names it)';
  const who = tab.chat ? `chat ${tab.chat.slice(0, 8)}` : tab.owner;
  return `${tab.name ? `"${tab.name}" · ` : ''}${who}${tab.ownerPid > 0 && !tab.ownerAlive ? ' (ended)' : ''}`;
}

/** The list as a person reads it. `how` is the line that says how to act on a tab (the CLI and the slash command say it differently). */
export function browsersText(overview: BrowsersOverview, how: string, options: { now?: number; dismiss?: string } = {}): string {
  const notices = noticesText(overview.notices, options.now ?? Date.now(), options.dismiss ?? 'Dismiss one: clikcode notify --clear --key <key>');
  if (!overview.running) return [...notices, ...(notices.length ? [''] : []), 'ClikCode\'s browser is not running: no tabs are open. It starts by itself with the first browser_use call.'].join('\n');
  const gb = overview.bytes !== undefined ? `${(overview.bytes / 2 ** 30).toFixed(1)} GB` : undefined;
  const browser = [
    overview.display ? `window ${overview.display === 'hidden' ? 'hidden (virtual display)' : overview.display === 'visible' ? 'on the desktop' : 'headless'}` : undefined,
    overview.ageMs !== undefined ? `up ${duration(overview.ageMs)}` : undefined,
    overview.renderers !== undefined ? `${overview.renderers} renderers` : undefined,
    gb,
  ].filter(Boolean).join(', ');
  const { totals } = overview;
  const lines = [
    `ClikCode browser: ${totals.tabs} tab${totals.tabs === 1 ? '' : 's'} open, ${totals.waiting} waiting on you${totals.waiting ? ` (longest ${duration(totals.longestWaitMs)})` : ''}${totals.unrecorded ? `, ${totals.unrecorded} unrecorded` : ''}${browser ? ` · ${browser}` : ''}`,
    '',
  ];
  for (const tab of overview.tabs) {
    const flags = [
      tab.waiting ? `WAITING ON YOU ${duration(tab.waiting.waitedMs)}: ${tab.waiting.label} [${tab.waiting.kind}]${tab.waiting.note ? ` ${tab.waiting.note}` : ''}` : undefined,
      tab.parked ? 'parked' : undefined,
      tab.liveView ? `live view open ${tab.liveView}` : undefined,
      tab.egress ? `via ${tab.egress}` : undefined,
    ].filter(Boolean);
    lines.push(`${String(tab.n).padStart(2)}. ${tab.title ? `${tab.title.slice(0, 60)} · ` : ''}${shortUrl(tab.url)}`);
    lines.push(`    ${ownerText(tab)} · opened ${duration(tab.ageMs)} ago, used ${duration(tab.idleMs)} ago${flags.length ? ` · ${flags.join(' · ')}` : ''}`);
    if (tab.waiting?.address) lines.push(`    handoff: ${tab.waiting.address}`);
  }
  if (overview.desk && totals.waiting) lines.push('', `Everything waiting on you: ${overview.desk}`);
  if (notices.length) lines.push('', ...notices);
  lines.push('', how);
  return lines.join('\n');
}

/** A tab named by the person: its number in the list, its tab name, or the start of the browser's id. */
export function pickTab(overview: BrowsersOverview, which: string): BrowserTabRow {
  const word = which.trim();
  const byNumber = /^\d+$/.test(word) ? overview.tabs.find(tab => tab.n === Number(word)) : undefined;
  const found = byNumber ?? overview.tabs.find(tab => tab.name === word) ?? (word.length >= 4 ? overview.tabs.find(tab => tab.id.toLowerCase().startsWith(word.toLowerCase())) : undefined);
  if (!found) throw new Error(`No open tab is "${word}". Name one by its number in the list, its tab name, or the start of its id.`);
  return found;
}
