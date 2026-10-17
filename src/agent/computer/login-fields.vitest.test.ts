import { expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { loginFields, loginFieldSummary, pageControls } from './login-fields.js';
import { observeComputerPage } from '../tools/computer-web.js';

it('reads a sign-in page like any other, with the value of a password field masked', async () => {
  const input = {
    type: 'text', name: 'identifier', id: 'identifierId', autocomplete: 'username webauthn', required: true,
    placeholder: '', labels: [], value: 'private@example.com',
    getAttribute: (key: string) => key === 'aria-label' ? 'Email or phone' : null,
  };
  const typed = 'hunter2-typed';
  const page = {
    url: () => 'https://accounts.google.com/v3/signin/identifier',
    locator: (selector: string) => selector === 'input:visible'
      ? { evaluateAll: async (callback: (inputs: unknown[]) => unknown) => callback([input]) }
      : { evaluateAll: async (callback: (inputs: unknown[]) => unknown) => callback([{ value: typed }]), count: async () => 0 },
    ariaSnapshot: async () => `- textbox "Email or phone" [ref=e1]\n- textbox "Password" [ref=e2]: ${typed}\n- button "Next" [ref=e3]`,
  } as unknown as Page;
  expect((await loginFields(page)).map(field => [field.key, field.label])).toEqual([['username', 'Email or phone']]);
  const observation = await observeComputerPage(page, false);
  expect(observation.output).toContain('textbox "Email or phone"');
  expect(observation.output).toContain('button "Next"');
  expect(JSON.stringify(observation)).not.toContain(typed);
});

it('recognizes an account ID, email and password form from the fields actually on the page', async () => {
  const nodes = [
    ['text', 'accountId', 'Account ID'], ['email', 'email', 'Email'], ['password', 'password', 'Password'],
  ].map(([type, name, label]) => ({
    type, name, id: name, autocomplete: '', required: true, placeholder: '', labels: [], value: `private-${name}`,
    getAttribute: (key: string) => key === 'aria-label' ? label : null,
  }));
  const page = { locator: () => ({ evaluateAll: async (callback: (inputs: unknown[]) => unknown) => callback(nodes) }) } as unknown as Page;
  expect((await loginFields(page)).map(({ key, label }) => [key, label])).toEqual([
    ['accountId', 'Account ID'], ['email', 'Email'], ['password', 'Password'],
  ]);
});

it('lists the buttons and links by name so the agent can press one or ask which, without naming any account', async () => {
  const names = ['Sign in using root user email', 'Sign in as IAM user', 'Justin Gracier justin@example.com', 'Privacy', '', 'Use another account', 'Sign in using root user email', 'x'.repeat(80)];
  const page = { locator: () => ({ evaluateAll: async (callback: (nodes: unknown[]) => unknown) => callback(names.map(innerText => ({ innerText, getAttribute: () => null }))) }) } as unknown as Page;
  const controls = await pageControls(page);
  expect(controls).toEqual(['Sign in using root user email', 'Sign in as IAM user', 'Privacy', 'Use another account']);
  const summary = loginFieldSummary('https://signin.aws.amazon.com', [], controls);
  expect(summary).toContain('Sign in as IAM user');
  expect(summary).toContain('ask_user');
  expect(summary).toContain('picks one');
  expect(summary).not.toContain('justin@example.com');
  expect(loginFieldSummary('https://example.com', [])).not.toContain('Buttons and links');
});
