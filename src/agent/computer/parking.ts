/** Unattended runs: a private prompt is not shown, the need is parked in the vendor queue and the agent moves on. */
import type { LoginField } from './login-fields.js';
import { saveTask, type TaskReason } from './work-queue.js';

/** The vendor a site belongs to: its registrable name (`oauth.pipedrive.com` is pipedrive). */
export function vendorOf(site: string): string {
  try {
    const parts = new URL(site).hostname.replace(/^www\./, '').split('.');
    const name = parts.length > 2 && ['co', 'com', 'org', 'net'].includes(parts.at(-2)!) ? parts.at(-3)! : parts.at(-2) ?? parts[0]!;
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) || 'unknown';
  } catch { return 'unknown'; }
}

/** Why a person is needed, from the labels of what is asked (never from a value). */
export function reasonFor(fields: readonly Pick<LoginField, 'label' | 'transient' | 'kind'>[]): TaskReason {
  const labels = fields.map(field => field.label.toLowerCase()).join(' ');
  if (/captcha|robot|not a robot/.test(labels)) return 'captcha';
  if (fields.some(field => field.transient) || /\b(code|verification|authenticator|otp|2fa|two-factor)\b/.test(labels)) return 'two-factor';
  if (/\b(phone|sms|text message)\b/.test(labels)) return 'sms';
  return 'other';
}

export class Parked extends Error {}

/** Record what the user is needed for and stop the step: the message tells the agent to go on to the next vendor and not to ask. */
export async function park(stateDir: string, site: string, fields: readonly LoginField[], why?: string): Promise<never> {
  const vendor = vendorOf(site);
  const asks = fields.map(field => field.label).join(', ').slice(0, 200);
  await saveTask(stateDir, { vendor, kind: 'other', status: 'needs-human', reason: reasonFor(fields), note: `needs from you: ${asks}${why ? ` (${why})` : ''}` });
  throw new Parked(`Parked: ${vendor} needs ${asks} from the user${why ? ` (${why})` : ''}. It is recorded in the queue as needs-human. Do not ask the user; go on to the next vendor.`);
}
