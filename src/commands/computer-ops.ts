/** Commands that give scripts and other programs ClikCode's computer abilities as JSON: a headless agent run, the bounded computer tools
 * server, keygrab, OAuth consent, a page read, tabs, the handoff desk's finished items, tunable settings, and saved keys used without
 * being shown. Every answer is one JSON object on stdout. */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { quiet } from '../runtime/lifecycle-log.js';
import { stateDirectory } from '../session/store/paths.js';
import type { DriveOutcome, KeygrabDelivery, StopInfo } from '../agent/computer/keygrab-types.js';

const print = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value)}\n`);
const whole = (value: string | undefined, name: string, min: number, max: number): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} is a whole number from ${min} to ${max}.`);
  return n;
};
const NAME = /^[a-z0-9][a-z0-9._/-]{0,95}$/i;
const TAB = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const tabOf = (tab: string | undefined, fallback: string): string => { const t = tab ?? fallback; if (!TAB.test(t)) throw new Error('--tab is letters, digits, dots, dashes and underscores.'); return t; };
async function readText(file: string): Promise<string> {
  if (file !== '-') return readFile(file, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// ── clikcode agent run ──

export interface AgentRunFlags { promptFile: string; tab?: string; egress?: string; blockUrl?: string[]; blockMessage?: string; mcpConfig?: string; maxCalls?: string; maxMinutes?: string; stallMinutes?: string; session?: string; model?: string }
export async function agentRun(flags: AgentRunFlags): Promise<void> {
  const { runHeadlessAgent } = await import('../agent/headless/run.js');
  const prompt = (await readText(flags.promptFile)).trim();
  if (!prompt) throw new Error('The prompt is empty.');
  for (const pattern of flags.blockUrl ?? []) new RegExp(pattern, 'i');
  let servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> | undefined;
  if (flags.mcpConfig) {
    const parsed = JSON.parse(await readFile(flags.mcpConfig, 'utf8')) as { mcpServers?: typeof servers };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') throw new Error('--mcp-config is a JSON file with {"mcpServers": {name: {command, args, env}}}.');
    servers = parsed.mcpServers;
  }
  const { untilStopped } = await import('../cli/stop-signal.js');
  // Ctrl-C, SIGTERM or a closed terminal stop the agent and its tool servers (each tab closed), and the run's files are removed.
  const result = await untilStopped(signal => runHeadlessAgent({
    prompt, stateDir: stateDirectory(), signal,
    ...(flags.tab ? { computer: { tab: tabOf(flags.tab, ''), ...(flags.egress ? { egress: flags.egress } : {}), ...(flags.blockUrl?.length ? { blockUrls: flags.blockUrl } : {}), ...(flags.blockMessage ? { blockMessage: flags.blockMessage } : {}) } } : {}),
    ...(servers ? { servers } : {}),
    maxCalls: whole(flags.maxCalls, 'max-calls', 1, 1000) ?? 60,
    maxMs: (whole(flags.maxMinutes, 'max-minutes', 1, 240) ?? 20) * 60_000,
    stallMs: (whole(flags.stallMinutes, 'stall-minutes', 1, 60) ?? 5) * 60_000,
    ...(flags.session ?? process.env.CLIKCODE_SESSION_ID ? { sessionId: flags.session ?? process.env.CLIKCODE_SESSION_ID } : {}),
    ...(flags.model ? { model: flags.model } : {}),
  }));
  print(result);
  if (result.error) process.exitCode = 1;
}

// ── clikcode computer mcp ──

export interface ComputerMcpFlags { tab: string; maxCalls?: string; activity?: string; egress?: string; blockUrl?: string[]; blockMessage?: string }
export async function computerMcp(flags: ComputerMcpFlags, signal: AbortSignal): Promise<void> {
  const { serveComputerMcp, maxCallsFromEnv } = await import('../agent/headless/computer-mcp.js');
  await serveComputerMcp({
    tab: tabOf(flags.tab, ''), maxCalls: whole(flags.maxCalls, 'max-calls', 1, 5000) ?? maxCallsFromEnv() ?? 200,
    ...(flags.activity ? { activity: flags.activity } : {}), ...(flags.egress ? { egress: flags.egress } : {}),
    ...(flags.blockUrl?.length ? { blockUrls: flags.blockUrl } : {}), ...(flags.blockMessage ? { blockMessage: flags.blockMessage } : {}),
  }, signal);
}

// ── clikcode computer keygrab ──

export interface KeygrabFlags { tab?: string; egress?: string; maxMinutes?: string; maxSteps?: string; alternate?: string[]; sendTo?: string; keyName?: string; secretName?: string }
function delivery(flags: Pick<KeygrabFlags, 'sendTo' | 'keyName' | 'secretName'>): KeygrabDelivery {
  let sendTo: KeygrabDelivery['sendTo'];
  if (flags.sendTo) {
    const parsed = JSON.parse(flags.sendTo) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (!list.every(d => d && typeof d === 'object' && typeof (d as { to?: unknown }).to === 'string')) throw new Error('--send-to is a JSON destination {"to": ..., "with": {...}} or a list of them.');
    sendTo = list as KeygrabDelivery['sendTo'];
  }
  if (flags.keyName && !/^[\w .-]{1,40}$/.test(flags.keyName)) throw new Error('--key-name is up to 40 letters, digits, spaces, dots and dashes.');
  if (flags.secretName && !NAME.test(flags.secretName)) throw new Error('--secret-name is a vault name such as acme/key.');
  return { ...(sendTo ? { sendTo } : {}), ...(flags.keyName ? { keyName: flags.keyName } : {}), ...(flags.secretName ? { secretName: flags.secretName } : {}) };
}

export async function computerKeygrab(name: string, url: string, flags: KeygrabFlags): Promise<void> {
  if (!NAME.test(name) || name.includes('/')) throw new Error('The name is letters, digits, dots and dashes (the site or service the key is for).');
  if (!/^https?:\/\//.test(url)) throw new Error('The address is an http(s) page to start from.');
  const alternates = (flags.alternate ?? []).filter(a => /^https?:\/\//.test(a));
  const dir = stateDirectory();
  const { liveKeygrab } = await import('../agent/computer/keygrab-live.js');
  const tab = tabOf(flags.tab, 'keygrab');
  if (flags.egress) await (await import('../agent/computer/browser.js')).bindTabEgress(dir, tab, flags.egress);
  const outcome = await liveKeygrab({ stateDir: dir, tab, delivery: delivery(flags) }, name, url, { maxMs: (whole(flags.maxMinutes, 'max-minutes', 1, 120) ?? 5) * 60_000, ...(whole(flags.maxSteps, 'max-steps', 1, 200) ? { maxSteps: whole(flags.maxSteps, 'max-steps', 1, 200)! } : {}), ...(alternates.length ? { alternates } : {}) });
  print(outcome);
}

export interface KeygrabResumeFlags { click?: string; goto?: string; only?: boolean; maxMinutes?: string; maxSteps?: string; sendTo?: string; keyName?: string; secretName?: string }
export async function computerKeygrabResume(name: string, flags: KeygrabResumeFlags): Promise<void> {
  if (flags.click && flags.goto) throw new Error('Give --click or --goto, not both.');
  const { resumeKeygrab } = await import('../agent/computer/keygrab-resume.js');
  const maxMinutes = whole(flags.maxMinutes, 'max-minutes', 1, 60), maxSteps = whole(flags.maxSteps, 'max-steps', 1, 100);
  const result = await resumeKeygrab({ stateDir: stateDirectory(), id: name, delivery: delivery(flags), ...(flags.click ? { click: flags.click } : {}), ...(flags.goto ? { goto: flags.goto } : {}), ...(flags.only ? { only: true } : {}), ...(maxMinutes ? { maxMs: maxMinutes * 60_000 } : {}), ...(maxSteps ? { maxSteps } : {}) });
  print({ name, reattached: result.reattached, ...(result.pressed ? { pressed: result.pressed } : {}), outcome: result.outcome });
}

/** The back-off after a captcha keygrab could not clear: when the site may be tried again. */
export async function computerKeygrabBackoff(name: string, flags: { set?: boolean; clear?: boolean }): Promise<void> {
  const park = await import('../agent/computer/keygrab-park.js');
  const dir = stateDirectory();
  if (flags.set && flags.clear) throw new Error('Give --set or --clear, not both.');
  if (flags.clear) { await park.clearBackoff(dir, name); return print({ name, until: null }); }
  const until = flags.set ? await park.recordBackoff(dir, name) : await park.backoffUntil(dir, name);
  print({ name, until: until?.toISOString() ?? null, hours: park.BACKOFF_HOURS });
}

// ── clikcode computer oauth-connect --json ──

/** Page text and the names of what can be pressed, for a stop that has no detail of its own. */
async function look(page: import('playwright-core').Page): Promise<{ text: string; controls: string[] }> {
  const text = await page.evaluate(() => ((globalThis as unknown as { document: { body?: { innerText?: string } } }).document.body?.innerText ?? '').slice(0, 4000)).catch(() => '');
  const controls = await page.evaluate(() => Array.from((globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document.querySelectorAll('button, [role=button], a')).map(n => (n.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length <= 60).slice(0, 12)).catch(() => [] as string[]);
  return { text, controls };
}

/** Runs the OAuth consent for `connector` in a fresh tab and says how it ended, as a keygrab-style outcome. */
export async function oauthConnectOutcome(connector: string, options: { tab?: string; egress?: string; progress?: (line: string) => void } = {}): Promise<DriveOutcome> {
  const dir = stateDirectory();
  const tab = tabOf(options.tab, 'oauth');
  const { oauthConnect, ConsentStop, pageExcerpt } = await import('../agent/computer/oauth-consent.js');
  const { scrubSecrets } = await import('../agent/computer/secret-scrubber.js');
  const browser = await import('../agent/computer/browser.js');
  const { profileEmail } = await import('../agent/computer/profiles.js');
  if (options.egress) await browser.bindTabEgress(dir, tab, options.egress);
  let page = await browser.openNewComputerPage(dir, tab);
  const reopen = async (old: typeof page): Promise<typeof page> => { await browser.closeOwnedPage(dir, old, tab).catch(quiet('commands/computer-ops')); page = await browser.openNewComputerPage(dir, tab); return page; };
  try {
    const done = await oauthConnect(connector, page, { email: await profileEmail(dir), stateDir: dir, reopen, ...(options.progress ? { progress: options.progress } : {}) });
    return { ok: true, note: `consent finished: ${done.steps.length} presses, an active connection is shown` };
  } catch (error) {
    const message = scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300);
    if (!(error instanceof ConsentStop)) return { ok: false, stop: { kind: 'unknown', message, url: '', pageText: '', controls: [] } };
    const looked = error.detail ? undefined : await look(page);
    const seen: Pick<StopInfo, 'kind' | 'url' | 'pageText' | 'controls'> = error.detail ?? { kind: 'unknown', url: '', pageText: pageExcerpt(looked?.text ?? ''), controls: looked?.controls ?? [] };
    return { ok: false, stop: { ...seen, message } };
  } finally {
    await browser.closeComputerPage(dir, tab).catch(quiet('commands/computer-ops'));
    await browser.releaseComputerBrowser(dir).catch(quiet('commands/computer-ops'));
  }
}

// ── clikcode computer page read|fetch ──

export interface PageFlags { tab?: string; egress?: string; evalFile?: string; collect?: string; timeout?: string; humanCheck?: boolean; maxBytes?: string }
export async function computerPageRead(url: string, flags: PageFlags): Promise<void> {
  const { readPage } = await import('../agent/computer/page-read.js');
  const dir = stateDirectory();
  try {
    print(await readPage(dir, url, {
      tab: tabOf(flags.tab, 'page'), ...(flags.egress ? { egress: flags.egress } : {}),
      ...(flags.evalFile ? { evaluate: await readText(flags.evalFile) } : {}), ...(flags.collect ? { collect: new RegExp(flags.collect, 'i') } : {}),
      ...(whole(flags.timeout, 'timeout', 1, 120) ? { timeoutMs: whole(flags.timeout, 'timeout', 1, 120)! * 1000 } : {}),
      ...(whole(flags.maxBytes, 'max-bytes', 1000, 50_000_000) ? { maxFileBytes: whole(flags.maxBytes, 'max-bytes', 1000, 50_000_000)! } : {}),
      ...(flags.humanCheck ? { humanCheck: true } : {}),
    }));
  } finally { await (await import('../agent/computer/browser.js')).releaseComputerBrowser(dir).catch(quiet('commands/computer-ops')); }
}

export async function computerPageFetch(url: string, flags: PageFlags): Promise<void> {
  const { fetchInBrowser } = await import('../agent/computer/page-read.js');
  const dir = stateDirectory();
  try {
    print(await fetchInBrowser(dir, url, { tab: tabOf(flags.tab, 'page'), ...(flags.egress ? { egress: flags.egress } : {}), ...(whole(flags.maxBytes, 'max-bytes', 1000, 50_000_000) ? { maxBytes: whole(flags.maxBytes, 'max-bytes', 1000, 50_000_000)! } : {}) }));
  } finally { await (await import('../agent/computer/browser.js')).releaseComputerBrowser(dir).catch(quiet('commands/computer-ops')); }
}

// ── clikcode computer tab list|close ──

export async function computerTabList(): Promise<void> {
  const { readTabRecords } = await import('../agent/computer/tab-registry.js');
  print({ tabs: (await readTabRecords(stateDirectory())).map(r => ({ tab: r.tab ?? null, lastUsedAt: new Date(r.lastUsedAt).toISOString(), openedAt: new Date(r.openedAt).toISOString(), ...(r.parked ? { parked: true } : {}), ...(r.egress ? { egress: r.egress } : {}) })) });
}

export async function computerTabClose(tabs: string[]): Promise<void> {
  const { closeTabsByLabel } = await import('../agent/computer/tab-registry.js');
  const closed: string[] = [];
  for (const tab of tabs) { tabOf(tab, ''); if ((await closeTabsByLabel(stateDirectory(), tab).catch(() => [])).length) closed.push(tab); }
  print({ closed });
}

// ── clikcode computer desk finished ──

/** Items the user finished on the handoff desk that name something to resume. --take marks them taken so the next call skips them. */
export async function computerDeskFinished(flags: { take?: boolean; remove?: string }): Promise<void> {
  const desk = await import('../agent/computer/handoff-desk-store.js');
  const dir = stateDirectory();
  if (flags.remove) {
    for (const item of await desk.listDeskItems(dir)) if (item.resume === flags.remove && item.status === 'waiting') await desk.removeDeskItem(dir, item.id);
    return print({ removed: flags.remove });
  }
  const items = flags.take ? await desk.takeFinishedResumes(dir) : (await desk.listDeskItems(dir)).filter(item => item.status === 'done' && item.resume && !item.resumeSent);
  print({ finished: items.map(item => ({ id: item.id, resume: item.resume, kind: item.kind, label: item.label })) });
}

// ── clikcode computer settings ──

export async function computerSettings(name?: string, value?: string): Promise<void> {
  const { COMPUTER_TUNABLES, computerTunable, setComputerTunable } = await import('../agent/computer/settings.js');
  const dir = stateDirectory();
  if (name && value !== undefined) return print({ [name]: await setComputerTunable(dir, name, value) });
  const names = name ? [name] : Object.keys(COMPUTER_TUNABLES);
  const out: Record<string, unknown> = {};
  for (const key of names) {
    if (!(key in COMPUTER_TUNABLES)) throw new Error(`No setting "${key}". Settings: ${Object.keys(COMPUTER_TUNABLES).join(', ')}.`);
    const k = key as keyof typeof COMPUTER_TUNABLES;
    out[key] = { value: await computerTunable(dir, k), default: COMPUTER_TUNABLES[k].default, about: COMPUTER_TUNABLES[k].about };
  }
  print(out);
}

// ── clikcode computer secrets rename|generate|call ──

export async function computerSecretRename(from: string, to: string): Promise<void> {
  if (!NAME.test(from) || !NAME.test(to)) throw new Error('Secret names are letters, digits, dots, dashes and slashes.');
  const vault = await import('../agent/computer/credential-vault.js');
  // Two spellings of one key (acme/api-key, acme/key) are one secret: saving under the new one would rotate the old file in place,
  // and removing the old name would then delete the key itself.
  if (vault.canonicalSecretName(from) === vault.canonicalSecretName(to)) throw new Error(`"${from}" and "${to}" already name the same secret; nothing to rename.`);
  const dir = stateDirectory();
  const info = (await vault.namedSecretInfo(dir)).find(item => item.name === from);
  const value = info ? await vault.readNamedSecret(dir, from).catch(() => '') : '';
  if (!value) return print({ renamed: false, from, to });
  await vault.saveNamedSecret(dir, to, value, { ...(info?.meta?.vendor ? { vendor: info.meta.vendor } : {}), ...(info?.meta?.owner ? { owner: info.meta.owner } : {}), ...(info?.meta?.url ? { url: info.meta.url } : {}), ...(info?.meta?.page ? { page: info.meta.page } : {}) }, { legacy: true });
  print({ renamed: await vault.deleteNamedSecret(dir, from), from, to });
}

/** The vendor recorded on a token `secrets generate` made: only such a token can be used by `secrets call`. */
export const GENERATED_TOKEN = 'generated-token';

/** Makes a random token, keeps it in the vault for `origin` (the only site `secrets call` will send it to), and prints its SHA-256 only. */
export async function computerSecretGenerate(name: string, flags: { url: string; prefix?: string; bytes?: string }): Promise<void> {
  if (!NAME.test(name)) throw new Error('The secret name is letters, digits, dots, dashes and slashes.');
  const origin = flags.url.replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) throw new Error('--url is the https origin the token is for, e.g. https://example.com');
  const prefix = flags.prefix ?? '';
  if (!/^[A-Za-z0-9_-]{0,20}$/.test(prefix)) throw new Error('--prefix is up to 20 letters, digits, dashes and underscores.');
  const token = `${prefix}${randomBytes(whole(flags.bytes, 'bytes', 16, 64) ?? 32).toString('hex')}`;
  const { registerSecret } = await import('../agent/computer/secret-scrubber.js');
  registerSecret(token);
  await (await import('../agent/computer/credential-vault.js')).saveGeneratedToken(stateDirectory(), name, token, origin, { vendor: GENERATED_TOKEN });
  print({ name, url: origin, sha256: createHash('sha256').update(token).digest('hex') });
}

/** One HTTPS request to the site a saved token belongs to, with the token as a Bearer credential. The token is never shown, and it goes
 * only to the https origin recorded with it when it was saved, so this cannot send a key anywhere else. */
export async function computerSecretCall(name: string, flags: { path: string; method?: string; header?: string[]; dataFile?: string; timeout?: string }): Promise<void> {
  const vault = await import('../agent/computer/credential-vault.js');
  const dir = stateDirectory();
  const info = (await vault.namedSecretInfo(dir)).find(item => item.name === name);
  if (!info) throw new Error(`No saved token named "${name}".`);
  // Only a token made here for one site, sent only to the origin pinned when it was made. The record's url and vendor tag are not
  // trusted: a later setSecretUrl, a merge from another computer or any save of a secret can change them.
  const pinned = await vault.pinnedToken(dir, name);
  if (!pinned) throw new Error(`"${name}" was not made by \`clikcode computer secrets generate\` on this computer (or was changed since); only such a token can be used this way.`);
  if (info.meta?.url && info.meta.url !== pinned.origin) throw new Error(`The site recorded for "${name}" (${info.meta.url}) is not the one it was made for (${pinned.origin}); it is not sent.`);
  const origin = pinned.origin;
  let base: URL;
  try { base = new URL(origin); } catch { throw new Error(`The site recorded for "${name}" is not an address.`); }
  if (base.protocol !== 'https:') throw new Error(`The site recorded for "${name}" is not https.`);
  if (!flags.path.startsWith('/') || flags.path.startsWith('//')) throw new Error('--path is a path on that site, starting with one /.');
  const target = new URL(flags.path, base.origin);
  if (target.origin !== base.origin) throw new Error('--path must stay on the site the token belongs to.');
  const token = pinned.value;
  const { registerSecret, scrubSecrets } = await import('../agent/computer/secret-scrubber.js');
  registerSecret(token);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  for (const line of flags.header ?? []) {
    const at = line.indexOf(':');
    if (at < 1) throw new Error('--header is name: value');
    const key = line.slice(0, at).trim().toLowerCase();
    if (key === 'authorization' || key === 'host' || key === 'cookie') throw new Error(`--header may not set ${key}.`);
    headers[key] = line.slice(at + 1).trim();
  }
  const method = (flags.method ?? (flags.dataFile ? 'POST' : 'GET')).toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) throw new Error('--method is GET, POST, PUT, PATCH or DELETE.');
  const response = await fetch(target, { method, headers, ...(flags.dataFile ? { body: await readText(flags.dataFile) } : {}), signal: AbortSignal.timeout((whole(flags.timeout, 'timeout', 1, 600) ?? 90) * 1000) });
  print({ status: response.status, contentType: response.headers.get('content-type') ?? '', body: scrubSecrets(await response.text()) });
}
