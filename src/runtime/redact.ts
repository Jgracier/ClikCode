/** A line for a log, with anything shaped like a credential masked.
 *
 * Kept apart from the logger so it can be used by it and by what feeds it without either importing
 * the other. */
import { scrubSecrets } from '../agent/computer/secret-scrubber.js';
import { SECRET_SHAPES } from './secret-shapes.js';

/** What a key, a token or a password looks like, for a line nobody chose to log: an error that
 * echoes its environment, a header, a URL with credentials. The held secrets (scrubSecrets) are
 * exact; this is the net under them for one this process never held. The vendor shapes are the
 * ones search masks too (secret-shapes.ts); the rest are how a log line carries one. */
const LOG_SHAPES = [
  ...SECRET_SHAPES,
  /\b(?:Bearer|Basic)\s+[\w.=+/-]{12,}/gi,
  /\b((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[=:]\s*["']?)[^\s"']{8,}/gi,
  /(:\/\/[^\s/:@]+:)[^\s/@]+@/g,
];

/** A line for the log with anything shaped like a credential masked. */
export function redactForLog(text: string): string {
  let out = scrubSecrets(text);
  for (const shape of LOG_SHAPES) out = out.replace(shape, (_whole, keep) => (typeof keep === 'string' ? `${keep}[secret hidden]${keep.endsWith(':') && keep.includes('//') ? '@' : ''}` : '[secret hidden]'));
  return out;
}
