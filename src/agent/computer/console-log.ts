/** What a chat's tab has written to its console, and the errors the page threw, kept in a short ring so the agent can
 * read them after the fact (a form that does nothing is often a script error). Text is shortened here and hidden again
 * when it is read: a page can log a token, and a typed password may be echoed into a message. */
import type { ConsoleMessage, Page } from 'playwright-core';
import { sharedState } from './shared-state.js';
import { hideKeyLikeText } from './secret-finder.js';
import { maskSensitive } from './sensitive-fields.js';
import { scrubSecrets } from './secret-scrubber.js';

export type ConsoleEntry = { level: 'error' | 'warning' | 'info' | 'log' | 'debug' | 'pageerror'; text: string; at: number; where?: string };

const KEEP = 200;
const MAX_TEXT = 600;
const logs = sharedState('console-logs', () => new WeakMap<Page, ConsoleEntry[]>());
const watched = sharedState('console-watched', () => new WeakSet<Page>());
const deep = sharedState('console-deep', () => new WeakSet<Page>());

const LEVELS: Readonly<Record<string, ConsoleEntry['level']>> = { error: 'error', warning: 'warning', info: 'info', log: 'log', debug: 'debug', trace: 'debug', assert: 'error' };

/** Start recording this page's console (once per page). */
export function watchConsole(page: Page): void {
  if (watched.has(page)) return;
  watched.add(page);
  const entries: ConsoleEntry[] = [];
  logs.set(page, entries);
  const push = (entry: ConsoleEntry): void => { entries.push(entry); if (entries.length > KEEP) entries.splice(0, entries.length - KEEP); };
  page.on('console', (message: ConsoleMessage) => {
    const at = message.location();
    push({ level: LEVELS[message.type()] ?? 'log', text: message.text().slice(0, MAX_TEXT), at: Date.now(), ...(at.url ? { where: `${at.url.split('?')[0]}:${at.lineNumber + 1}` } : {}) });
  });
  page.on('pageerror', (error: Error) => push({ level: 'pageerror', text: (error.stack || error.message || String(error)).split('\n').slice(0, 4).join(' | ').slice(0, MAX_TEXT), at: Date.now() }));
}

type RemoteArg = { type?: string; value?: unknown; description?: string; unserializableValue?: string };
const argText = (arg: RemoteArg): string => arg.value !== undefined ? (typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)) : (arg.unserializableValue ?? arg.description ?? arg.type ?? '');

/** The browser driver never turns on the page's script runtime events, because a page can tell when they are on (fingerprinting
 * services score it as "developer tools open"). Without them only Chrome's own messages reach the console ring, not the page's
 * console.log calls or its uncaught errors. Asking for the console turns them on for that one tab, from then on. Returns false
 * when they were already on. */
export async function captureScripts(page: Page): Promise<boolean> {
  watchConsole(page);
  if (deep.has(page)) return false;
  deep.add(page);
  const entries = logs.get(page);
  if (!entries) return false;
  const push = (entry: ConsoleEntry): void => { entries.push(entry); if (entries.length > KEEP) entries.splice(0, entries.length - KEEP); };
  try {
    const session = await page.context().newCDPSession(page);
    session.on('Runtime.consoleAPICalled', (event: { type: string; args: RemoteArg[]; stackTrace?: { callFrames: { url: string; lineNumber: number }[] } }) => {
      const frame = event.stackTrace?.callFrames[0];
      push({ level: LEVELS[event.type] ?? 'log', text: event.args.map(argText).join(' ').slice(0, MAX_TEXT), at: Date.now(), ...(frame?.url ? { where: `${frame.url.split('?')[0]}:${frame.lineNumber + 1}` } : {}) });
    });
    session.on('Runtime.exceptionThrown', (event: { exceptionDetails: { text?: string; exception?: { description?: string } } }) => {
      const details = event.exceptionDetails;
      push({ level: 'pageerror', text: (details.exception?.description || details.text || 'Uncaught error').split('\n').slice(0, 4).join(' | ').slice(0, MAX_TEXT), at: Date.now() });
    });
    await session.send('Runtime.enable');
    return true;
  } catch { /* fail-open-ok: the console then holds only Chrome's own messages, as before it was asked for */ return false; }
}

/** The entries to show, oldest first. `level` keeps that level and anything worse (pageerror, error, warning, info, log, debug). */
export function pickConsole(entries: readonly ConsoleEntry[], options: { level?: string; limit?: number; find?: string } = {}): ConsoleEntry[] {
  const order = ['pageerror', 'error', 'warning', 'info', 'log', 'debug'];
  const floor = options.level ? order.indexOf(options.level === 'warn' ? 'warning' : options.level) : -1;
  const wanted = options.find?.toLowerCase();
  const kept = entries.filter(entry => (floor < 0 || order.indexOf(entry.level) <= floor) && (!wanted || entry.text.toLowerCase().includes(wanted)));
  return kept.slice(-Math.min(Math.max(Math.floor(options.limit ?? 30), 1), KEEP));
}

export function describeConsole(entries: readonly ConsoleEntry[], total: number): string {
  if (!entries.length) return total ? 'No console messages match.' : 'The console is empty: nothing logged and no page errors in this tab.';
  const lines = entries.map(entry => `[${entry.level}] ${entry.text}${entry.where ? ` (${entry.where})` : ''}`);
  return `Console of this tab (${entries.length} of ${total} kept, oldest first):\n${lines.join('\n')}`;
}

/** The console for the agent: shortened, with registered secrets, typed credentials and key-like text hidden. */
export async function readConsole(page: Page, options: { level?: string; limit?: number; find?: string; clear?: boolean; scripts?: boolean } = {}): Promise<string> {
  watchConsole(page);
  const started = options.scripts ? await captureScripts(page) : false;
  const all = logs.get(page) ?? [];
  const note = started ? '\nScript messages and page errors are recorded in this tab from now on; reload or repeat the step to see them.' : '';
  const text = describeConsole(pickConsole(all, options), all.length) + note;
  if (options.clear) all.length = 0;
  return hideKeyLikeText(scrubSecrets(await maskSensitive(page, text))).text;
}
