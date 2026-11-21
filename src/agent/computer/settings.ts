/** Computer control is available by default; an account-local setting can turn it off. */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { objectOrEmpty, updateJsonFile } from '../../session/store/json-file.js';

export function computerSettingsPath(stateDir: string): string {
  return path.join(stateDir, 'computer', 'settings.json');
}

export async function computerEnabled(stateDir: string): Promise<boolean> {
  try { return (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { enabled?: unknown }).enabled !== false; }
  catch { return true; }
}

/** Permission decisions are synchronous; tool execution rechecks the setting. */
export function computerEnabledSync(stateDir: string): boolean {
  try { return (JSON.parse(readFileSync(computerSettingsPath(stateDir), 'utf8')) as { enabled?: unknown }).enabled !== false; }
  catch { return true; }
}

async function writeSettings(stateDir: string, change: Record<string, boolean | string>): Promise<void> {
  await updateJsonFile(computerSettingsPath(stateDir), objectOrEmpty, (current) => ({ ...current, ...change }));
}

export async function setComputerEnabled(stateDir: string, enabled: boolean): Promise<void> {
  await writeSettings(stateDir, { enabled });
}

/** On unless the user turned it off (`clikcode computer passwords off`): the browser tool makes up a strong, unique
 * password for each signup form it fills, keeps it in Secrets Manager with the login, and never shows it. */
export async function generatedPasswordsAllowed(stateDir: string): Promise<boolean> {
  try { return (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { generatePasswords?: unknown }).generatePasswords !== false; }
  catch { return true; }
}

export async function setGeneratedPasswords(stateDir: string, allowed: boolean): Promise<void> {
  await writeSettings(stateDir, { generatePasswords: allowed });
}

/** Off unless the user turned it on (`clikcode computer headless on`) or CLIKCODE_BROWSER_HEADLESS=1: the browser runs
 * with no window at all. A Linux computer with no display does this by itself. */
export async function headlessSetting(stateDir: string): Promise<boolean> {
  try { return (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { headless?: unknown }).headless === true; }
  catch { return false; }
}

export async function setHeadless(stateDir: string, on: boolean): Promise<void> {
  await writeSettings(stateDir, { headless: on });
}

/** Which browser a tab runs in. `local` (default): ClikCode's own Chrome only. `auto`: local first, and a tab moves to
 * Browser Use Cloud only when asked to (a page the local browser cannot get past). `browser-use`: every tab in the cloud.
 * The cloud is a billed remote browser; turning it on never copies local cookies. */
export type BrowserProvider = 'local' | 'auto' | 'browser-use';
export async function browserProvider(stateDir: string): Promise<BrowserProvider> {
  try {
    const value = (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { browserProvider?: unknown }).browserProvider;
    return value === 'browser-use' || value === 'auto' ? value : 'local';
  } catch { return 'local'; }
}
export async function setBrowserProvider(stateDir: string, provider: BrowserProvider): Promise<void> {
  await writeSettings(stateDir, { browserProvider: provider });
}

/** Where ClikCode's own Chrome puts its window (`clikcode computer display visible|hidden`). `hidden` (default): on Linux a virtual
 * display, so its windows never take the screen or the keyboard from the person working; the `show` action opens a live view of one
 * tab instead. `visible`: the desktop the person is sitting at. Read when the shared browser starts, never applied to a running one
 * (every chat's tabs live in it). macOS and Windows have no hidden display: the window is always on the desktop there. */
export type BrowserDisplay = 'hidden' | 'visible';
export const parseBrowserDisplay = (value: unknown): BrowserDisplay | undefined => (value === 'hidden' || value === 'visible' ? value : undefined);
export async function browserDisplay(stateDir: string): Promise<BrowserDisplay> {
  try { return parseBrowserDisplay((JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { display?: unknown }).display) ?? 'hidden'; }
  catch { return 'hidden'; }
}
export async function setBrowserDisplay(stateDir: string, display: BrowserDisplay): Promise<void> {
  await writeSettings(stateDir, { display });
}

export const COMPUTER_OFF = 'Computer use is off. Run `clikcode computer on` to enable it.';

/** Off unless the user turned it on: a private prompt the browser tool would show (a password, a code, an account
 * choice) is instead parked in the vendor queue as needs-human, and the agent is told to move on. For a long run
 * over many vendors that nobody sits through. */
export async function unattendedEnabled(stateDir: string): Promise<boolean> {
  try { return (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { unattended?: unknown }).unattended === true; }
  catch { return false; }
}

export async function setUnattended(stateDir: string, on: boolean): Promise<void> {
  await writeSettings(stateDir, { unattended: on });
}

/** On unless the user turned it off (`clikcode computer captcha off`): when a human check asks a puzzle, ClikCode
 * solves it itself -- a picture of the challenge goes to the account's own Gateway vision model and its answer is
 * played back into the page at a visitor's pace. This is built-in captcha solving, the same capability other
 * agents get from an external solving service; nothing leaves this machine but the puzzle's pixels. */
export async function captchaSolvingAllowed(stateDir: string): Promise<boolean> {
  try { return (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { solveCaptchas?: unknown }).solveCaptchas !== false; }
  catch { return true; }
}

export async function setCaptchaSolving(stateDir: string, allowed: boolean): Promise<void> {
  await writeSettings(stateDir, { solveCaptchas: allowed });
}

// ── egress: the network ways out a browser tab can leave through ──

/** A way out to the internet other than this computer's own connection. `ssh`: ClikCode keeps an `ssh -D` SOCKS tunnel to that
 * host up and sends the tab's traffic through it (an alias from ~/.ssh/config, or user@host). `proxy`: a SOCKS or HTTP proxy used as is. */
export interface EgressEntry { name: string; ssh?: string; proxy?: string }
/** This computer's own connection: always first, never stored. */
export const HOME_EGRESS = 'home';

const EGRESS_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** An ssh destination, never an option: letters, digits, dot, dash, underscore and one optional user@. */
const SSH_TARGET = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROXY_URL = /^(?:socks5|socks4|http|https):\/\/(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):\d{1,5}\/?$/;

/** Why an egress entry cannot be used, or undefined when it can. */
export function egressProblem(entry: { name?: unknown; ssh?: unknown; proxy?: unknown }): string | undefined {
  if (typeof entry.name !== 'string' || !EGRESS_NAME.test(entry.name)) return 'An egress name is lower-case letters, digits and dashes (at most 32).';
  if (entry.name === HOME_EGRESS) return '"home" is this computer\'s own connection; it is always there and needs no entry.';
  const hasSsh = entry.ssh !== undefined, hasProxy = entry.proxy !== undefined;
  if (hasSsh === hasProxy) return 'Give an egress either ssh (an ssh host) or proxy (socks5://host:port or http://host:port), not both.';
  if (hasSsh && (typeof entry.ssh !== 'string' || !SSH_TARGET.test(entry.ssh))) return 'ssh is a host from ~/.ssh/config or user@host (letters, digits, dot, dash, underscore).';
  if (hasProxy) {
    if (typeof entry.proxy !== 'string' || !PROXY_URL.test(entry.proxy)) return 'proxy is socks5://host:port, socks4://host:port, http://host:port or https://host:port.';
    const port = Number(/:(\d+)\/?$/.exec(entry.proxy)?.[1]);
    if (!(port >= 1 && port <= 65535)) return 'The proxy port is 1 to 65535.';
  }
  return undefined;
}

/** The valid entries of a stored egress list, in order, first of each name only. */
export function parseEgress(value: unknown): EgressEntry[] {
  if (!Array.isArray(value)) return [];
  const out: EgressEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as { name?: unknown; ssh?: unknown; proxy?: unknown };
    if (egressProblem(raw) || out.some(entry => entry.name === raw.name)) continue;
    out.push({ name: raw.name as string, ...(raw.ssh !== undefined ? { ssh: raw.ssh as string } : { proxy: (raw.proxy as string).replace(/\/$/, '') }) });
  }
  return out;
}

/** The configured ways out (home not included). */
export async function egressSetting(stateDir: string): Promise<EgressEntry[]> {
  try { return parseEgress((JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { egress?: unknown }).egress); }
  catch { return []; }
}

/** Every way out in the order they are tried: home first, then the configured ones. */
export async function egressList(stateDir: string): Promise<EgressEntry[]> {
  return [{ name: HOME_EGRESS }, ...await egressSetting(stateDir)];
}

/** Adds an egress, or replaces the one of the same name in place. */
export async function addEgress(stateDir: string, entry: EgressEntry): Promise<EgressEntry[]> {
  const problem = egressProblem(entry);
  if (problem) throw new Error(problem);
  const clean: EgressEntry = { name: entry.name, ...(entry.ssh !== undefined ? { ssh: entry.ssh } : { proxy: entry.proxy!.replace(/\/$/, '') }) };
  const after = await updateJsonFile(computerSettingsPath(stateDir), objectOrEmpty, current => {
    const list = parseEgress(current.egress);
    const at = list.findIndex(item => item.name === clean.name);
    if (at >= 0) list[at] = clean; else list.push(clean);
    return { ...current, egress: list };
  });
  return parseEgress(after.egress);
}

/** Removes an egress by name; false when there was none. */
export async function removeEgress(stateDir: string, name: string): Promise<boolean> {
  let removed = false;
  await updateJsonFile(computerSettingsPath(stateDir), objectOrEmpty, current => {
    const list = parseEgress(current.egress);
    const kept = list.filter(item => item.name !== name);
    removed = kept.length !== list.length;
    return removed ? { ...current, egress: kept } : undefined;
  });
  return removed;
}

// ── tunable values: `clikcode computer settings [name] [value]` ──

/** The values a user may tune, with their defaults and what each does. Shown by `clikcode computer settings`. */
export const COMPUTER_TUNABLES = {
  agentModel: { default: 'claude-sonnet-5-5', about: 'The model a headless agent (`clikcode agent run`) runs on under Claude Code. Codex runs on the chat\'s own model.' },
  captchaVoterModel: { default: 'claude-haiku-5-5', about: 'The model the captcha voter on your Claude subscription uses for a hard picture question.' },
  captchaSubscription: { default: true, about: 'Let a hard captcha question be answered on your signed-in Claude or Codex subscription (off: Gateway voters only).' },
  captchaVoteLog: { default: false, about: 'Print each captcha voter\'s answer to stderr while solving (for diagnosing the solver).' },
  keygrabLog: { default: false, about: 'Print each keygrab step to stderr (for diagnosing a key capture).' },
} as const;
export type ComputerTunable = keyof typeof COMPUTER_TUNABLES;
type TunableValue<K extends ComputerTunable> = (typeof COMPUTER_TUNABLES)[K]['default'] extends boolean ? boolean : string;

export async function computerTunable<K extends ComputerTunable>(stateDir: string, name: K): Promise<TunableValue<K>> {
  const fallback = COMPUTER_TUNABLES[name].default as TunableValue<K>;
  try {
    const value = ((JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { tunables?: Record<string, unknown> }).tunables ?? {})[name];
    return (typeof value === typeof fallback ? value : fallback) as TunableValue<K>;
  } catch { return fallback; }
}

/** Sets one tunable from its text form (on/off/true/false for a switch); `default` removes it. Returns the value now in force. */
export async function setComputerTunable(stateDir: string, name: string, text: string): Promise<string | boolean> {
  if (!(name in COMPUTER_TUNABLES)) throw new Error(`No setting "${name}". Settings: ${Object.keys(COMPUTER_TUNABLES).join(', ')}.`);
  const key = name as ComputerTunable;
  const fallback = COMPUTER_TUNABLES[key].default;
  let value: string | boolean | undefined;
  if (text === 'default') value = undefined;
  else if (typeof fallback === 'boolean') {
    if (!/^(on|off|true|false)$/i.test(text)) throw new Error(`${name} is on or off.`);
    value = /^(on|true)$/i.test(text);
  } else {
    if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(text)) throw new Error(`${name} is a model name such as ${fallback}.`);
    value = text;
  }
  await updateJsonFile(computerSettingsPath(stateDir), objectOrEmpty, current => {
    const tunables = { ...((current.tunables as Record<string, unknown> | undefined) ?? {}) };
    if (value === undefined) delete tunables[key]; else tunables[key] = value;
    return { ...current, tunables };
  });
  return value ?? fallback;
}
