/** Backup (recovery) codes a site shows once after two-factor set-up: each one signs in to the account, so the agent
 * does not read them. The page view shows placeholders and capture_secret saves the whole set as one secret. */
import { secretRef } from './secret-scrubber.js';

/** The page is showing backup codes, not asking for one. */
const CODES_PAGE = /\b(?:backup|recovery|rescue|emergency|scratch)[- ](?:codes|keys)\b|\bone[- ]time (?:backup|recovery) codes\b/i;
/** One code and nothing else: 4-4 or 5-5 groups, a run of 6 to 12 digits, or 8 to 16 letters and digits holding a digit. */
const CODE = /^(?:[A-Za-z0-9]{3,6}(?:[ -][A-Za-z0-9]{3,6}){1,3}|\d{6,12}|(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,16})$/;
/** Fewer than this many code-shaped lines is a page that merely talks about backup codes. */
const FEWEST = 4;

const isCode = (text: string): boolean => CODE.test(text) && /\d/.test(text);

/** The backup codes among the lines of a page's visible text, in page order (empty when the page shows none). */
export function recoveryCodesIn(pageText: string): string[] {
  if (!CODES_PAGE.test(pageText)) return [];
  const codes = pageText.split('\n').map(line => line.trim()).filter(isCode);
  return codes.length >= FEWEST ? [...new Set(codes)] : [];
}

/** What a snapshot line shows as its own text: `- heading "7448 1814" [level=6]`, `- listitem: abcd-efgh`, `- text: 12345678`. */
const QUOTED = /^(\s*- [a-z]+ ")([^"]+)(".*)$/;
const AFTER_COLON = /^(\s*- (?:[a-z]+(?: \[[^\]]*\])*|text): )(.+)$/;

/** The page view with each backup code replaced by a placeholder, and how many were hidden. */
export function hideRecoveryCodes(snapshot: string): { text: string; hidden: number } {
  if (!CODES_PAGE.test(snapshot)) return { text: snapshot, hidden: 0 };
  const lines = snapshot.split('\n');
  const at: Array<{ index: number; head: string; code: string; tail: string }> = [];
  lines.forEach((line, index) => {
    const quoted = QUOTED.exec(line);
    if (quoted && isCode(quoted[2]!.trim())) { at.push({ index, head: quoted[1]!, code: quoted[2]!.trim(), tail: quoted[3]! }); return; }
    const plain = AFTER_COLON.exec(line);
    if (plain && isCode(plain[2]!.trim())) at.push({ index, head: plain[1]!, code: plain[2]!.trim(), tail: '' });
  });
  if (at.length < FEWEST) return { text: snapshot, hidden: 0 };
  for (const found of at) lines[found.index] = `${found.head}${secretRef(found.code)}${found.tail}`;
  return { text: lines.join('\n'), hidden: at.length };
}

/** capture_secret's target for the whole set. */
export const RECOVERY_TARGET = /^(?:the )?(?:backup|recovery) codes?$/i;

/** capture_secret's target for an authenticator set-up that shows only a QR code. */
export const QR_TARGET = /^(?:the )?(?:authenticator|setup|set-up|otpauth|two-factor|2fa|mfa) (?:qr(?: code)?|key|secret|seed)$|^qr(?: code)?$/i;
const OTPAUTH = /otpauth:\/\/[a-z]+\/[^\s"'<>\\]*?secret=[A-Za-z2-7]{16,}[^\s"'<>\\]*/i;
/**
 * The otpauth link behind a QR code, when the page carries it as text: in the image's address (a chart service is handed the
 * link to draw), in a data attribute, or in a script. Looked for as written and percent-decoded once or twice. A QR drawn
 * from pixels alone carries no such text and is not read here.
 */
export function otpauthIn(markup: string): string | undefined {
  let text = markup.replace(/&amp;/g, '&');
  for (let round = 0; round < 3; round++) {
    const found = OTPAUTH.exec(text);
    if (found) return found[0];
    let decoded: string;
    try { decoded = decodeURIComponent(text.replace(/%(?![0-9a-fA-F]{2})/g, '%25')); } catch { return undefined; }
    if (decoded === text) return undefined;
    text = decoded;
  }
  return undefined;
}
