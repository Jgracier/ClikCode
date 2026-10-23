import { expect, it } from 'vitest';
import { askPrivateLogin } from './private-login-prompt.js';
import type { TurnObserver } from '../../turn/observer.js';
import type { HarnessQuestionRequest } from '../../harness/events/question.js';

it('asks for every login field privately and returns values only to the local caller', async () => {
  let request: HarnessQuestionRequest | undefined;
  const observer = { askQuestions: async (asked: HarnessQuestionRequest) => {
    request = asked;
    return { kind: 'answered' as const, answers: { username: ['private@example.com'] } };
  } } as TurnObserver;
  expect(await askPrivateLogin(observer, 'https://accounts.google.com', [
    { index: 0, key: 'username', label: 'Email or phone', kind: 'text', required: true },
  ])).toEqual({ username: 'private@example.com' });
  expect(request?.title).toBe('accounts.google.com sign in');
  expect(request?.questions).toEqual([{
    id: 'username', prompt: 'Enter username or email', options: [], secret: true, maskInput: false,
  }]);
  expect(JSON.stringify(request)).not.toContain('private@example.com');
});

it('masks passwords while keeping other login answers private', async () => {
  let request: HarnessQuestionRequest | undefined;
  const observer = { askQuestions: async (asked: HarnessQuestionRequest) => {
    request = asked;
    return { kind: 'answered' as const, answers: { username: ['person@example.com'], password: ['private password'] } };
  } } as TurnObserver;
  expect(await askPrivateLogin(observer, 'https://example.com', [
    { index: 0, key: 'username', label: 'Email', kind: 'text', required: true },
    { index: 1, key: 'password', label: 'Password', kind: 'password', required: true },
  ])).toEqual({ username: 'person@example.com', password: 'private password' });
  expect(request?.questions.map(question => [question.prompt, question.secret, question.maskInput])).toEqual([
    ['Enter username or email', true, false], ['Enter password', true, true],
  ]);
});

it('asks which saved account as an option list, keeps the answer secret, and refuses an unlisted choice', async () => {
  let request: HarnessQuestionRequest | undefined;
  let answer = 'two@example.com';
  const observer = { askQuestions: async (asked: HarnessQuestionRequest) => {
    request = asked;
    return { kind: 'answered' as const, answers: { account: [answer] } };
  } } as TurnObserver;
  const field = { index: -1, key: 'account', label: 'Choose an account', kind: 'choice' as const, required: true, options: ['one@example.com', 'two@example.com', 'Use a different account'] };
  expect(await askPrivateLogin(observer, 'https://example.com', [field])).toEqual({ account: 'two@example.com' });
  expect(request?.questions).toEqual([{
    id: 'account', prompt: 'Choose an account', secret: true,
    options: [{ label: 'one@example.com' }, { label: 'two@example.com' }, { label: 'Use a different account' }],
  }]);
  expect(request?.title).toBe('example.com sign in');
  answer = 'someone-else@example.com';
  await expect(askPrivateLogin(observer, 'https://example.com', [field])).rejects.toThrow('listed options');
});

it('shows a saved password in the prompt but keeps it masked', async () => {
  let request: HarnessQuestionRequest | undefined;
  const observer = { askQuestions: async (asked: HarnessQuestionRequest) => {
    request = asked;
    return { kind: 'answered' as const, answers: { email: ['other@example.com'], password: ['new-password'] } };
  } } as TurnObserver;
  expect(await askPrivateLogin(observer, 'https://discord.com', [
    { index: 0, key: 'email', label: 'Email or Phone Number', kind: 'text', required: true, current: 'saved@example.com' },
    { index: 1, key: 'password', label: 'Password', kind: 'password', required: true, current: 'saved-password' },
  ])).toEqual({ email: 'other@example.com', password: 'new-password' });
  expect(request?.questions).toEqual([
    { id: 'email', prompt: 'Email or Phone Number', options: [], initial: 'saved@example.com', secret: true, maskInput: false },
    { id: 'password', prompt: 'Password', options: [], initial: 'saved-password', secret: true, maskInput: true },
  ]);
});

it('starts a known value in the text box to edit or leave alone, and lets an optional field stay empty', async () => {
  let request: HarnessQuestionRequest | undefined;
  const observer = { askQuestions: async (asked: HarnessQuestionRequest) => {
    request = asked;
    return { kind: 'answered' as const, answers: { phone: ['+17195550123'], city: ['Calhan'] } };
  } } as TurnObserver;
  expect(await askPrivateLogin(observer, 'https://profile.clikcode', [
    { index: 0, key: 'phone', label: 'Phone', kind: 'text', required: true, current: '+17195550123' },
    { index: 1, key: 'city', label: 'City', kind: 'text', required: true },
    { index: 2, key: 'organization', label: 'Company (optional)', kind: 'text', required: false },
  ])).toEqual({ phone: '+17195550123', city: 'Calhan', organization: '' });
  expect(request?.title).toBe('Your autofill profile');
  expect(request?.questions[0]).toMatchObject({ options: [], initial: '+17195550123' });
  expect(request?.questions[2]).toMatchObject({ optional: true });
});
