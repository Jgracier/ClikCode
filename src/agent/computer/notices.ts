/** Notices: how a program in the background (a service, a timer, a script) tells the person something, without a chat.
 *
 * `clikcode notify --key <k> --title <t> <message>` puts one lasting entry on the handoff desk's list (the desk, `clikcode computer desk`,
 * `clikcode computer browsers`, `/browsers` and the chat's start-of-turn line all read it) and, the first time, raises a desktop
 * notification when a desktop session can be reached. The same key again while the entry is open only updates it: no second popup.
 * `--clear --key <k>` takes it back when the condition ends. Nothing here starts a model turn.
 *
 * Files only, one per key, under the desk's directory: every process reads the same truth. The first post of a key creates its file
 * exclusively, so two callers racing on one key raise one popup. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { quiet, swallowed } from '../../runtime/lifecycle-log.js';
import { atomicWriteFile } from '../../session/store/files.js';
import { desktopSession, remoteSession } from './browser-launch.js';

export interface Notice {
  key: string;
  title: string;
  /** Plain text, one line, at most NOTICE_MESSAGE_MAX characters. */
  message: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
  /** How many times it was posted while open (1 for the first). */
  count: number;
  /** When the desktop popup was raised, if it was. */
  desktopAt?: number;
}

export type NoticeDelivery = 'desktop' | 'desk' | 'deduped';

export const NOTICE_MESSAGE_MAX = 300;
const TITLE_MAX = 80;
const URL_MAX = 500;
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

const noticesDir = (stateDir: string): string => path.join(stateDir, 'computer', 'desk', 'notices');
const noticeFile = (stateDir: string, key: string): string => path.join(noticesDir(stateDir), `${encodeURIComponent(key)}.json`);

/** One line of plain text: no control characters, whitespace collapsed, cut at `max` with an ellipsis. */
export function plainLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

export function checkNoticeKey(key: string | undefined): string {
  if (!key || !KEY_SHAPE.test(key)) throw new Error('--key is required: 1-80 letters, digits, and . _ : - (for example clikdeploy-unlock).');
  return key;
}

function checkUrl(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`--url is not an address: ${url.slice(0, 80)}`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('--url must be an http or https address.');
  if (url.length > URL_MAX) throw new Error(`--url is longer than ${URL_MAX} characters.`);
  return url;
}

export async function listNotices(stateDir: string): Promise<Notice[]> {
  const names = await fs.readdir(noticesDir(stateDir)).catch(() => [] as string[]);
  const notices: Notice[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const notice = JSON.parse(await fs.readFile(path.join(noticesDir(stateDir), name), 'utf8')) as Notice;
      if (typeof notice.key === 'string' && typeof notice.title === 'string' && Number.isFinite(notice.createdAt)) notices.push(notice);
    } catch (error) { /* being written: the next read sees it whole */ swallowed('agent/computer/notices', error); }
  }
  return notices.sort((a, b) => a.createdAt - b.createdAt);
}

export interface NoticeDeps {
  now?: number;
  /** Raise a desktop notification; true only when one was shown. */
  desktop?: (title: string, body: string) => Promise<boolean>;
}

/** Record a notice and reach the person: a desktop popup the first time a key is posted, an updated entry after that. */
export async function postNotice(stateDir: string, input: { key: string; title: string; message: string; url?: string }, deps: NoticeDeps = {}): Promise<{ delivered: NoticeDelivery; key: string; notice: Notice }> {
  const key = checkNoticeKey(input.key);
  const title = plainLine(input.title, TITLE_MAX);
  if (!title) throw new Error('--title is required.');
  const message = plainLine(input.message, NOTICE_MESSAGE_MAX);
  if (!message) throw new Error('Say the message: clikcode notify --key <key> --title <title> <message...>');
  const url = checkUrl(input.url);
  const now = deps.now ?? Date.now();
  const file = noticeFile(stateDir, key);
  await fs.mkdir(noticesDir(stateDir), { recursive: true, mode: 0o700 });
  const fresh: Notice = { key, title, message, ...(url ? { url } : {}), createdAt: now, updatedAt: now, count: 1 };
  let created = false;
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(fresh)); } finally { await handle.close(); }
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!created) {
    let before: Notice | undefined;
    try { before = JSON.parse(await fs.readFile(file, 'utf8')) as Notice; } catch { before = undefined; }
    const next: Notice = { ...fresh, ...(before && Number.isFinite(before.createdAt) ? { createdAt: before.createdAt, count: (before.count || 1) + 1, ...(before.desktopAt ? { desktopAt: before.desktopAt } : {}) } : {}) };
    await atomicWriteFile(file, JSON.stringify(next), { mode: 0o600, durable: false });
    return { delivered: 'deduped', key, notice: next };
  }
  const shown = await (deps.desktop ?? desktopNotify)(title, url ? `${message}\n${url}` : message).catch(() => false);
  if (!shown) return { delivered: 'desk', key, notice: fresh };
  const next: Notice = { ...fresh, desktopAt: now };
  await atomicWriteFile(file, JSON.stringify(next), { mode: 0o600, durable: false }).catch(quiet('agent/computer/notices'));
  return { delivered: 'desktop', key, notice: next };
}

/** Take a notice back (the condition ended, or the person dismissed it). True when there was one. */
export async function clearNotice(stateDir: string, key: string): Promise<boolean> {
  try { await fs.unlink(noticeFile(stateDir, checkNoticeKey(key))); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

const DESKTOP_LIMIT_MS = 5_000;

/** A desktop notification on the session a person can be sitting at (desktopSession), unless the caller is remote. Linux: notify-send
 * (on the session's bus, found from XDG_RUNTIME_DIR when a service did not inherit it); macOS: osascript. False when there is no
 * desktop, no notifier, or it failed: the desk entry is then the only delivery. */
export async function desktopNotify(title: string, body: string, options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; run?: typeof execFile } = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (remoteSession(env)) return false;
  const session = desktopSession({ env, platform });
  if (!session) return false;
  let command: string;
  let args: string[];
  const childEnv: NodeJS.ProcessEnv = { ...env, ...session };
  if (platform === 'linux') {
    if (!childEnv.DBUS_SESSION_BUS_ADDRESS && env.XDG_RUNTIME_DIR && existsSync(path.join(env.XDG_RUNTIME_DIR, 'bus'))) childEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(env.XDG_RUNTIME_DIR, 'bus')}`;
    command = 'notify-send';
    args = ['--app-name=ClikCode', '--urgency=normal', '--', title, body];
  } else if (platform === 'darwin') {
    const quote = (text: string): string => `"${text.replace(/[\\"]/g, '\\$&')}"`;
    command = 'osascript';
    args = ['-e', `display notification ${quote(body)} with title ${quote(title)}`];
  } else return false;
  const run = options.run ?? execFile;
  return new Promise<boolean>(resolve => {
    try {
      run(command, args, { env: childEnv, timeout: DESKTOP_LIMIT_MS, windowsHide: true }, error => {
        if (error) quiet('agent/computer/notices')(error);
        resolve(!error);
      });
    } catch (error) { quiet('agent/computer/notices')(error); resolve(false); }
  });
}

function age(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.floor(h / 24)}d`;
}

/** The notices as a person reads them, for the lists; empty when there are none. */
export function noticesText(notices: readonly Notice[], now: number, clear: string): string[] {
  if (!notices.length) return [];
  const lines = [`Notices (${notices.length}):`];
  for (const notice of notices) {
    lines.push(`  ${notice.title}: ${notice.message}${notice.url ? ` ${notice.url}` : ''} (${age(now - notice.createdAt)}${notice.count > 1 ? `, said ${notice.count} times` : ''}; key ${notice.key})`);
  }
  lines.push(`  ${clear}`);
  return lines;
}

/** One short line naming the open notices, for the start of a chat's turn; undefined when there are none. */
export function noticesLine(notices: readonly Notice[]): string | undefined {
  if (!notices.length) return undefined;
  const first = notices[notices.length - 1]!;
  const more = notices.length > 1 ? ` (+${notices.length - 1} more)` : '';
  return plainLine(`Notice: ${first.title}: ${first.message}`, 140) + `${more} · /browsers to see, /browsers dismiss <key>`;
}
