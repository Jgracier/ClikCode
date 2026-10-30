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

it('never puts the account email into a business name, registration number, phone or postal code box', () => {
  const field = (label: string, name: string) => ({ password: false, hint: { autocomplete: '', type: 'text', label, text: `${label} ${name}` } });
  for (const [label, name] of [['Business name', 'account[business_name]'], ['Registration number', 'account[registration_number]'], ['Business phone', 'account[phone]'], ['Postal code', 'account[address]']] as const) {
    expect([label, loginValueFor(saved, field(label, name))]).toEqual([label, undefined]);
  }
  expect(loginValueFor(saved, { password: false, hint: { autocomplete: '', type: 'email', label: 'Email', text: 'Email user[email]' } })).toBe('ada@example.com');
  expect(loginValueFor(saved, { password: false, hint: { autocomplete: '', type: 'text', label: 'Correo electrónico', text: 'Correo electrónico' } })).toBe('ada@example.com');
});
