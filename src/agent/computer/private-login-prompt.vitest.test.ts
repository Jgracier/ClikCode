import { expect, it } from 'vitest';
import { askPrivateLogin } from './private-login-prompt.js';
import type { TurnObserver } from '../../turn/observer.js';
import type { HarnessQuestionRequest } from '../../harness/events/question.js';

it('asks for every login field privately and returns values only to the local caller', async () => {
  let request: HarnessQuestionRequest | undefined;
  const observer = { askQuestions: async (asked: HarnessQuestionRequest) => {
    request = asked;
    return { kind: 'answered' as const, answers: { email: ['private@example.com'], password: ['private-secret'] } };
  } } as TurnObserver;
  expect(await askPrivateLogin(observer, 'https://accounts.google.com')).toEqual({
    accountId: '', email: 'private@example.com', password: 'private-secret',
  });
  expect(request?.questions.map(question => question.secret)).toEqual([true, true, true]);
  expect(JSON.stringify(request)).not.toContain('private-secret');
});
