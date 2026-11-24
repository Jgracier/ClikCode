/**
 * The emailed one-time code for the site a page is on, found without the agent: the right sender, after the page asked,
 * never an email another agent already took, inbox first and then spam, a few passes. When it does not come, the signup is
 * put on hold in the queue (reason email) so the run goes on and a person or a later retry finishes it.
 */
import { emailConnected, EmailAmbiguous, MARKETING, findEmail, loginAddresses, type GoogleEndpoints } from './email-api.js';
import { Parked, vendorOf } from './parking.js';
import { saveTask } from './work-queue.js';

/** The one-time code in an email: a 4-8 character code that the text calls a code, else a lone 6-digit number. */
export function verificationCode(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ');
  const patterns = [
    /\b(?:verification|security|confirmation|activation|login|sign[- ]?in|one[- ]time|access)?\s*code\b[^A-Za-z0-9]{0,20}([A-Z0-9]{4,8})\b/gi,
    /\b(?:verification|security|confirmation|activation|login|sign[- ]?in|one[- ]time|access|otp)?\s*(?:code|otp|passcode|pin)\b[^.\d]{0,40}?[:\s](\d{4,8})\b/gi,
    /\b([A-Z0-9]{4,8})\b[^.]{0,30}\bis your (?:\w+ ){0,3}code\b/gi,
  ];
  // A match such as "code below" is not a code. Keep looking rather than letting that word hide a later numeric match.
  for (const pattern of patterns) for (const match of flat.matchAll(pattern)) if (/\d/.test(match[1]!)) return match[1];
  const sixes = [...new Set(flat.match(/(?<![\w.-])\d{6}(?![\w-])/g) ?? [])];
  return sixes.length === 1 ? sixes[0] : undefined;
}

/** Both MIME body and subject can hold the code. Conflicting answers are not guessed between. */
export function emailVerificationCode(mail: { subject: string; text: string }): string | undefined {
  const body = verificationCode(mail.text), subject = verificationCode(mail.subject);
  return body && subject && body !== subject ? undefined : body ?? subject;
}

const CODE_WORDS = /\b(?:code|otp|passcode|pin|verify|verification|confirm(?:ation)?|one[- ]time|sign[- ]?in|log[- ]?in|security alert)\b/i;
const LINK_WORDS = /\b(?:verify|verification|confirm(?:ation)?|activate|activation|sign[- ]?in|log[- ]?in|magic|reset|set (?:your )?password|welcome|complete (?:your )?(?:sign|regist))/i;
/** An email that is a verification message with a code in it, not a newsletter that happens to hold a six-digit number. */
export function looksLikeCodeEmail(mail: { subject: string; text: string }): boolean {
  if (MARKETING.test(mail.subject) || MARKETING.test(mail.text.slice(0, 200))) return false;
  return emailVerificationCode(mail) !== undefined && CODE_WORDS.test(`${mail.subject} ${mail.text.slice(0, 300)}`);
}
/** An email that is a verification or sign-in message with a link to follow. */
export function looksLikeLinkEmail(mail: { subject: string; text: string; links: string[] }): boolean {
  if (MARKETING.test(mail.subject) || MARKETING.test(mail.text.slice(0, 200))) return false;
  return mail.links.length > 0 && LINK_WORDS.test(`${mail.subject} ${mail.text.slice(0, 300)}`);
}

type EmailedCode = { code: string } | { hold: string };

export async function emailedCode(stateDir: string, options: { site: string; since: number; signal?: AbortSignal; passes?: number; passMs?: number; pollMs?: number; endpoints?: GoogleEndpoints }): Promise<EmailedCode> {
  const passes = options.passes ?? 3, passMs = options.passMs ?? 30_000;
  // The mailbox the site's account was made with (its saved login) is read first; the others after it.
  const hints = await loginAddresses(stateDir, options.site);
  for (let pass = 0; pass < passes; pass++) {
    try {
      // The first pass reads the inbox; later passes also look in spam, where a new sender's first email often lands.
      const mail = await findEmail(stateDir, { hints, site: options.site, since: options.since, timeoutMs: passMs, pollMs: options.pollMs, spam: pass > 0, consume: true, accept: looksLikeCodeEmail, signal: options.signal, endpoints: options.endpoints });
      return { code: emailVerificationCode(mail)! };
    } catch (error) {
      if (error instanceof EmailAmbiguous) return { hold: error.message };
      if (options.signal?.aborted) throw error;
      if (!/^No email matched/.test((error as Error).message)) return { hold: (error as Error).message };
    }
  }
  return { hold: `no email with a code for ${vendorOf(options.site)} arrived in ${Math.round(passes * passMs / 1000)} seconds (inbox, then spam, ${passes} passes)` };
}

/** Puts the signup on hold in the queue and stops the step, telling the agent to go on to the next vendor. */
export async function holdForEmail(stateDir: string, site: string, why: string): Promise<never> {
  const vendor = vendorOf(site);
  await saveTask(stateDir, { vendor, kind: 'other', status: 'needs-human', reason: 'email', note: `verification email: ${why}`.slice(0, 300) });
  throw new Parked(`On hold: ${vendor} verification email did not come (${why}). It is recorded in the queue as needs-human (email). Do not ask the user; go on to the next vendor.`);
}

/** The emailed code when a mailbox is connected, else undefined (the caller asks as before). A code that does not come puts the signup on hold. */
export async function codeFromMailbox(stateDir: string, site: string, since: number, signal?: AbortSignal): Promise<string | undefined> {
  if (!(await emailConnected(stateDir))) return undefined;
  const found = await emailedCode(stateDir, { site, since, signal });
  if ('code' in found) return found.code;
  return holdForEmail(stateDir, site, found.hold);
}

/** Words a "password:" label is followed by that are not the password itself ("Password: reset it here", "password below"). */
const NOT_A_PASSWORD = /^(?:reset|change|below|here|link|button|click|set|create|choose|update|required|is|was|will|you|your|the|a|an)$/i;
/**
 * The password a site emailed for a new account ("Your password: Xk7#pq2", "Temporary password is ..."), else undefined.
 * Only a value that looks generated counts (6-64 characters with a digit or a symbol), so a sentence after the word is never
 * typed into a box, and two different values are not guessed between.
 */
export function emailedPassword(mail: { subject: string; text: string }): string | undefined {
  if (MARKETING.test(mail.subject) || MARKETING.test(mail.text.slice(0, 200))) return undefined;
  const flat = mail.text.replace(/\s+/g, ' ');
  const found = new Set<string>();
  const pattern = /\b(?:temporary |initial |one[- ]time |new |generated |your )?(?:password|passwort|mot de passe|contraseña)\b(?:\s+is)?(?:\s*[:=]\s*|\s+)["'“]?([^\s"'”<>]{6,64})/gi;
  for (const match of flat.matchAll(pattern)) {
    const value = match[1]!.replace(/[.,;)]+$/, '');
    if (value.length < 6 || NOT_A_PASSWORD.test(value) || /^https?:/i.test(value) || value.includes('@')) continue;
    // A masked "********" or a word with no digit or symbol ("protected") is not a password.
    if (!/[\p{L}\p{N}]/u.test(value) || !/\d|[^\p{L}\p{N}]/u.test(value)) continue;
    found.add(value);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** How far back a site's emailed password is looked for: account emails are kept, and the account may be days old. */
const PASSWORD_EMAIL_DAYS = 30;

/**
 * The password this site emailed when the account was made, from a connected mailbox (inbox and spam, one quick look, not
 * claimed: it stays the account's password), with the mailbox it came to, which is the account's sign-in address. Undefined when
 * no mailbox is connected or none was sent.
 */
export async function passwordFromMailbox(stateDir: string, site: string, options: { signal?: AbortSignal; timeoutMs?: number; endpoints?: GoogleEndpoints } = {}): Promise<{ password: string; mailbox: string } | undefined> {
  if (!(await emailConnected(stateDir))) return undefined;
  try {
    const mail = await findEmail(stateDir, { hints: await loginAddresses(stateDir, site), site, since: Date.now() - PASSWORD_EMAIL_DAYS * 86_400_000, timeoutMs: options.timeoutMs ?? 8_000, pollMs: 2_000, spam: true, accept: mail => emailedPassword(mail) !== undefined, signal: options.signal, endpoints: options.endpoints });
    return { password: emailedPassword(mail)!, mailbox: mail.mailbox };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return undefined;
  }
}
