import { expect, it } from 'vitest';
import { activityDetails } from './activity-details.js';
import type { HarnessSession } from '../session/model.js';
it('returns only requested calls from the owner, with full arguments and output', () => {
  const event = { id: 'one', kind: 'tool-done', label: 'shell', call: { name: 'bash', input: { command: 'pwd' } }, output: ['whole output'] };
  const session = { messages: [{ role: 'assistant', content: '', activities: [{ event }, { event: { ...event, id: 'other' } }] }] } as unknown as HarnessSession;
  expect(activityDetails(session, ['one'], { messageIndex: 0 })).toEqual([event]);
  expect(activityDetails(session, ['missing'], { messageIndex: 0 })).toEqual([]);
});

it('does not confuse reused call ids in different turns', () => {
  const event = (output: string) => ({ event: { id: 'same', kind: 'tool-done', label: 'tool', output: [output] } });
  const session = { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: '', activities: [event('first')] }, { role: 'user', content: 'second' }, { role: 'assistant', content: '', activities: [event('second')] }] } as unknown as HarnessSession;
  expect(activityDetails(session, ['same'], { userIndex: 0 })[0]?.output).toEqual(['first']);
  expect(activityDetails(session, ['same'], { messageIndex: 3 })[0]?.output).toEqual(['second']);
  expect(activityDetails(session, ['same'])).toEqual([]);
});
