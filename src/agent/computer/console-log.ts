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
export async function readConsole(page: Page, options: { level?: string; limit?: number; find?: string; clear?: boolean } = {}): Promise<string> {
  watchConsole(page);
  const all = logs.get(page) ?? [];
  const text = describeConsole(pickConsole(all, options), all.length);
  if (options.clear) all.length = 0;
  return hideKeyLikeText(scrubSecrets(await maskSensitive(page, text))).text;
}
