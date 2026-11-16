/** The user's standing rule for paying by card during unattended sign-ups (set 2026-11-16: "sign up for things that need a
 * credit card but won't charge unless used; no recurring subscriptions"). With the rule on, a saved card may be typed into a
 * payment page with no prompt only when that page itself says nothing is charged until something is used (pay as you go, a
 * card kept for verification, free credits) and says nothing of a subscription, a renewal, a trial that turns into a plan,
 * or an amount due today. Anything else is still the person's to approve. A few uses a day at most, each written down. */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { objectOrEmpty, updateJsonFile } from '../../session/store/json-file.js';
import { computerSettingsPath } from './settings.js';

export type CardRule = 'usage-only' | 'off';
/** Most rule-approved card uses in one day: a mistake in the wording rules costs a few sign-ups, not dozens. */
export const MAX_RULE_USES_PER_DAY = 6;

export async function cardRule(stateDir: string): Promise<CardRule> {
  try { return (JSON.parse(await readFile(computerSettingsPath(stateDir), 'utf8')) as { cardRule?: unknown }).cardRule === 'usage-only' ? 'usage-only' : 'off'; }
  catch { return 'off'; }
}

export async function setCardRule(stateDir: string, rule: CardRule): Promise<void> {
  await updateJsonFile(computerSettingsPath(stateDir), objectOrEmpty, current => ({ ...current, cardRule: rule }));
}

/** Words that say the card pays for something that repeats, or is charged now. */
const RECURRING = /(?:\/|\bper |\ba )\s?(?:month|mo|year|yr|annum|user\/mo)\b|\bmonthly\b|\bannual(?:ly)?\b|\byearly\b|\bsubscri(?:be|ption)\b|\bauto[- ]?renew|\brenew(?:s|al)\b|\btrial (?:ends|expires|period ends)|\bafter (?:your|the) (?:\d+[- ]day )?(?:free )?trial\b|\bbilled (?:every|each|monthly|annually|yearly)\b|\brecurring\b|\bcancel (?:any ?time|before)\b|\buntil (?:you|you've) cancel/i;
/** "Billed monthly for what you use" is how pay-as-you-go invoices; it is not a plan. Taken out before RECURRING is read. */
const USAGE_INVOICE = /\b(?:billed|invoiced|charged) monthly (?:for|based on) (?:your |what you )?(?:usage|use)\b|\bmonthly (?:usage|invoice for usage)\b/gi;
/** Words that say nothing is charged until something is used. One of them must be on the page. */
const NO_CHARGE = /\bwon'?t be charged\b|\bwill not be charged\b|\bnot be charged (?:until|unless)\b|\bno charges? (?:today|now|until|unless)\b|\bnothing (?:is )?(?:due|charged) (?:today|now)\b|[$€£]\s?0(?:\.00)? (?:due|today|now)\b|\bdue today:?\s*[$€£]\s?0(?:\.00)?\b|\bpay[- ]as[- ]you[- ]go\b|\bonly pay for what you use\b|\busage[- ]based\b|\bcharged (?:only )?(?:for|when) (?:what )?you use\b|\bfree (?:tier|credits?)\b|\b(?:verify|verification of) (?:your )?(?:card|payment method|identity)\b|\bcard (?:is )?(?:required|needed) (?:for|to) (?:verif|prevent|avoid)|\bto prevent (?:abuse|fraud|spam)\b|\btemporary (?:authori[sz]ation|hold)\b/i;
/** An amount the page says is charged now. */
const DUE_NOW = /(?:\b(?:due|total|charged?|pay(?:ing)?)\b(?: (?:today|now))?)[^.\n]{0,25}?[$€£]\s?(\d+(?:[.,]\d{1,2})?)|[$€£]\s?(\d+(?:[.,]\d{1,2})?)[^.\n]{0,15}?\b(?:due|charged) (?:today|now)\b/gi;

export interface ChargeTerms { allowed: boolean; why: string }

/** What a payment page says it will charge, read from its own words. Pure. */
export function chargeTerms(pageText: string): ChargeTerms {
  const text = pageText.replace(/\s+/g, ' ').slice(0, 20_000);
  const recurring = RECURRING.exec(text.replace(USAGE_INVOICE, ' '));
  if (recurring) return { allowed: false, why: `the page speaks of a recurring charge ("${recurring[0].trim()}")` };
  for (const due of text.matchAll(DUE_NOW)) {
    const amount = Number((due[1] ?? due[2] ?? '0').replace(',', '.'));
    if (amount > 0) return { allowed: false, why: `the page charges ${due[0].trim()} now` };
  }
  const free = NO_CHARGE.exec(text);
  if (!free) return { allowed: false, why: 'the page does not say that nothing is charged until something is used' };
  return { allowed: true, why: `the page says "${free[0].trim()}" and names no recurring charge` };
}

export interface CardUse { at: string; host: string; card: string; why: string }
const usesPath = (stateDir: string): string => path.join(stateDir, 'computer', 'card-uses.jsonl');

/** How many rule-approved uses today (UTC). */
export async function ruleUsesToday(stateDir: string, now = Date.now()): Promise<number> {
  const day = new Date(now).toISOString().slice(0, 10);
  try { return (await readFile(usesPath(stateDir), 'utf8')).split('\n').filter(line => line.includes(`"at":"${day}`)).length; }
  catch { return 0; }
}

export async function recordCardUse(stateDir: string, use: CardUse): Promise<void> {
  await mkdir(path.dirname(usesPath(stateDir)), { recursive: true, mode: 0o700 });
  await appendFile(usesPath(stateDir), `${JSON.stringify(use)}\n`, { mode: 0o600 });
}

export async function cardUses(stateDir: string): Promise<CardUse[]> {
  try { return (await readFile(usesPath(stateDir), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as CardUse); }
  catch { return []; }
}

/** May a card go into this payment page with no prompt? Only with the rule on, under today's cap, and when the page's own words allow it. */
export async function ruleAllowsCard(stateDir: string, pageText: string, now = Date.now()): Promise<ChargeTerms> {
  if (await cardRule(stateDir) !== 'usage-only') return { allowed: false, why: 'no standing card rule is set' };
  if (await ruleUsesToday(stateDir, now) >= MAX_RULE_USES_PER_DAY) return { allowed: false, why: `the standing rule's ${MAX_RULE_USES_PER_DAY} card uses for today are spent` };
  return chargeTerms(pageText);
}
