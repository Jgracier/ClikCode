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

/** The newest code among the rows the query returned (unix seconds, sender, text), optionally from one sender. */
export function codeFromRows(output: string, from?: string): TextedCode | undefined {
  const wanted = from?.toLowerCase().replace(/[^a-z0-9+]/g, '');
  for (const line of output.split('\n')) {
    const [at, sender = '', text = ''] = line.split('\u001f');
    if (!at || !text.trim()) continue;
    if (wanted && !sender.toLowerCase().replace(/[^a-z0-9+]/g, '').includes(wanted) && !text.toLowerCase().includes(from!.toLowerCase())) continue;
    const code = textedCode(text);
    if (code) return { code, from: sender, at: Number(at) };
  }
  return undefined;
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

/** Waits for a texted code that arrived after `since` (unix ms), up to `seconds`. Never returns the message itself. */
export async function waitForTextedCode(stateDir: string, options: { since: number; seconds?: number; from?: string; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; ask?: typeof askMessages }): Promise<TextedCode | { error: string }> {
  const target = await smsSource(stateDir);
  if (!target) return { error: 'No Mac is set up to read text messages: run clikcode computer sms <user@host> on this computer (the Mac needs Text Message Forwarding from the iPhone).' };
  const ask = options.ask ?? askMessages;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = Date.now() + Math.min(Math.max(options.seconds ?? 90, 5), 180) * 1000;
  // A text can be stamped a little before the page's own clock says it asked.
  const since = Math.floor(options.since / 1000) - 20;
  for (;;) {
    const answer = await ask(target, since, options.signal);
    if ('error' in answer) return answer;
    const found = codeFromRows(answer.rows, options.from);
    if (found) return found;
    if (Date.now() >= deadline || options.signal?.aborted) return { error: `No texted code arrived on ${target} in time${options.from ? ` from ${options.from}` : ''}. Check that the iPhone forwards texts to that Mac (Settings > Messages > Text Message Forwarding).` };
    await sleep(4_000);
  }
}
