import { expect, it } from 'vitest';
import { isClikCodeNotice } from './clikcode-notice.js';

it("treats Claude's post-compaction summary hand-back as the model's input, never a prompt the user wrote", () => {
  expect(isClikCodeNotice('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Goal')).toBe(true);
  expect(isClikCodeNotice('This session is being discussed in the review tomorrow')).toBe(false);
});

it('knows the notices of handed-off work and of ClikCode\'s own background agents', () => {
  expect(isClikCodeNotice("[background agent a1 was cut off: You've hit your session limit · resets 7:50am] Open B5\nStart it again here")).toBe(true);
  expect(isClikCodeNotice('[background command 4123 finished] npm test\nTests 12 passed')).toBe(true);
  expect(isClikCodeNotice('[background agent 7 finished] review the diff\nLooks good')).toBe(true);
  expect(isClikCodeNotice('[background agent] what is this')).toBe(false);
});
