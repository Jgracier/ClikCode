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
  /** Rules learned from the page or from a refusal; absent when the page named none. */
  rules?: PasswordRules;
};

/** What a site said about repeats, sequences and required classes ("no repeated or sequential characters"). */
export type PasswordRules = {
  /** No two equal characters side by side (case-insensitive: "aA" counts). */
  noRepeat?: boolean;
  /** No abc / cba / 123 / 321 runs, and no keyboard runs such as qwe or asd. */
  noSequence?: boolean;
  /** No character (case-insensitive) used more than this many times; in a row when `inRow`. */
  maxIdentical?: number;
  inRow?: boolean;
  /** A symbol is required, so it is never dropped when loosening. */
  requireSymbol?: boolean;
};

const NEGATION = String.raw`(?:\bno\b|\bnot\b|\bwithout\b|\bavoid\b|\bcannot\b|can'?t|\bmust not\b|don'?t|\bnever\b|\bnone\b)`;
/** Symbols are forbidden or limited to letters and digits. */
const FORBIDS_SYMBOLS = /(?:no|without|not (?:allow|support|accept)|don'?t (?:use|include)|avoid|exclud\w*)\s+(?:any\s+)?(?:special|symbols?|punctuation)|(?:letters?|alphanumeric|alpha-numeric)\s*(?:and|&|or|\+)\s*(?:numbers?|digits?)\s*only|only\s+(?:letters?|alphanumeric)|alphanumeric\s+(?:characters\s+)?only|special (?:characters?|symbols?) (?:are )?not allowed/i;

/** Reads repeat, sequence and required-symbol rules out of free text. */
export function parseRules(text: string): PasswordRules | undefined {
  const t = text.replace(/\s+/g, ' ');
  const rules: PasswordRules = {};
  if (new RegExp(`${NEGATION}[^.;]{0,60}\\b(?:repeat\\w*|duplicat\\w*|identical|same (?:character|letter|digit))`, 'i').test(t)) rules.noRepeat = true;
  if (new RegExp(`${NEGATION}[^.;]{0,60}\\b(?:sequen\\w*|consecutive (?:letters?|numbers?|digits?|characters?)|ascending|descending|abc\\b|123\\b|keyboard (?:pattern|run|sequence)|qwerty)`, 'i').test(t)) rules.noSequence = true;
  const most = /(?:no more than|not more than|at most|maximum of|max\.? of|up to|cannot (?:have|contain|use) more than)\s+(\d)\s+(?:\w+\s+){0,2}?(?:identical|same|repeated|repeating|consecutive|duplicate)/i.exec(t);
  const orMore = /(\d)\s+or more\s+(?:\w+\s+){0,2}?(?:identical|same|repeated|repeating|consecutive)/i.exec(t);
  const limit = most ? Number(most[1]) : orMore ? Number(orMore[1]) - 1 : 0;
  if (limit >= 1) { rules.maxIdentical = limit; if (/in a row|consecutive|adjacent|back to back|side by side|repeating/i.test(t)) rules.inRow = true; }
  if (!FORBIDS_SYMBOLS.test(t) && /(?:at least one|one|1|\ba\b|\ban\b|contain\w*|include\w*|with|must have|requires?|needs?)\s+(?:\w+\s+){0,3}?(?:special|symbol|punctuation)\b/i.test(t) && !new RegExp(`${NEGATION}\\s+(?:\\w+\\s+){0,2}(?:special|symbols?)`, 'i').test(t)) rules.requireSymbol = true;
  return Object.keys(rules).length ? rules : undefined;
}

const mergeRules = (a: PasswordRules | undefined, b: PasswordRules | undefined): PasswordRules | undefined => {
  if (!a || !b) return a ?? b;
  const maxIdentical = a.maxIdentical && b.maxIdentical ? Math.min(a.maxIdentical, b.maxIdentical) : a.maxIdentical ?? b.maxIdentical;
  return { ...(a.noRepeat || b.noRepeat ? { noRepeat: true } : {}), ...(a.noSequence || b.noSequence ? { noSequence: true } : {}), ...(maxIdentical ? { maxIdentical } : {}), ...(a.inRow || b.inRow ? { inRow: true } : {}), ...(a.requireSymbol || b.requireSymbol ? { requireSymbol: true } : {}) };
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
  let rules: PasswordRules | undefined;
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
    rules = mergeRules(rules, parseRules(text));
    if (FORBIDS_SYMBOLS.test(text)) symbols = '';
    else {
      const named = listedSymbols(text);
      if (named) symbols = [...DEFAULT_SYMBOLS].filter(char => named.includes(char)).join('') || named;
    }
  }
  if (max < min) min = max; // a page that contradicts itself: the ceiling is a hard limit, the floor is not
  min = Math.min(min, HARD_MAX);
  if (rules?.requireSymbol && !symbols) symbols = DEFAULT_SYMBOLS; // a required symbol outranks "letters and digits" read from another sentence
  return { length: clamp(DEFAULT_POLICY.length, min, max), minLength: min, maxLength: max, symbols, patterns, ...(rules ? { rules } : {}) };
}

const shuffle = <T,>(items: T[]): T[] => {
  for (let index = items.length - 1; index > 0; index--) { const other = randomInt(index + 1); [items[index], items[other]] = [items[other]!, items[index]!]; }
  return items;
};

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];
/** Three keys in a row on a keyboard, either direction ("qwe", "ewq", "asd"), case-insensitive. */
export function hasKeyboardRun(password: string): boolean {
  const lowered = password.toLowerCase();
  for (let i = 2; i < lowered.length; i++) {
    const three = lowered.slice(i - 2, i + 1);
    const backwards = [...three].reverse().join('');
    if (KEYBOARD_ROWS.some(row => row.includes(three) || row.includes(backwards))) return true;
  }
  return false;
}

/** More uses of one character (case-insensitive) than allowed; with `inRow`, more in a row. */
export function hasTooManyIdentical(password: string, limit: number, inRow = false): boolean {
  const lowered = password.toLowerCase();
  if (inRow) { let run = 1; for (let i = 1; i < lowered.length; i++) { run = lowered[i] === lowered[i - 1] ? run + 1 : 1; if (run > limit) return true; } return false; }
  const counts = new Map<string, number>();
  for (const char of lowered) { const next = (counts.get(char) ?? 0) + 1; if (next > limit) return true; counts.set(char, next); }
  return false;
}

/** Sites often forbid repeated ("aa", "aA") or sequential ("abc", "321", "qwe") characters; a generated password never has any. */
export function hasRepeatOrSequence(password: string): boolean {
  if (hasKeyboardRun(password)) return true;
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
  const symbols = policy.symbols || (policy.rules?.requireSymbol ? DEFAULT_SYMBOLS : '');
  const classes = [LOWER, UPPER, DIGITS, ...(symbols ? [symbols] : [])];
  const length = clamp(policy.length, Math.min(policy.minLength, policy.maxLength), policy.maxLength);
  const all = classes.join('');
  const total = policy.rules?.maxIdentical && !policy.rules.inRow ? policy.rules.maxIdentical : 0;
  const build = (sets: readonly string[], set: string): string => {
    const used = new Map<string, number>();
    // With a cap on how often one character may appear, a saturated character is not drawn again.
    const draw = (source: string): string => {
      let char = source[randomInt(source.length)]!;
      for (let tries = 0; total && (used.get(char.toLowerCase()) ?? 0) >= total && tries < 60; tries++) char = source[randomInt(source.length)]!;
      used.set(char.toLowerCase(), (used.get(char.toLowerCase()) ?? 0) + 1);
      return char;
    };
    const chars = sets.slice(0, length).map(draw);
    while (chars.length < length) chars.push(draw(set));
    return shuffle(chars).join('');
  };
  const limit = policy.rules?.maxIdentical;
  const fine = (value: string): boolean => matchesPatterns(value, policy.patterns) && !hasRepeatOrSequence(value) && !(limit && hasTooManyIdentical(value, limit, policy.rules?.inRow));
  let candidate = build(classes, all);
  for (let tries = 0; tries < 2000 && !fine(candidate); tries++) candidate = build(classes, all);
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
  const rules = learned.rules;
  if (/too short|at least|minimum|not long enough|longer|more characters|min(?:imum)? length|\d+\s*\+\s*char/.test(lower)) out.tooShort = learned.minLength > DEFAULT_POLICY.minLength ? learned.minLength : true;
  if (/too long|at most|maximum|no more than|exceed|shorter|fewer|up to \d+|max(?:imum)? length/.test(lower)) out.tooLong = learned.maxLength < HARD_MAX ? learned.maxLength : true;
  // "Must include a special character" asks for a symbol; it is not a complaint about the ones used. Likewise a
  // complaint about repeats or sequences says nothing about which characters are allowed.
  const asksForSymbol = !!rules?.requireSymbol && !FORBIDS_SYMBOLS.test(text);
  const aboutRules = !!(rules?.noRepeat || rules?.noSequence || rules?.maxIdentical) && !FORBIDS_SYMBOLS.test(text);
  if (!asksForSymbol && /special|symbol|not allowed|illegal|unsupported|alphanumeric|forbidden|disallow|punctuation|spaces?/.test(lower)
    || (!aboutRules && !asksForSymbol && /character|invalid|weak|letters? and/.test(lower) && !out.tooShort && !out.tooLong)) out.characters = true;
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
  const rules = mergeRules(policy.rules, learned.rules);
  let symbols = policy.symbols;
  if (attempt === 1 && said.characters) symbols = policy.symbols.length > 3 ? '!@#' : policy.symbols;
  else if (attempt >= 2 && (said.characters || attempt >= 3)) symbols = '';
  else if (attempt === 1 && !said.tooShort && !said.tooLong) symbols = policy.symbols.length > 3 ? '!@#' : policy.symbols;
  if (!symbols && rules?.requireSymbol) symbols = '!@#';
  if (attempt >= 3 && !said.tooShort) length = Math.min(length, Math.max(minLength, 16));
  if (maxLength < minLength) minLength = maxLength;
  return { length: clamp(length, Math.min(minLength, maxLength), maxLength), minLength: Math.min(minLength, maxLength), maxLength, symbols, patterns: policy.patterns, ...(rules ? { rules } : {}) };
}
