/** A generated site password that fits what the site asks for.
 *
 * The default is 24 characters with upper, lower, digit and symbol. A sign-up page often says more (at least 12
 * characters, no symbols, 8 to 20 characters) in its hint text or in the box's own `minlength` / `maxlength` /
 * `pattern`; `parsePolicy` reads those. When a site still refuses the password, `relax` loosens the rules from what the
 * error says, a bounded number of times. Nothing here ever sees a password except the one being made. */
import { randomInt } from 'node:crypto';

export type PasswordPolicy = {
  length: number;
  minLength: number;
  maxLength: number;
  /** The symbols that may be used; empty means letters and digits only. */
  symbols: string;
  /** HTML `pattern` attributes the password must fully match. */
  patterns: string[];
};

export const DEFAULT_SYMBOLS = '!@#$%^*-_';
const HARD_MAX = 128;
export const DEFAULT_POLICY: PasswordPolicy = { length: 24, minLength: 8, maxLength: HARD_MAX, symbols: DEFAULT_SYMBOLS, patterns: [] };
export const MAX_PASSWORD_ATTEMPTS = 3;

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/** What a page says about its password, from the text near the box and the box's own attributes. */
export type PolicyHints = { text?: string; minlength?: number; maxlength?: number; pattern?: string };

/** Symbols named in a hint such as "special characters (! @ # $ %)" or "allowed: !@#$". */
function listedSymbols(text: string): string {
  const match = /(?:special characters?|symbols?|punctuation)[^.\n]{0,40}?(?:[:(]|e\.?g\.?,?|such as|like|include|from|are|allowed)\s*([^\s\w]{1,2}(?:[ ,]*[^\s\w]{1,2}){1,20})/i.exec(text);
  if (!match?.[1]) return '';
  return [...new Set([...match[1]].filter(char => /[!-/:-@[-`{-~]/.test(char)))].join('');
}

/** Reads length and character rules out of free text. Never throws; unknown text gives the default policy. */
export function parsePolicy(hints: PolicyHints | readonly PolicyHints[] = {}): PasswordPolicy {
  const list = Array.isArray(hints) ? hints as readonly PolicyHints[] : [hints as PolicyHints];
  let min = DEFAULT_POLICY.minLength;
  let max = HARD_MAX;
  let symbols = DEFAULT_SYMBOLS;
  const patterns: string[] = [];
  for (const hint of list) {
    if (hint.minlength && hint.minlength > 0) min = Math.max(min, hint.minlength);
    if (hint.maxlength && hint.maxlength > 0 && hint.maxlength < 10_000) max = Math.min(max, hint.maxlength);
    if (hint.pattern) patterns.push(hint.pattern);
    const text = (hint.text ?? '').replace(/\s+/g, ' ');
    const range = /(\d{1,3})\s*(?:-|–|to|and)\s*(\d{1,3})\s*(?:characters?|chars?|letters?|digits?)/i.exec(text);
    if (range) { min = Math.max(min, Number(range[1])); max = Math.min(max, Number(range[2])); }
    for (const found of text.matchAll(/(?:at least|minimum(?: of| length)?|min\.?(?: of| length)?|no (?:fewer|less) than|longer than|\bmust be|more than)\s*:?\s*(\d{1,3})\s*\+?\s*(?:or more\s*)?(?:characters?|chars?|letters?|symbols?|digits?)?/gi)) {
      const value = Number(found[1]);
      if (/longer than|more than/i.test(found[0])) { if (/\bcharacters?|chars?/i.test(found[0]) || /\bpassword\b[^.]{0,30}$/i.test(text.slice(0, found.index))) min = Math.max(min, value + 1); }
      else if (value >= 4 && value <= 128) min = Math.max(min, value);
    }
    for (const found of text.matchAll(/(\d{1,3})\s*\+\s*(?:characters?|chars?)/gi)) min = Math.max(min, Number(found[1]));
    for (const found of text.matchAll(/(?:at most|maximum(?: of| length)?|max\.?(?: of| length)?|no more than|up to|not (?:be )?(?:longer|exceed)(?: than)?|fewer than|shorter than|under)\s*:?\s*(\d{1,3})\s*(?:characters?|chars?)/gi)) {
      const value = Number(found[1]);
      if (value >= 6) max = Math.min(max, /fewer than|shorter than|under/i.test(found[0]) ? value - 1 : value);
    }
    if (/(?:no|without|not (?:allow|support|accept)|don'?t (?:use|include)|avoid|exclud\w*)\s+(?:any\s+)?(?:special|symbols?|punctuation)/i.test(text)
      || /(?:letters?|alphanumeric|alpha-numeric)\s*(?:and|&|or|\+)\s*(?:numbers?|digits?)\s*only|only\s+(?:letters?|alphanumeric)|alphanumeric\s+(?:characters\s+)?only|special (?:characters?|symbols?) (?:are )?not allowed/i.test(text)) symbols = '';
    else {
      const named = listedSymbols(text);
      if (named) symbols = [...DEFAULT_SYMBOLS].filter(char => named.includes(char)).join('') || named;
    }
  }
  if (max < min) min = max; // a page that contradicts itself: the ceiling is a hard limit, the floor is not
  min = Math.min(min, HARD_MAX);
  return { length: clamp(DEFAULT_POLICY.length, min, max), minLength: min, maxLength: max, symbols, patterns };
}

const shuffle = <T,>(items: T[]): T[] => {
  for (let index = items.length - 1; index > 0; index--) { const other = randomInt(index + 1); [items[index], items[other]] = [items[other]!, items[index]!]; }
  return items;
};

/** Sites often forbid repeated ("aa") or sequential ("abc", "321") characters; a generated password never has either. */
export function hasRepeatOrSequence(password: string): boolean {
  const lowered = password.toLowerCase();
  for (let i = 1; i < password.length; i++) {
    // Case-insensitive: "aA" counts as a repeat and "aBc" as a sequence, since sites compare that way too.
    const a = lowered.charCodeAt(i - 2), b = lowered.charCodeAt(i - 1), c = lowered.charCodeAt(i);
    if (b === c) return true;
    if (i >= 2 && ((b - a === 1 && c - b === 1) || (a - b === 1 && b - c === 1))) return true;
  }
  return false;
}

function matchesPatterns(password: string, patterns: readonly string[]): boolean {
  return patterns.every(pattern => { try { return new RegExp(`^(?:${pattern})$`, 'u').test(password); } catch { try { return new RegExp(`^(?:${pattern})$`).test(password); } catch { return true; } } });
}

/** A password for the policy: every class the policy allows appears, and a `pattern` the page set is honoured by trying again. */
export function generatePassword(policy: PasswordPolicy = DEFAULT_POLICY): string {
  const classes = [LOWER, UPPER, DIGITS, ...(policy.symbols ? [policy.symbols] : [])];
  const length = clamp(policy.length, Math.min(policy.minLength, policy.maxLength), policy.maxLength);
  const all = classes.join('');
  const build = (sets: readonly string[], set: string): string => {
    const chars = sets.slice(0, length).map(source => source[randomInt(source.length)]!);
    while (chars.length < length) chars.push(set[randomInt(set.length)]!);
    return shuffle(chars).join('');
  };
  const fine = (value: string): boolean => matchesPatterns(value, policy.patterns) && !hasRepeatOrSequence(value);
  let candidate = build(classes, all);
  for (let tries = 0; tries < 200 && !fine(candidate); tries++) candidate = build(classes, all);
  if (!matchesPatterns(candidate, policy.patterns)) {
    // A pattern this generator cannot satisfy with symbols (letters and digits only, say): drop symbols and try again.
    const plain = [LOWER, UPPER, DIGITS];
    for (let tries = 0; tries < 200 && !fine(candidate); tries++) candidate = build(plain, plain.join(''));
  }
  return candidate;
}

/** What an error next to the password box complains about. */
export function classifyRejection(text: string): { tooShort?: number | true; tooLong?: number | true; characters?: boolean } {
  const out: { tooShort?: number | true; tooLong?: number | true; characters?: boolean } = {};
  const lower = text.toLowerCase();
  const learned = parsePolicy({ text });
  if (/too short|at least|minimum|not long enough|longer|more characters|min(?:imum)? length|\d+\s*\+\s*char/.test(lower)) out.tooShort = learned.minLength > DEFAULT_POLICY.minLength ? learned.minLength : true;
  if (/too long|at most|maximum|no more than|exceed|shorter|fewer|up to \d+|max(?:imum)? length/.test(lower)) out.tooLong = learned.maxLength < HARD_MAX ? learned.maxLength : true;
  if (/special|symbol|not allowed|illegal|unsupported|alphanumeric|forbidden|disallow|punctuation|spaces?/.test(lower)
    || (/character|invalid|weak|letters? and/.test(lower) && !out.tooShort && !out.tooLong)) out.characters = true;
  return out;
}

/** The policy for the next try after the site refused a password, from what its error says. `attempt` is 1, 2, 3. */
export function relax(policy: PasswordPolicy, rejection: string, attempt: number): PasswordPolicy {
  const said = classifyRejection(rejection);
  const learned = parsePolicy({ text: rejection });
  let minLength = Math.max(policy.minLength, learned.minLength);
  let maxLength = Math.min(policy.maxLength, learned.maxLength);
  let length = policy.length;
  if (typeof said.tooShort === 'number') length = Math.max(length, said.tooShort);
  else if (said.tooShort) { length = Math.min(Math.max(length + 8, 16), HARD_MAX); minLength = Math.max(minLength, length); }
  if (typeof said.tooLong === 'number') length = Math.min(length, said.tooLong);
  else if (said.tooLong) { length = Math.max(Math.min(length - 8, 16), 8); maxLength = Math.min(maxLength, length); }
  // Each try narrows the symbols: a short safe set, then none.
  let symbols = policy.symbols;
  if (attempt === 1 && said.characters) symbols = policy.symbols.length > 3 ? '!@#' : policy.symbols;
  else if (attempt >= 2 && (said.characters || attempt >= 3)) symbols = '';
  else if (attempt === 1 && !said.tooShort && !said.tooLong) symbols = policy.symbols.length > 3 ? '!@#' : policy.symbols;
  if (attempt >= 3 && !said.tooShort) length = Math.min(length, Math.max(minLength, 16));
  if (maxLength < minLength) minLength = maxLength;
  return { length: clamp(length, Math.min(minLength, maxLength), maxLength), minLength: Math.min(minLength, maxLength), maxLength, symbols, patterns: policy.patterns };
}
