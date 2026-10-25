import { describe, expect, it } from 'vitest';
import { classifyRejection, DEFAULT_POLICY, generatePassword, generatePassword as gen, hasRepeatOrSequence, parsePolicy, relax } from './password-policy.js';

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

describe('repeat and sequence rules', () => {
  it('detects repeats and sequences', () => {
    expect(hasRepeatOrSequence('aXbb9')).toBe(true);
    expect(hasRepeatOrSequence('xabc1')).toBe(true);
    expect(hasRepeatOrSequence('x321y')).toBe(true);
    expect(hasRepeatOrSequence('xaA9!')).toBe(true);
    expect(hasRepeatOrSequence('xAbC9!')).toBe(true);
    expect(hasRepeatOrSequence('xA9!k2')).toBe(false);
  });
  it('never generates one', () => {
    for (let i = 0; i < 300; i++) expect(hasRepeatOrSequence(gen())).toBe(false);
  });
});

/** The ShipEngine rule: "Password must be 12-64 characters with an uppercase letter and a special character, and no repeated or sequential characters". */
const SHIPENGINE = 'Password must be 12–64 characters with an uppercase letter and a special character, and no repeated or sequential characters';
function shipEngineAccepts(password: string): boolean {
  if (password.length < 12 || password.length > 64 || !/[A-Z]/.test(password) || !/[^A-Za-z0-9]/.test(password)) return false;
  const lower = password.toLowerCase();
  for (let i = 1; i < lower.length; i++) {
    if (lower[i] === lower[i - 1]) return false;
    if (i >= 2) {
      const a = lower.charCodeAt(i - 2), b = lower.charCodeAt(i - 1), c = lower.charCodeAt(i);
      if ((b - a === 1 && c - b === 1) || (a - b === 1 && b - c === 1)) return false;
    }
  }
  return !/qwe|wer|ert|rty|tyu|yui|uio|iop|asd|sdf|dfg|fgh|ghj|hjk|jkl|zxc|xcv|cvb|vbn|bnm/.test(lower) && !/ewq|rew|tre|ytr|uyt|iuy|oiu|poi|dsa|fds|gfd|hgf|jhg|kjh|lkj|cxz|vcx|bvc|nbv|mnb/.test(lower);
}

describe('strict policies (ShipEngine)', () => {
  it('reads the rules out of the refusal text', () => {
    const policy = parsePolicy({ text: SHIPENGINE });
    expect(policy).toMatchObject({ minLength: 12, maxLength: 64 });
    expect(policy.rules).toMatchObject({ noRepeat: true, noSequence: true, requireSymbol: true });
    expect(policy.symbols).not.toBe('');
    expect(parsePolicy({ text: 'No more than 2 identical characters in a row' }).rules).toMatchObject({ maxIdentical: 2, inRow: true });
    expect(parsePolicy({ text: 'Do not use 3 or more of the same character' }).rules?.maxIdentical).toBe(2);
    expect(parsePolicy({ text: 'Use 8 to 20 characters' }).rules).toBeUndefined();
  });

  it('generates 1,000 passwords the ShipEngine checker accepts', () => {
    const policy = parsePolicy({ text: SHIPENGINE });
    for (let count = 0; count < 1000; count++) {
      const password = generatePassword(policy);
      expect(shipEngineAccepts(password), `rejected attempt ${count}`).toBe(true);
    }
  });

  it('also holds with the default policy, case-insensitively, and has no keyboard runs', () => {
    for (let count = 0; count < 1000; count++) {
      const password = generatePassword();
      expect(hasRepeatOrSequence(password)).toBe(false);
      expect(shipEngineAccepts(password)).toBe(true);
    }
    expect(hasRepeatOrSequence('xaAy')).toBe(true);
    expect(hasRepeatOrSequence('xQwEy')).toBe(true);
    expect(hasRepeatOrSequence('x321y')).toBe(true);
    expect(hasRepeatOrSequence('xCbAy')).toBe(true);
    expect(hasRepeatOrSequence('x7k!Pm')).toBe(false);
  });

  it('keeps the symbol when the refusal asks for one, over four refusals, instead of stripping it', () => {
    let policy = parsePolicy();
    for (let attempt = 1; attempt <= 4; attempt++) {
      policy = relax(policy, SHIPENGINE, attempt);
      expect(policy.symbols, `attempt ${attempt}`).not.toBe('');
      expect(policy.rules).toMatchObject({ noRepeat: true, noSequence: true });
      for (let count = 0; count < 50; count++) expect(shipEngineAccepts(generatePassword(policy))).toBe(true);
    }
  });

  it('still drops symbols when a refusal says they are not allowed', () => {
    expect(relax(parsePolicy(), 'Special characters are not allowed', 2).symbols).toBe('');
  });

  it('honours a limit on identical characters', () => {
    const policy = parsePolicy({ text: 'No more than 1 identical character' });
    for (let count = 0; count < 200; count++) {
      const lowered = generatePassword(policy).toLowerCase();
      expect(new Set(lowered).size).toBe(lowered.length);
    }
  });
});
