/** The handoff desk's records: what waits on the user in the browser, and where the desk is served.
 *
 * MEASURED 2026-11: phone links made per call died with the process that made them (a turn ending, a worker restart) or after
 * ten idle minutes, and each was one use, so a CAPTCHA the user was slow to reach needed a new link every time. The desk is
 * served by the browser host, which outlives every worker: one address that never changes, a list of the tabs waiting, and a
 * tab that stays open until the user says it is done.
 *
 * Files only, so the tab sweep, a worker and the host all read the same truth without holding the browser. */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { quiet, swallowed } from '../../runtime/lifecycle-log.js';
import { atomicWriteFile } from '../../session/store/files.js';
import { pidIsAlive } from '../../session/store/locks.js';

export type DeskKind = 'captcha' | 'code' | 'sign-in' | 'other';
export interface DeskItem {
  id: string;
  /** What the user sees in the list: a vendor or a short task name. */
  label: string;
  kind: DeskKind;
  /** One line on what to do. Never a secret. */
  note?: string;
  /** The browser's own id for the tab. */
  targetId: string;
  /** The page's host when it was parked, for the list. */
  host?: string;
  createdAt: number;
  status: 'waiting' | 'done' | 'closed';
  doneAt?: number;
  /** A connector id whose key capture carries on once this is done. */
  resume?: string;
  /** The connector loop has been told this one is done (its attention item re-queued). */
  resumeSent?: boolean;
}
export interface DeskInfo { pid: number; host: string; port: number; token: string }

/** A waiting item keeps its tab open this long; then the desk closes the item and the tab sweep may take the tab. */
export const DESK_WAIT_MS = 12 * 3_600_000;
/** A finished item is kept this long for whoever is waiting on it to notice. */
const DESK_DONE_MS = 24 * 3_600_000;

const deskDir = (stateDir: string): string => path.join(stateDir, 'computer', 'desk');
const itemsDir = (stateDir: string): string => path.join(deskDir(stateDir), 'items');
const itemFile = (stateDir: string, id: string): string => path.join(itemsDir(stateDir), `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
const infoFile = (stateDir: string): string => path.join(deskDir(stateDir), 'desk.json');
const tokenFile = (stateDir: string): string => path.join(deskDir(stateDir), 'token');

/** The desk's secret path. Made once and kept, so the address the user saved keeps working across restarts. */
export async function deskToken(stateDir: string): Promise<string> {
  try {
    const saved = (await fs.readFile(tokenFile(stateDir), 'utf8')).trim();
    if (/^[A-Za-z0-9_-]{24,}$/.test(saved)) return saved;
  } catch { /* fail-open-ok: first run */ }
  const token = randomBytes(24).toString('base64url');
  await fs.mkdir(deskDir(stateDir), { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenFile(stateDir), token, { mode: 0o600 });
  return token;
}

export async function writeDeskInfo(stateDir: string, info: DeskInfo): Promise<void> {
  await fs.mkdir(deskDir(stateDir), { recursive: true, mode: 0o700 });
  await fs.writeFile(infoFile(stateDir), JSON.stringify(info), { mode: 0o600 });
}
export async function clearDeskInfo(stateDir: string, pid: number): Promise<void> {
  const info = await readDeskInfo(stateDir, () => true);
  if (info?.pid === pid) await fs.unlink(infoFile(stateDir)).catch(quiet('agent/computer/handoff-desk-store'));
}
/** Where the desk is served, when its host process is running. */
export async function readDeskInfo(stateDir: string, alive: (pid: number) => boolean = pidIsAlive): Promise<DeskInfo | undefined> {
  try {
    const info = JSON.parse(await fs.readFile(infoFile(stateDir), 'utf8')) as DeskInfo;
    if (typeof info.pid !== 'number' || typeof info.host !== 'string' || typeof info.port !== 'number' || typeof info.token !== 'string') return undefined;
    return alive(info.pid) ? info : undefined;
  } catch { return undefined; }
}
export const deskAddress = (info: DeskInfo): string => `http://${info.host}:${info.port}/${info.token}/`;
export const deskItemAddress = (info: DeskInfo, id: string): string => `${deskAddress(info)}t/${id}/`;

export async function listDeskItems(stateDir: string): Promise<DeskItem[]> {
  const names = await fs.readdir(itemsDir(stateDir)).catch(() => [] as string[]);
  const items: DeskItem[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const item = JSON.parse(await fs.readFile(path.join(itemsDir(stateDir), name), 'utf8')) as DeskItem;
      if (typeof item.id === 'string' && typeof item.targetId === 'string' && Number.isFinite(item.createdAt)) items.push(item);
    } catch (error) { /* being rewritten: the next read sees it whole */ swallowed('agent/computer/handoff-desk-store', error); }
  }
  return items.sort((a, b) => a.createdAt - b.createdAt);
}
export async function readDeskItem(stateDir: string, id: string): Promise<DeskItem | undefined> {
  return (await listDeskItems(stateDir)).find(item => item.id === id);
}
async function writeDeskItem(stateDir: string, item: DeskItem): Promise<void> {
  await fs.mkdir(itemsDir(stateDir), { recursive: true, mode: 0o700 });
  await atomicWriteFile(itemFile(stateDir, item.id), JSON.stringify(item), { durable: false });
}
export async function removeDeskItem(stateDir: string, id: string): Promise<void> {
  await fs.unlink(itemFile(stateDir, id)).catch(quiet('agent/computer/handoff-desk-store'));
}

const clean = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** Put a tab on the desk. One waiting item per tab: asking again for the same tab returns the item it already has. */
export async function addDeskItem(stateDir: string, input: { targetId: string; label: string; kind?: DeskKind; note?: string; url?: string; resume?: string }, now: number = Date.now()): Promise<DeskItem> {
  const before = (await listDeskItems(stateDir)).find(item => item.targetId === input.targetId && item.status === 'waiting');
  if (before) return before;
  let host: string | undefined;
  try { host = input.url ? new URL(input.url).host : undefined; } catch { host = undefined; }
  const item: DeskItem = {
    id: randomBytes(9).toString('base64url'), label: clean(input.label, 60) || 'Browser step', kind: input.kind ?? 'other',
    ...(input.note ? { note: clean(input.note, 200) } : {}), targetId: input.targetId, ...(host ? { host } : {}), createdAt: now, status: 'waiting',
    ...(input.resume ? { resume: input.resume } : {}),
  };
  await writeDeskItem(stateDir, item);
  return item;
}

export async function finishDeskItem(stateDir: string, id: string, status: 'done' | 'closed', now: number = Date.now()): Promise<DeskItem | undefined> {
  const item = await readDeskItem(stateDir, id);
  if (!item || item.status !== 'waiting') return item;
  const next: DeskItem = { ...item, status, doneAt: now };
  await writeDeskItem(stateDir, next);
  return next;
}

/** The finished items whose connector has not been sent back to work yet; each is marked as sent. */
export async function takeFinishedResumes(stateDir: string): Promise<DeskItem[]> {
  const taken: DeskItem[] = [];
  for (const item of await listDeskItems(stateDir)) {
    if (item.status !== 'done' || !item.resume || item.resumeSent) continue;
    await writeDeskItem(stateDir, { ...item, resumeSent: true });
    taken.push(item);
  }
  return taken;
}

/** Close what waited too long, forget what finished long ago or whose tab is gone. Returns the items it changed. */
export async function tidyDesk(stateDir: string, liveTargets: ReadonlySet<string> | undefined, now: number = Date.now()): Promise<DeskItem[]> {
  const changed: DeskItem[] = [];
  for (const item of await listDeskItems(stateDir)) {
    if (item.status === 'waiting') {
      if (now - item.createdAt >= DESK_WAIT_MS || (liveTargets && !liveTargets.has(item.targetId))) {
        const closed = await finishDeskItem(stateDir, item.id, 'closed', now);
        if (closed) changed.push(closed);
      }
    } else if (now - (item.doneAt ?? item.createdAt) >= DESK_DONE_MS) { await removeDeskItem(stateDir, item.id); changed.push(item); }
  }
  return changed;
}

/** The tabs the desk is holding for the user: no sweep, worker exit or tab cap may close them. */
export async function deskHeldTargets(stateDir: string, now: number = Date.now()): Promise<Set<string>> {
  const held = new Set<string>();
  for (const item of await listDeskItems(stateDir)) if (item.status === 'waiting' && now - item.createdAt < DESK_WAIT_MS) held.add(item.targetId);
  return held;
}
