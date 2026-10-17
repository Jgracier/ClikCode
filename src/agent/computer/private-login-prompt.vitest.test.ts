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
  expect(request?.questions.map(question => [question.prompt, question.secret])).toEqual([['Email or phone', true]]);
  expect(JSON.stringify(request)).not.toContain('private@example.com');
});
