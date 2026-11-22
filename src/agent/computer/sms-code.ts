/** One-time codes sent by text message, read from a Mac that receives the user's texts (an iPhone's Text Message
 * Forwarding puts every SMS in that Mac's Messages database). ClikCode reaches the Mac over SSH and asks the
 * database, read-only, for the incoming texts since the page asked; only the code and its sender come back, never
 * the message, and nothing else in the database is read. Turned on with `clikcode computer sms <user@host>`. */
import { spawn } from 'node:child_process';
import { objectOrEmpty, updateJsonFile } from '../../session/store/json-file.js';
import { verificationCode } from './email-code.js';
import { computerSettingsPath } from './settings.js';

const TARGET = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9._-]{1,253}$/;
/** Apple's clock starts at 2001-01-01; macOS 10.13 and later count nanoseconds, older ones seconds. */
const APPLE_EPOCH = 978_307_200;

export async function smsSource(stateDir: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises');
  try {
    const value = (JSON.parse(await readFile(computerSettingsPath(stateDir), 'utf8')) as { smsSsh?: unknown }).smsSsh;
    return typeof value === 'string' && TARGET.test(value) ? value : undefined;
  } catch { return undefined; }
}

export async function setSmsSource(stateDir: string, target: string | undefined): Promise<void> {
  if (target !== undefined && !TARGET.test(target)) throw new Error('Give the Mac as user@host (an SSH address this computer can reach without a password), or off.');
  await updateJsonFile(computerSettingsPath(stateDir), objectOrEmpty, current => {
    const next = { ...current } as Record<string, unknown>;
    if (target) next.smsSsh = target; else delete next.smsSsh;
    return next;
  });
}

/** The query, as one argument for the Mac's shell: no quotes inside, so nothing in it can be read as shell. */
export function messagesQuery(sinceUnixSeconds: number, limit = 12): string {
  const since = Math.max(0, Math.floor(sinceUnixSeconds));
  const sent = `((CASE WHEN m.date > 100000000000 THEN m.date / 1000000000 ELSE m.date END) + ${APPLE_EPOCH})`;
  return `SELECT ${sent} || char(31) || coalesce(h.id, char(63)) || char(31) || replace(replace(coalesce(m.text, char(32)), char(10), char(32)), char(13), char(32)) FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID WHERE m.is_from_me = 0 AND ${sent} >= ${since} ORDER BY m.date DESC LIMIT ${Math.max(1, Math.min(50, Math.floor(limit)))};`;
}

/** The code in a text: the email rule, then the forms texts use ("G-123456 is your Google verification code"). */
export function textedCode(text: string): string | undefined {
  return verificationCode(text)
    // "verification code is: 3250", "Your verification PIN is 5824", "OTP: 4410" (CallHub's and others' texts, missed on 2026-11-18).
    ?? /\b(?:code|otp|passcode|pin)\s*(?:is\s*)?[:#-]?\s*(?:[A-Z]{1,3}-)?(\d{4,8})\b/i.exec(text)?.[1]
    ?? /(?:^|[^\w])(?:[A-Z]{1,3}-)?(\d{4,8})\b[^.\n]{0,50}\b(?:code|otp|passcode|pin)\b/i.exec(text)?.[1];
}

export interface TextedCode { code: string; from: string; at: number }

/** Who the text must come from: `from` (a sender number, short code or word in the text) and/or `site` (the page the code is for:
 * its vendor name must be in the sender or the text, as "Your Acme code is 4821" has it). `from: "any"` takes any sender. */
export interface TextFilter { from?: string; site?: string }

const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9+]/g, '');
function wantedText(sender: string, text: string, filter: TextFilter): boolean {
  const { from, site } = filter;
  if (from && from.toLowerCase() !== 'any') {
    const wanted = squash(from);
    if (!(wanted && squash(sender).includes(wanted)) && !text.toLowerCase().includes(from.toLowerCase())) return false;
  }
  if (site && !(from && from.toLowerCase() !== 'any')) {
    const vendor = vendorName(site);
    if (vendor && !squash(sender).includes(vendor) && !squash(text).includes(vendor)) return false;
  }
  return true;
}
/** The vendor a page belongs to (acme for https://app.acme.co.uk/signup), squashed; undefined for an address that is not one. */
function vendorName(site: string): string | undefined {
  try {
    const parts = new URL(site).hostname.replace(/^www\./, '').split('.');
    const name = parts.length > 2 && ['co', 'com', 'org', 'net'].includes(parts.at(-2)!) ? parts.at(-3)! : parts.at(-2) ?? parts[0]!;
    return squash(name) || undefined;
  } catch { return squash(site) || undefined; }
}

/** Every code among the rows the query returned (unix seconds, sender, text), newest first, that passes `filter`. */
export function codesFromRows(output: string, filter: TextFilter | string = {}): TextedCode[] {
  const wanted = typeof filter === 'string' ? { from: filter } : filter;
  const found: TextedCode[] = [];
  for (const line of output.split('\n')) {
    const [at, sender = '', text = ''] = line.split('\u001f');
    if (!at || !text.trim() || !wantedText(sender, text, wanted)) continue;
    const code = textedCode(text);
    if (code) found.push({ code, from: sender, at: Number(at) });
  }
  return found.sort((x, y) => y.at - x.at);
}

/** The newest code among the rows, optionally from one sender. */
export function codeFromRows(output: string, filter: TextFilter | string = {}): TextedCode | undefined {
  return codesFromRows(output, filter)[0];
}

/** Why the Mac would not answer, in words the user can act on. */
export function smsProblem(stderr: string, target: string): string {
  if (/unable to open database|authorization denied|operation not permitted/i.test(stderr)) {
    return `The Mac (${target}) would not let SSH read Messages: give Full Disk Access to remote logins. On macOS 13 or later: System Settings > General > Sharing > Remote Login (i) > "Allow full disk access for remote users". On macOS 10.15 to 12: System Preferences > Security & Privacy > Privacy > Full Disk Access > + > press Cmd+Shift+G, type /usr/libexec/sshd-keygen-wrapper, add it.`;
  }
  if (/permission denied \(publickey|host key verification failed|could not resolve|connection (?:refused|timed out)|no route/i.test(stderr)) return `This computer could not sign in to ${target} over SSH (${stderr.trim().split('\n').pop()?.slice(0, 120)}). It needs key sign-in with no password.`;
  return `Reading texts on ${target} failed: ${stderr.trim().split('\n').pop()?.slice(0, 160) || 'no answer'}`;
}

/** Runs the query on the Mac; the rows, or why it failed. */
export async function askMessages(target: string, sinceUnixSeconds: number, signal?: AbortSignal): Promise<{ rows: string } | { error: string }> {
  const remote = `sqlite3 -readonly "$HOME/Library/Messages/chat.db" '${messagesQuery(sinceUnixSeconds)}'`;
  return new Promise(resolve => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, remote], { stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out = (out + String(chunk)).slice(-200_000); });
    child.stderr.on('data', chunk => { err = (err + String(chunk)).slice(-4_000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', error => { clearTimeout(timer); resolve({ error: smsProblem(String(error), target) }); });
    // sqlite3 can print its refusal and still exit 0: an error line counts whatever the exit code says.
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 && !/^Error:|unable to open database|authorization denied/im.test(err) ? { rows: out } : { error: smsProblem(err || `exit ${code}`, target) }); });
  });
}

// ── a Twilio number: the sign-up phone, so vendors' texts and calls do not go to the user's own phone ──

/** The Twilio number sign-ups use and its account; the API key that reads its texts is kept in the vault as sms-twilio/sid and /key. */
/** `number` is the sign-up phone; `others` are the account's numbers in other countries (Canada, …), offered when a site refuses a
 * US number. Texts to every one of them are read. */
export interface TwilioSms { number: string; account: string; others?: string[] }
const TWILIO_NUMBER = /^\+[1-9]\d{6,14}$/;
const TWILIO_ACCOUNT = /^AC[0-9a-f]{32}$/;
export const TWILIO_SID_SECRET = 'sms-twilio/sid';
export const TWILIO_KEY_SECRET = 'sms-twilio/key';

export async function twilioSms(stateDir: string): Promise<TwilioSms | undefined> {
  const { readFile } = await import('node:fs/promises');
  try {
    const value = (JSON.parse(await readFile(computerSettingsPath(stateDir), 'utf8')) as { smsTwilio?: Partial<TwilioSms> }).smsTwilio;
    if (!value || !TWILIO_NUMBER.test(value.number ?? '') || !TWILIO_ACCOUNT.test(value.account ?? '')) return undefined;
    const others = (Array.isArray(value.others) ? value.others : []).filter((n): n is string => typeof n === 'string' && TWILIO_NUMBER.test(n));
    return { number: value.number!, account: value.account!, ...(others.length ? { others } : {}) };
  } catch { return undefined; }
}

export async function setTwilioSms(stateDir: string, value: TwilioSms | undefined): Promise<void> {
  if (value && (!TWILIO_NUMBER.test(value.number) || !TWILIO_ACCOUNT.test(value.account) || (value.others ?? []).some(n => !TWILIO_NUMBER.test(n)))) throw new Error('Give the Twilio number as +<country><number> and the account SID (AC followed by 32 hex digits).');
  await updateJsonFile(computerSettingsPath(stateDir), objectOrEmpty, current => {
    const next = { ...current } as Record<string, unknown>;
    if (value) next.smsTwilio = value; else delete next.smsTwilio;
    return next;
  });
}

/** The texts the Twilio number received since `sinceUnixSeconds`, as rows like the Mac's (unix seconds, sender, text). */
export async function askTwilio(stateDir: string, sms: TwilioSms, sinceUnixSeconds: number, signal?: AbortSignal, fetcher: typeof fetch = fetch, given?: { sid: string; key: string }): Promise<{ rows: string } | { error: string }> {
  const { readNamedSecret } = await import('./credential-vault.js');
  const [sid, key] = given ? [given.sid, given.key] : await Promise.all([readNamedSecret(stateDir, TWILIO_SID_SECRET), readNamedSecret(stateDir, TWILIO_KEY_SECRET)]).catch(() => [undefined, undefined]);
  if (!sid || !key) return { error: `No Twilio API key is saved to read ${sms.number}'s texts (vault names ${TWILIO_SID_SECRET} and ${TWILIO_KEY_SECRET}).` };
  // DateSent filters by day only: the day before covers a code sent just after midnight UTC; rows older than `since` are dropped here.
  const day = new Date((sinceUnixSeconds - 86_400) * 1000).toISOString().slice(0, 10);
  const rowsOf: Array<{ direction?: string; from?: string; body?: string; date_sent?: string | null; date_created?: string }> = [];
  try {
    for (const number of [sms.number, ...(sms.others ?? [])]) {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${sms.account}/Messages.json?${new URLSearchParams({ To: number, 'DateSent>': day, PageSize: '20' })}`;
      const res = await fetcher(url, { headers: { authorization: `Basic ${Buffer.from(`${sid}:${key}`).toString('base64')}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
      if (!res.ok) return { error: `Twilio would not list ${number}'s texts (HTTP ${res.status}).` };
      rowsOf.push(...((await res.json() as { messages?: typeof rowsOf }).messages ?? []));
    }
    const rows = rowsOf.filter(m => m.direction === 'inbound').map(m => ({ at: Math.floor(Date.parse(m.date_sent || m.date_created || '') / 1000), from: m.from ?? '?', body: (m.body ?? '').replace(/[\r\n\u001f]+/g, ' ') }))
      .filter(m => Number.isFinite(m.at) && m.at >= sinceUnixSeconds).sort((a, b) => b.at - a.at);
    return { rows: rows.map(m => `${m.at}\u001f${m.from}\u001f${m.body}`).join('\n') };
  } catch (error) { return { error: `Reading ${sms.number}'s texts from Twilio failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}` }; }
}

/** Seconds a text's timestamp may run before the request time and still count (the Mac's or Twilio's clock against this one). */
export const CLOCK_SLACK_S = 5;

/** Waits for a texted code that arrived after `since` (unix ms: when the page was asked to send it), up to `seconds`, on every source
 * set up: the Twilio number sign-ups use, and the Mac that receives the user's own texts (a site that refused the Twilio number as
 * VoIP texts the user's phone). A code handed out once is recorded (per source, under a lock, as emails are) and never handed out
 * again, so a resend gets the new code and two agents never get the same one. `from` / `site` say whose text it must be. A source
 * that errors is asked again with backoff until the deadline; errors are reported only when every source failed throughout. Never
 * returns the message itself. */
export async function waitForTextedCode(stateDir: string, options: { since: number; seconds?: number; from?: string; site?: string; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; ask?: typeof askMessages; askTwilio?: (sms: TwilioSms, since: number) => Promise<{ rows: string } | { error: string }> }): Promise<TextedCode | { error: string }> {
  const [target, twilio] = await Promise.all([smsSource(stateDir), twilioSms(stateDir)]);
  if (!target && !twilio) return { error: 'No phone is set up to read text messages: run clikcode computer sms twilio:+<number>:<account sid> (a Twilio number) or clikcode computer sms <user@host> (a Mac with Text Message Forwarding).' };
  const { claimMessage } = await import('./email-consumed.js');
  const stop = new AbortController();
  const seconds = Math.min(Math.max(options.seconds ?? 90, 5), 180);
  const budget = AbortSignal.timeout(seconds * 1000);
  const deadline = Date.now() + seconds * 1000;
  const signals = [stop.signal, budget, ...(options.signal ? [options.signal] : [])];
  const signal = AbortSignal.any(signals);
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const since = Math.floor(options.since / 1000) - CLOCK_SLACK_S;
  const filter: TextFilter = { ...(options.from ? { from: options.from } : {}), ...(options.site ? { site: options.site } : {}) };
  const names = [twilio?.number, target].filter(Boolean).join(' or ');
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  interrupted.catch(() => undefined); // fail-open-ok: only silences the unhandled rejection; every await below races it and sees the abort
  /** Per source: whether it ever answered, and its last error. */
  const health = new Map<string, { answered: boolean; error?: string }>();
  const poll = async (source: string, ask: () => Promise<{ rows: string } | { error: string }>): Promise<TextedCode> => {
    const state = { answered: false } as { answered: boolean; error?: string };
    health.set(source, state);
    let failures = 0;
    for (;;) {
      signal.throwIfAborted();
      // The clock, not only the timer: a poll that never yields to the event loop must still end on time.
      if (Date.now() >= deadline) throw new Error('deadline');
      await new Promise<void>(resolve => setImmediate(resolve));
      const answer = await Promise.race([ask(), interrupted]).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return { error: error instanceof Error ? error.message : String(error) };
      });
      if ('error' in answer) {
        // A dropped SSH connection or a Twilio 5xx is asked again, slower each time, until the wait is over.
        state.error = answer.error;
        failures++;
        await Promise.race([sleep(Math.min(4_000 * 2 ** Math.min(failures - 1, 3), 30_000)), interrupted]);
        continue;
      }
      state.answered = true; failures = 0;
      for (const found of codesFromRows(answer.rows, filter)) {
        if (found.at < since) continue;
        if (await claimMessage(stateDir, `${source}:${found.at}:${squash(found.from)}:${found.code}`, 'sms')) return found;
      }
      await Promise.race([sleep(4_000), interrupted]);
    }
  };
  // Each source polls independently: a sleeping Mac cannot delay a code available through Twilio, or vice versa.
  const readers: Array<Promise<TextedCode>> = [];
  if (twilio) readers.push(poll(`twilio:${twilio.number}`, () => options.askTwilio ? options.askTwilio(twilio, since) : askTwilio(stateDir, twilio, since, signal)));
  if (target) readers.push(poll(`mac:${target}`, () => (options.ask ?? askMessages)(target, since, signal)));
  try {
    return await Promise.race([Promise.any(readers), interrupted]);
  } catch {
    if (options.signal?.aborted) return { error: 'Texted-code wait was cancelled.' };
    const states = [...health.values()];
    if (states.length && states.every(item => !item.answered && item.error)) return { error: states.map(item => item.error).join(' ') };
    const who = options.from ? ` from ${options.from}` : options.site ? ` naming ${vendorName(options.site) ?? options.site}` : '';
    return { error: `No new texted code arrived on ${names} in time${who}.${options.site && !options.from ? ' If the text does not name the site, give from (the sender, or "any").' : ''}${target ? ' Check that the iPhone forwards texts to that Mac (Settings > Messages > Text Message Forwarding).' : ''}` };
  } finally {
    stop.abort();
    signal.removeEventListener('abort', onAbort);
  }
}
