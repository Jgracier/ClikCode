import { expect, it } from 'vitest';
import { loginValueFor } from './login-fill.js';

const saved = { username: 'ada@example.com', password: 'pw-1' };
const hint = (text: string, autocomplete = '', type = 'text') => ({ autocomplete, type, text });

it('fills a password box with the password and an account box with the username, and nothing else', () => {
  expect(loginValueFor(saved, { password: true, hint: hint('Password', 'current-password', 'password') })).toBe('pw-1');
  expect(loginValueFor(saved, { password: true, hint: hint('Password', 'new-password', 'password') })).toBeUndefined();
  expect(loginValueFor(saved, { password: false, hint: hint('Email or phone') })).toBe('ada@example.com');
  expect(loginValueFor(saved, { password: false, hint: hint('Username', 'username') })).toBe('ada@example.com');
  expect(loginValueFor(saved, { password: false, hint: hint('Verification code', 'one-time-code') })).toBeUndefined();
  expect(loginValueFor(saved, { password: false, hint: hint('First name', 'given-name') })).toBeUndefined();
});
