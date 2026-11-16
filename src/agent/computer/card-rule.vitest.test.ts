/** The standing card rule: a card only where nothing is charged until used, never for something that repeats. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chargeTerms, MAX_RULE_USES_PER_DAY, recordCardUse, ruleAllowsCard, setCardRule } from './card-rule.js';

describe('what a payment page says it charges', () => {
  it.each([
    'Add a payment method. You won\'t be charged until you go over the free tier.',
    'Pay as you go: only pay for what you use. Billed monthly for your usage.',
    'We need a card to verify your identity and to prevent abuse. A temporary authorization of $1 is refunded.',
    'Due today: $0.00. Credits: $5 free credits.',
  ])('allows "%s"', text => expect(chargeTerms(text).allowed).toBe(true));

  it.each([
    ['Start your 14-day free trial. After your trial, $29/month.', /recurring/],
    ['Pro plan $49 per month, billed annually. You won\'t be charged today.', /recurring/],
    ['Subscribe to continue. Cancel anytime.', /recurring/],
    ['Total due today: $19.00', /charges/],
    ['Add a card to continue.', /does not say/],
  ])('refuses "%s"', (text, why) => {
    const terms = chargeTerms(text);
    expect(terms.allowed).toBe(false);
    expect(terms.why).toMatch(why);
  });
});

describe('the standing rule', () => {
  it('is off until set, and stops after the day\'s cap', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-card-rule-'));
    const page = 'Pay as you go. You won\'t be charged until you use the API.';
    expect((await ruleAllowsCard(dir, page)).allowed).toBe(false);
    await setCardRule(dir, 'usage-only');
    expect((await ruleAllowsCard(dir, page)).allowed).toBe(true);
    const now = Date.parse('2026-11-16T12:00:00Z');
    for (let i = 0; i < MAX_RULE_USES_PER_DAY; i++) await recordCardUse(dir, { at: new Date(now).toISOString(), host: 'a.example', card: 'Visa 4242', why: 'test' });
    expect(await ruleAllowsCard(dir, page, now)).toMatchObject({ allowed: false, why: expect.stringMatching(/spent/) });
    await fs.rm(dir, { recursive: true, force: true });
  });
});
