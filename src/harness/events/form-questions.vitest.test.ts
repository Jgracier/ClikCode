import { describe, expect, it } from 'vitest';
import { formToQuestions } from './form-questions.js';

describe('a JSON-schema form as questions', () => {
  it('reads claude-agent-acp\'s AskUserQuestion form: select, multi-select and the custom box', () => {
    const form = formToQuestions('Please answer the following questions.', {
      type: 'object',
      properties: {
        question_0: { type: 'string', title: 'Auth', description: 'Which method?', oneOf: [{ const: 'oauth', title: 'OAuth', description: 'hosted' }, { const: 'key', title: 'API key' }] },
        question_0_custom: { type: 'string', title: 'Other' },
        question_1: { type: 'array', title: 'Extras', description: 'Which extras?', items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] } },
        question_1_custom: { type: 'string', title: 'Other' },
      },
    }, 'Claude asks')!;
    expect(form.request.title).toBe('Please answer the following questions.');
    expect(form.request.questions).toEqual([
      { id: 'question_0', header: 'Auth', prompt: 'Which method?', optional: true, multiSelect: false, allowFreeText: true, options: [{ label: 'OAuth', description: 'hosted' }, { label: 'API key' }] },
      { id: 'question_1', header: 'Extras', prompt: 'Which extras?', optional: true, multiSelect: true, allowFreeText: true, options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    // Labels come back as the form's own consts; typed text goes to the companion field.
    expect(form.content({ question_0: ['API key'], question_1: ['A', 'B', 'something else'] })).toEqual({ question_0: 'key', question_1: ['a', 'b'], question_1_custom: 'something else' });
    expect(form.content({ question_0: ['my own'] })).toEqual({ question_0_custom: 'my own' });
    expect(form.content({})).toEqual({});
  });

  it('reads MCP primitives: text, number, boolean, legacy enum names, required', () => {
    const form = formToQuestions('Sign up', {
      type: 'object', required: ['name'],
      properties: {
        name: { type: 'string', title: 'Name' },
        api_token: { type: 'string', title: 'Token' },
        seats: { type: 'integer', title: 'Seats' },
        agree: { type: 'boolean', title: 'Agree' },
        tier: { type: 'string', enum: ['f', 'p'], enumNames: ['Free', 'Pro'] },
      },
    }, 'docs asks')!;
    const byId = Object.fromEntries(form.request.questions.map((q) => [q.id, q]));
    expect(byId.name).toMatchObject({ allowFreeText: true, options: [] });
    expect(byId.name).not.toHaveProperty('optional');
    expect(byId.seats).toHaveProperty('optional', true);
    expect(byId.api_token).toMatchObject({ secret: true });
    expect(byId.tier!.options.map((o) => o.label)).toEqual(['Free', 'Pro']);
    expect(form.content({ name: ['Ada'], seats: ['3.7'], agree: ['No'], tier: ['Pro'], api_token: ['t'] }))
      .toEqual({ name: 'Ada', seats: 3, agree: false, tier: 'p', api_token: 't' });
    expect(form.content({ seats: ['many'] })).toEqual({});
  });

  it('has nothing to ask of an empty form', () => {
    expect(formToQuestions('m', { type: 'object', properties: {} }, 't')).toBeUndefined();
    expect(formToQuestions('m', true, 't')).toBeUndefined();
  });
});
