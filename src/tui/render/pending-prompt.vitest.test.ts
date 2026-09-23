import { describe, expect, it } from 'vitest';
import { pendingPromptText } from './pending-prompt.js';

const SENT = 'clean up the prod disk';

describe('the message the user just submitted', () => {
  it('draws the client\'s own copy before the worker has written one', () => {
    // The window that produced the bug: Enter pressed, snapshot pushed, turn
    // not yet journalled. Reading the snapshot alone drew nothing.
    expect(pendingPromptText({ sticky: SENT, lastMessage: { role: 'assistant', content: 'earlier' } })).toBe(SENT);
  });

  it('draws the durable copy for a client that attached mid-turn', () => {
    expect(pendingPromptText({ durable: SENT })).toBe(SENT);
  });

  it('draws it once when both sources have it', () => {
    expect(pendingPromptText({ durable: SENT, sticky: SENT })).toBe(SENT);
  });

  it('stops once the prompt is a real message', () => {
    // The completed snapshot can arrive before the turn is torn down; the
    // stored copy wins, as it does for queued and steered rows.
    expect(pendingPromptText({ sticky: SENT, lastMessage: { role: 'user', content: SENT } })).toBeUndefined();
  });

  it('still draws when the same words are an OLDER message', () => {
    // "again" after "again" is two messages, and the last one here is the
    // assistant's: the transcript has not absorbed this turn's prompt yet.
    expect(pendingPromptText({ sticky: SENT, lastMessage: { role: 'assistant', content: SENT } })).toBe(SENT);
  });

  it('draws nothing when no turn is in flight', () => {
    expect(pendingPromptText({ lastMessage: { role: 'user', content: SENT } })).toBeUndefined();
  });
});
