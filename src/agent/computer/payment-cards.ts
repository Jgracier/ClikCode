/** Saved payment cards: what a phone's wallet keeps, so a payment form is filled without the person retyping it and without
 * the agent ever seeing it.
 *
 * WHAT IS KEPT, AND WHERE. A card is a record in the encrypted vault (folder `card`): its label, brand, last four digits, expiry
 * and the name on it. Those are what a wallet shows on its own picker ("Visa ending 4242, expires 04/27") and are shown to the
 * agent, which needs them to say which card it is about to use. The NUMBER and the SECURITY CODE sit in the same sealed record
 * (AES-256-GCM under the vault key, like a password) and leave this module through one function, `readCardSecret`, whose only
 * caller types them into a form box. They are deliberately NOT named secrets: a named secret can be sent to a destination or
 * typed into any box by name (send_secret, `secret:<name>`), and a card must reach a page only through the approved fill.
 * Both are registered with the scrubber when used, so no page view, screenshot or log shows them.
 *
 * THE SECURITY CODE IS OPTIONAL. A person may leave it out when adding a card; the fill then asks for it privately each time
 * and keeps nothing. Kept, it is treated exactly like the number.
 *
 * A CARD IS NEVER USED WITHOUT THE PERSON SAYING SO. The rule lives where the fill happens (tools/computer-web.ts): each use
 * is approved in a private prompt naming the site and the card, an unattended run never gets a card, and a chat that cannot
 * ask the person privately never gets one either. This module only stores, matches and formats. */
import { randomUUID } from 'node:crypto';
import { readVaultRecords, removeVaultRecord, writeVaultRecord } from './credential-vault.js';
import type { FieldHint } from './profiles.js';

const FOLDER = 'card';
const MAX_CARDS = 12;

/** What a wallet shows of a card. Never the number, never the security code. */
export type Card = { label: string; brand: string; last4: string; expMonth: string; expYear: string; name?: string; hasCode: boolean; addedAt: string };
export type SavedCard = Card & { id: string };
export type CardSecret = 'number' | 'code';
/** The part of a card a form box asks for. */
export type CardField = 'number' | 'exp' | 'exp-month' | 'exp-year' | 'code' | 'name';

/** The sealed record: what is shown, plus the two values that never are. */
type StoredCard = Card & { number: string; code?: string };
const shown = ({ number: _number, code: _code, ...card }: StoredCard): Card => card;
const digits = (value: string): string => value.replace(/\D+/g, '');

/** The Luhn check every card number passes. Pure. */
export function luhnValid(number: string): boolean {
  const d = digits(number);
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/** The network a number belongs to, from its first digits; "Card" when none of the common ranges fits. Pure. */
export function cardBrand(number: string): string {
  const d = digits(number);
  if (/^4/.test(d)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]|[3-6]|7[01]|720))/.test(d)) return 'Mastercard';
  if (/^3[47]/.test(d)) return 'American Express';
  if (/^(6011|65|64[4-9])/.test(d)) return 'Discover';
  if (/^35(2[89]|[3-8])/.test(d)) return 'JCB';
  if (/^3(0[0-5]|[689])/.test(d)) return 'Diners Club';
  if (/^62/.test(d)) return 'UnionPay';
  return 'Card';
}

/** An expiry as a person types it ("4/27", "04 / 2027", "0427", "2027-04") into month and four-digit year; null when it is not one. Pure. */
export function parseExpiry(text: string): { month: string; year: string } | null {
  const t = text.trim();
  const iso = /^(20\d{2})\D+(\d{1,2})$/.exec(t);
  const split = iso ? [iso[2]!, iso[1]!] : /^(\d{1,2})\D+(\d{2}|\d{4})$/.exec(t)?.slice(1) ?? (/^(\d{2})(\d{2}|\d{4})$/.exec(digits(t)) && digits(t) === t.replace(/\s+/g, '') ? [digits(t).slice(0, 2), digits(t).slice(2)] : null);
  if (!split) return null;
  const month = Number(split[0]);
  const year = split[1]!.length === 2 ? 2000 + Number(split[1]) : Number(split[1]);
  if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2099)) return null;
  return { month: String(month).padStart(2, '0'), year: String(year) };
}

/** True once the card's last month has passed. Pure. */
export function cardExpired(card: Pick<Card, 'expMonth' | 'expYear'>, now: Date = new Date()): boolean {
  const year = Number(card.expYear);
  const month = Number(card.expMonth);
  return year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1);
}

/** One line a person recognises their card by, as a wallet's picker shows it. Pure. */
export function describeCard(card: Card): string {
  return `${card.brand} ending ${card.last4}, expires ${card.expMonth}/${card.expYear.slice(2)}${card.label && card.label !== card.brand ? ` (${card.label})` : ''}`;
}

/** The same line with what is kept for it, for the agent and the list. Pure. */
export function describeSavedCard(card: Card, now: Date = new Date()): string {
  return `${describeCard(card)}${card.name ? `, name ${card.name}` : ''}; security code ${card.hasCode ? 'saved' : 'asked each time'}${cardExpired(card, now) ? '; EXPIRED' : ''}`;
}

export async function listCards(stateDir: string): Promise<SavedCard[]> {
  return (await readVaultRecords<StoredCard>(stateDir, FOLDER)).map(({ id, value }) => ({ id, ...shown(value) })).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

/** Keeps a card. The number must pass the Luhn check and the expiry must be a month and year; a card with the same number
 * replaces the one before it (a renewed card keeps its place). A security code given replaces the kept one, an empty one
 * forgets it, and none given leaves it as it was. */
export async function saveCard(stateDir: string, input: { number: string; expiry: string; code?: string; name?: string; label?: string }): Promise<SavedCard> {
  const number = digits(input.number);
  if (!luhnValid(number)) throw new Error('That is not a valid card number.');
  const expiry = parseExpiry(input.expiry);
  if (!expiry) throw new Error('The expiry is a month and a year, like 04/27.');
  const code = digits(input.code ?? '');
  if (code && (code.length < 3 || code.length > 4)) throw new Error('The security code is 3 or 4 digits.');
  const stored = await readVaultRecords<StoredCard>(stateDir, FOLDER);
  const existing = stored.find(({ value }) => value.number === number);
  if (!existing && stored.length >= MAX_CARDS) throw new Error(`At most ${MAX_CARDS} cards are kept. Remove one first.`);
  const brand = cardBrand(number);
  const id = existing?.id ?? randomUUID();
  const name = input.name?.trim().slice(0, 80) || existing?.value.name;
  const kept = code || (input.code === undefined ? existing?.value.code : undefined);
  const card: Card = {
    label: (input.label?.trim() || existing?.value.label || brand).slice(0, 40), brand, last4: number.slice(-4),
    expMonth: expiry.month, expYear: expiry.year, ...(name ? { name } : {}), hasCode: Boolean(kept), addedAt: existing?.value.addedAt ?? new Date().toISOString(),
  };
  await writeVaultRecord(stateDir, FOLDER, id, { ...card, number, ...(kept ? { code: kept } : {}) } satisfies StoredCard);
  return { id, ...card };
}

/** Removes a card, number and code with it. `which`: its id, its last four digits, or its label. */
export async function removeCard(stateDir: string, which: string): Promise<SavedCard | undefined> {
  const want = which.trim().toLowerCase();
  const all = await listCards(stateDir);
  const matches = all.filter(card => card.id === which || card.last4 === digits(which) || card.label.toLowerCase() === want);
  if (matches.length !== 1) return undefined;
  const card = matches[0]!;
  await removeVaultRecord(stateDir, FOLDER, card.id);
  return card;
}

/** For filling a form box only: callers must never put the value in model-visible output. */
export async function readCardSecret(stateDir: string, card: SavedCard, kind: CardSecret): Promise<string | undefined> {
  const record = (await readVaultRecords<StoredCard>(stateDir, FOLDER)).find(({ id }) => id === card.id)?.value;
  return kind === 'number' ? record?.number : record?.code;
}

const plain = (text: string): string => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/**
 * The part of a card a form box asks for: its autocomplete token first (the HTML standard's cc-* names, which every payment
 * provider's hosted fields carry), then its own words. A postal code, a gift card, a card HOLDER's address and a "card type"
 * picker are not card fields. Undefined: not a card field. Pure.
 *
 * `onCardForm`: the page shows a card-number box. "Security code" and "verification code" are also what a two-factor prompt
 * calls its box, so those words mean a card's code only beside a card number; cvc, cvv and the cc-csc token always do.
 */
export function cardFieldFor(hint: FieldHint, onCardForm = false): CardField | undefined {
  const tokens = hint.autocomplete.toLowerCase().split(/\s+/);
  if (tokens.includes('cc-number')) return 'number';
  if (tokens.includes('cc-exp')) return 'exp';
  if (tokens.includes('cc-exp-month')) return 'exp-month';
  if (tokens.includes('cc-exp-year')) return 'exp-year';
  if (tokens.includes('cc-csc')) return 'code';
  if (tokens.includes('cc-name')) return 'name';
  const text = plain(`${hint.label ?? ''} ${hint.text}`);
  if (/ (gift|loyalty|membership|library|id|identity|business|sim|green) card | card (type|brand|nickname|label) | postal | zip | post code | coupon | promo /.test(text)) return undefined;
  if (tokens.includes('one-time-code')) return undefined;
  if (/ (cvc|cvv|cvn|csc|cvc2|cvv2) | card code | card security code | card verification /.test(text)) return 'code';
  if (onCardForm && / security code | verification (code|value) | cid /.test(text)) return 'code';
  if (/ (card ?number|cardnumber|cc ?num(ber)?|ccnumber|credit card|debit card|numero de tarjeta|kartennummer|numero de carte) /.test(text) && !/ name | holder /.test(text)) return 'number';
  if (/ (exp(iry|iration|ires)?|valid thru|valid until|vencimiento|ablauf) /.test(text) || / mm ?yy(yy)? /.test(text)) {
    if (/ (exp\w* )?(month|mes|monat|mm) /.test(text) && !/ yy| year /.test(text)) return 'exp-month';
    if (/ (year|ano|jahr|yy|yyyy) /.test(text) && !/ (month|mm) /.test(text)) return 'exp-year';
    return 'exp';
  }
  if (/ (name on card|cardholder( name)?|card holder( name)?|ccname|cc name|nombre en la tarjeta|karteninhaber) /.test(text)) return 'name';
  return undefined;
}

/**
 * What to type into one card box, in the form the box expects. An expiry follows the box's own placeholder ("MM / YY",
 * "MM/YYYY", "MMYY"); with none, "MM/YY", which payment fields format as typed. A year box takes two digits when it holds
 * only two. Undefined: this card has nothing for the box (a name it does not carry). Pure.
 */
export function cardValueFor(kind: CardField, card: Card, secrets: { number?: string; code?: string }, box: { placeholder?: string; maxlength?: number } = {}): string | undefined {
  const hint = (box.placeholder ?? '').toLowerCase();
  const yy = card.expYear.slice(2);
  switch (kind) {
    case 'number': return secrets.number;
    case 'code': return secrets.code;
    case 'name': return card.name;
    case 'exp-month': return box.maxlength === 1 ? String(Number(card.expMonth)) : card.expMonth;
    case 'exp-year': return (box.maxlength === 2 || /^\s*yy\s*$/.test(hint)) ? yy : card.expYear;
    case 'exp': {
      const year = /yyyy/.test(hint) || box.maxlength === 7 && !/\s/.test(hint) && /\//.test(hint) ? card.expYear : yy;
      const sep = /mm\s*\/\s*yy/.test(hint) ? hint.match(/mm(\s*\/\s*)yy/)![1]! : /mm\s*-\s*yy/.test(hint) ? '-' : /mmyy/.test(hint) || box.maxlength === 4 ? '' : '/';
      return `${card.expMonth}${sep}${year}`;
    }
  }
}

/** How long one approval of one card on one site covers further boxes of the same form (a hosted payment form is filled a box per call). */
export const CARD_APPROVAL_MS = 5 * 60_000;
