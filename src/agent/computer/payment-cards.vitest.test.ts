import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockCredentialVault, namedSecretNames } from './credential-vault.js';
import { cardBrand, cardExpired, cardFieldFor, cardValueFor, describeCard, describeSavedCard, listCards, luhnValid, parseExpiry, readCardSecret, removeCard, saveCard, type Card } from './payment-cards.js';

// Test numbers the card networks publish for this purpose; none is a real account.
const VISA = '4242 4242 4242 4242';
const AMEX = '378282246310005';
const MASTERCARD = '5555555555554444';

let dir = '';
afterEach(async () => { if (dir) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); dir = ''; } });
const hint = (autocomplete: string, label = '', name = '') => ({ autocomplete, type: 'text', label, text: `${label} ${name}` });

describe('card rules', () => {
  it('checks the number and names its network', () => {
    expect(luhnValid(VISA)).toBe(true);
    expect(luhnValid('4242 4242 4242 4241')).toBe(false);
    expect(luhnValid('1234')).toBe(false);
    expect([cardBrand(VISA), cardBrand(AMEX), cardBrand(MASTERCARD), cardBrand('6011111111111117'), cardBrand('9999999999999995')]).toEqual(['Visa', 'American Express', 'Mastercard', 'Discover', 'Card']);
  });

  it('reads an expiry the ways people type it, and nothing else', () => {
    for (const typed of ['04/27', '4/27', '04 / 2027', '0427', '2027-04', '04-2027']) expect(parseExpiry(typed), typed).toEqual({ month: '04', year: '2027' });
    for (const typed of ['13/27', '00/27', 'April', '4', '04/1999']) expect(parseExpiry(typed), typed).toBeNull();
    expect(cardExpired({ expMonth: '04', expYear: '2027' }, new Date('2027-04-30T12:00:00Z'))).toBe(false);
    expect(cardExpired({ expMonth: '04', expYear: '2027' }, new Date('2027-05-02T12:00:00Z'))).toBe(true);
  });

  it('knows which part of a card a box asks for: the standard tokens first, then its words', () => {
    expect(cardFieldFor(hint('cc-number'))).toBe('number');
    expect(cardFieldFor(hint('billing cc-exp'))).toBe('exp');
    expect([cardFieldFor(hint('cc-exp-month')), cardFieldFor(hint('cc-exp-year')), cardFieldFor(hint('cc-csc')), cardFieldFor(hint('cc-name'))]).toEqual(['exp-month', 'exp-year', 'code', 'name']);
    expect(cardFieldFor(hint('', 'Card number', 'cardnumber'))).toBe('number');
    expect(cardFieldFor(hint('', 'Security code', 'cvc'))).toBe('code');
    // "Security code" alone is also a two-factor box: a card's code only beside a card number.
    expect(cardFieldFor(hint('', 'Security code'))).toBeUndefined();
    expect(cardFieldFor(hint('', 'Security code'), true)).toBe('code');
    expect(cardFieldFor(hint('one-time-code', 'Security code'), true)).toBeUndefined();
    expect(cardFieldFor(hint('', 'Enter the verification code we sent you'))).toBeUndefined();
    expect(cardFieldFor(hint('', 'CVV'))).toBe('code');
    expect(cardFieldFor(hint('', 'Expiry date', 'exp-date'))).toBe('exp');
    expect(cardFieldFor(hint('', 'MM / YY'))).toBe('exp');
    expect(cardFieldFor(hint('', 'Expiration month'))).toBe('exp-month');
    expect(cardFieldFor(hint('', 'Expiration year'))).toBe('exp-year');
    expect(cardFieldFor(hint('', 'Name on card'))).toBe('name');
  });

  it('leaves alone what only sounds like a card: a postal code, a gift card, a verification code, a name', () => {
    for (const label of ['ZIP / Postal code', 'Gift card number', 'Card type', 'Promo code', 'Verification code', 'Full name', 'Email', 'Phone number', 'Address line 1', 'ID card number']) {
      expect(cardFieldFor(hint('', label)), label).toBeUndefined();
    }
    expect(cardFieldFor(hint('one-time-code', 'Code'))).toBeUndefined();
    expect(cardFieldFor(hint('postal-code', 'Postal code'))).toBeUndefined();
  });

  it('types each part the way its box expects', () => {
    const card: Card = { label: 'Visa', brand: 'Visa', last4: '4242', expMonth: '04', expYear: '2027', name: 'Ada Lovelace', hasCode: true, addedAt: '2026-11-14T00:00:00.000Z' };
    const secrets = { number: '4242424242424242', code: '123' };
    expect(cardValueFor('number', card, secrets)).toBe('4242424242424242');
    expect(cardValueFor('code', card, secrets)).toBe('123');
    expect(cardValueFor('code', card, {})).toBeUndefined();
    expect(cardValueFor('name', card, secrets)).toBe('Ada Lovelace');
    expect(cardValueFor('exp', card, secrets)).toBe('04/27');
    expect(cardValueFor('exp', card, secrets, { placeholder: 'MM / YY' })).toBe('04 / 27');
    expect(cardValueFor('exp', card, secrets, { placeholder: 'MM/YYYY' })).toBe('04/2027');
    expect(cardValueFor('exp', card, secrets, { placeholder: 'MMYY' })).toBe('0427');
    expect(cardValueFor('exp-month', card, secrets)).toBe('04');
    expect(cardValueFor('exp-year', card, secrets)).toBe('2027');
    expect(cardValueFor('exp-year', card, secrets, { maxlength: 2 })).toBe('27');
    expect(cardValueFor('exp-year', card, secrets, { placeholder: 'YY' })).toBe('27');
  });
});

describe('the card store', () => {
  it('keeps the number and code encrypted, and shows only what a wallet shows', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-card-'));
    const saved = await saveCard(dir, { number: VISA, expiry: '04/27', code: '123', name: 'Ada Lovelace' });
    expect(saved).toMatchObject({ brand: 'Visa', last4: '4242', expMonth: '04', expYear: '2027', name: 'Ada Lovelace', hasCode: true, label: 'Visa' });
    expect(describeCard(saved)).toBe('Visa ending 4242, expires 04/27');
    expect(describeSavedCard(saved, new Date('2026-11-14T00:00:00Z'))).toBe('Visa ending 4242, expires 04/27, name Ada Lovelace; security code saved');
    expect(JSON.stringify(await listCards(dir))).not.toMatch(/4242424242424242|"123"/);
    expect(await readCardSecret(dir, saved, 'number')).toBe('4242424242424242');
    expect(await readCardSecret(dir, saved, 'code')).toBe('123');
    // Nothing on disk is readable, and nothing is a named secret (those can be sent or typed by name).
    expect(await namedSecretNames(dir)).toEqual([]);
    const vault = join(dir, 'computer', 'vault');
    for (const folder of await readdir(vault, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      for (const file of await readdir(join(vault, folder.name))) {
        const raw = await readFile(join(vault, folder.name, file), 'utf8');
        expect(raw).not.toContain('4242424242424242');
        expect(raw).not.toContain('Ada Lovelace');
      }
    }
  });

  it('a card with no security code is asked each time; the same number again replaces the card', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-card-'));
    const first = await saveCard(dir, { number: AMEX, expiry: '1/28', label: 'Work' });
    expect(first).toMatchObject({ brand: 'American Express', last4: '0005', hasCode: false, label: 'Work' });
    expect(await readCardSecret(dir, first, 'code')).toBeUndefined();
    expect(describeSavedCard(first, new Date('2026-11-14T00:00:00Z'))).toContain('security code asked each time');
    const renewed = await saveCard(dir, { number: AMEX, expiry: '01/31', code: '1234' });
    expect(renewed.id).toBe(first.id);
    expect(renewed).toMatchObject({ expYear: '2031', hasCode: true, label: 'Work' });
    expect(await listCards(dir)).toHaveLength(1);
  });

  it('refuses what is not a card, and removes one by its last four with both secrets', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-card-'));
    await expect(saveCard(dir, { number: '4242 4242 4242 4241', expiry: '04/27' })).rejects.toThrow('not a valid card number');
    await expect(saveCard(dir, { number: VISA, expiry: '13/27' })).rejects.toThrow('expiry');
    await expect(saveCard(dir, { number: VISA, expiry: '04/27', code: '12' })).rejects.toThrow('security code');
    const visa = await saveCard(dir, { number: VISA, expiry: '04/27', code: '123' });
    await saveCard(dir, { number: MASTERCARD, expiry: '06/29' });
    expect(await removeCard(dir, '0000')).toBeUndefined();
    expect((await removeCard(dir, '4242'))?.id).toBe(visa.id);
    expect((await listCards(dir)).map(card => card.last4)).toEqual(['4444']);
    expect(await readCardSecret(dir, visa, 'number')).toBeUndefined();
    expect(await readCardSecret(dir, visa, 'code')).toBeUndefined();
  });
});
