import { expect, it } from 'vitest';
import { classifyRejection, DEFAULT_POLICY, generatePassword, parsePolicy, relax } from './password-policy.js';

const many = (policy = DEFAULT_POLICY): string[] => Array.from({ length: 60 }, () => generatePassword(policy));

it('makes 24 characters with every class by default, differently each time', () => {
  const all = many();
  for (const password of all) {
    expect(password).toHaveLength(24);
    expect(password).toMatch(/[a-z]/); expect(password).toMatch(/[A-Z]/); expect(password).toMatch(/\d/); expect(password).toMatch(/[!@#$%^*_-]/);
  }
  expect(new Set(all).size).toBe(all.length);
});

it('keeps the default for text that says nothing about a password', () => {
  expect(parsePolicy({ text: 'Create your account. Already have one? Sign in. Up to 10 users on the free plan.' })).toMatchObject({ length: 24, minLength: 8, symbols: '!@#$%^*-_' });
  expect(parsePolicy()).toMatchObject({ length: 24 });
});

it('reads a minimum length from hint text and from minlength', () => {
  expect(parsePolicy({ text: 'Password must be at least 12 characters' })).toMatchObject({ minLength: 12, length: 24 });
  expect(parsePolicy({ text: 'Minimum 15 characters, one number' })).toMatchObject({ minLength: 15 });
  expect(parsePolicy({ text: '16+ characters' })).toMatchObject({ minLength: 16 });
  expect(parsePolicy({ minlength: 16 })).toMatchObject({ minLength: 16, length: 24 });
  // A floor above the default length lifts the length.
  const longer = parsePolicy({ text: 'Use at least 32 characters' });
  expect(longer.length).toBe(32);
  expect(generatePassword(longer)).toHaveLength(32);
});

it('reads a maximum length and lowers the length to it', () => {
  expect(parsePolicy({ maxlength: 20 })).toMatchObject({ maxLength: 20, length: 20 });
  expect(parsePolicy({ text: 'Between 8 and 16 characters' })).toMatchObject({ minLength: 8, maxLength: 16, length: 16 });
  expect(parsePolicy({ text: 'Password cannot be longer than 14 characters' }).maxLength).toBe(14);
  expect(parsePolicy({ text: 'at least 12 characters', maxlength: 64, minlength: 10 })).toMatchObject({ minLength: 12, maxLength: 64, length: 24 });
  for (const password of many(parsePolicy({ maxlength: 20, minlength: 16 }))) expect(password).toHaveLength(20);
});

it('reads symbol restrictions', () => {
  for (const text of ['No special characters', 'Letters and numbers only', 'Alphanumeric only', 'Special characters are not allowed']) expect(parsePolicy({ text }).symbols).toBe('');
  for (const password of many(parsePolicy({ text: 'no symbols' }))) { expect(password).toMatch(/^[A-Za-z0-9]{24}$/); expect(password).toMatch(/\d/); expect(password).toMatch(/[A-Z]/); }
  expect(parsePolicy({ text: 'Include a special character (! @ #)' }).symbols).toBe('!@#');
  expect(parsePolicy({ text: 'Must contain a special character' }).symbols).toBe('!@#$%^*-_');
});

it('honours an HTML pattern by trying again until the password matches it', () => {
  const policy = parsePolicy({ pattern: '[A-Za-z0-9]+', minlength: 10 });
  for (const password of many(policy)) expect(password).toMatch(/^[A-Za-z0-9]+$/);
  const hex = parsePolicy({ pattern: '(?=.*\\d)(?=.*[A-Z]).{12,}' });
  for (const password of many(hex)) expect(password).toMatch(/^(?=.*\d)(?=.*[A-Z]).{12,}$/);
});

it('reads what an error next to the box complains about', () => {
  expect(classifyRejection('Password must be at least 14 characters')).toMatchObject({ tooShort: 14 });
  expect(classifyRejection('Password is too long (max 16 characters)')).toMatchObject({ tooLong: 16 });
  expect(classifyRejection('Password contains invalid characters. Special characters are not allowed')).toMatchObject({ characters: true });
  expect(classifyRejection('Password is too short')).toMatchObject({ tooShort: true });
});

it('relaxes the rules from what the site said, narrowing symbols each try', () => {
  const long = relax(DEFAULT_POLICY, 'Password must be at most 12 characters', 1);
  expect(long).toMatchObject({ length: 12, maxLength: 12 });
  const symbols = relax(DEFAULT_POLICY, 'Special characters are not allowed', 1);
  expect(symbols.symbols).toBe('!@#');
  expect(relax(symbols, 'Special characters are not allowed', 2).symbols).toBe('');
  expect(relax(DEFAULT_POLICY, 'Something went wrong with the password', 3).symbols).toBe('');
  const short = relax({ ...DEFAULT_POLICY, length: 10, maxLength: 128 }, 'Password must be at least 20 characters', 1);
  expect(short.length).toBeGreaterThanOrEqual(20);
  // Never below a floor the page set, never above its ceiling.
  const bounded = relax(parsePolicy({ minlength: 16, maxlength: 18 }), 'Password too short', 1);
  expect(bounded.length).toBeLessThanOrEqual(18);
  expect(bounded.length).toBeGreaterThanOrEqual(16);
});
