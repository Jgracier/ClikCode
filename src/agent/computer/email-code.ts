/**
 * The emailed one-time code for the site a page is on, found without the agent: the right sender, after the page asked,
 * never an email another agent already took, inbox first and then spam, a few passes. When it does not come, the signup is
 * put on hold in the queue (reason email) so the run goes on and a person or a later retry finishes it.
 */
import { emailConnected, EmailAmbiguous, MARKETING, waitForEmail, type GoogleEndpoints } from './email-api.js';
import { Parked, vendorOf } from './parking.js';
import { saveTask } from './work-queue.js';

/** The one-time code in an email: a 4-8 character code that the text calls a code, else a lone 6-digit number. */
export function verificationCode(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ');
  const named = /\b(?:verification|security|confirmation|login|sign[- ]?in|one[- ]time|access)?\s*code\b[^A-Za-z0-9]{0,20}([A-Z0-9]{4,8})\b/i.exec(flat)
    ?? /\b([A-Z0-9]{4,8})\b[^.]{0,30}\bis your (?:\w+ )?code\b/i.exec(flat);
  if (named && /\d/.test(named[1]!)) return named[1];
  const sixes = [...new Set(flat.match(/(?<![\w.-])\d{6}(?![\w-])/g) ?? [])];
  return sixes.length === 1 ? sixes[0] : undefined;
}

const CODE_WORDS = /\b(?:code|otp|passcode|pin|verify|verification|confirm(?:ation)?|one[- ]time|sign[- ]?in|log[- ]?in|security alert)\b/i;
const LINK_WORDS = /\b(?:verify|verification|confirm(?:ation)?|activate|activation|sign[- ]?in|log[- ]?in|magic|reset|set (?:your )?password|welcome|complete (?:your )?(?:sign|regist))/i;
/** An email that is a verification message with a code in it, not a newsletter that happens to hold a six-digit number. */
export function looksLikeCodeEmail(mail: { subject: string; text: string }): boolean {
  if (MARKETING.test(mail.subject) || MARKETING.test(mail.text.slice(0, 200))) return false;
  return verificationCode(mail.text) !== undefined && CODE_WORDS.test(`${mail.subject} ${mail.text.slice(0, 300)}`);
}
/** An email that is a verification or sign-in message with a link to follow. */
export function looksLikeLinkEmail(mail: { subject: string; text: string; links: string[] }): boolean {
  if (MARKETING.test(mail.subject) || MARKETING.test(mail.text.slice(0, 200))) return false;
  return mail.links.length > 0 && LINK_WORDS.test(`${mail.subject} ${mail.text.slice(0, 300)}`);
}

export type EmailedCode = { code: string } | { hold: string };

export async function emailedCode(stateDir: string, options: { site: string; since: number; signal?: AbortSignal; passes?: number; passMs?: number; pollMs?: number; endpoints?: GoogleEndpoints }): Promise<EmailedCode> {
  const passes = options.passes ?? 3, passMs = options.passMs ?? 30_000;
  for (let pass = 0; pass < passes; pass++) {
    try {
      // The first pass reads the inbox; later passes also look in spam, where a new sender's first email often lands.
      const mail = await waitForEmail(stateDir, { site: options.site, since: options.since, timeoutMs: passMs, pollMs: options.pollMs, spam: pass > 0, consume: true, accept: looksLikeCodeEmail, signal: options.signal, endpoints: options.endpoints });
      return { code: verificationCode(mail.text)! };
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
