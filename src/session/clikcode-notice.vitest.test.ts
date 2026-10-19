import { expect, it } from 'vitest';
import { isClikCodeNotice } from './clikcode-notice.js';

it("treats Claude's post-compaction summary hand-back as the model's input, never a prompt the user wrote", () => {
  expect(isClikCodeNotice('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Goal')).toBe(true);
  expect(isClikCodeNotice('This session is being discussed in the review tomorrow')).toBe(false);
});
