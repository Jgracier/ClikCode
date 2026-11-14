import { describe, expect, it } from 'vitest';
import { withoutReplyNotice } from './reply-notice.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';

describe('a vendor notice at the start of a reply', () => {
  const copilot = localHarnessForCommand('copilot')!;
  it('is taken off the answer it was glued to', () => {
    // As Copilot sent it, in a GitHub repository it had not indexed yet.
    expect(withoutReplyNotice(copilot, 'Info: Remote index: queued Jgracier/ClikCode for indexingPONG')).toBe('PONG');
    expect(withoutReplyNotice(copilot, 'Info: Remote index: queued a/b for indexing\nHere is the plan.')).toBe('Here is the plan.');
  });
  it('leaves an answer without one, or that only mentions it later, alone', () => {
    expect(withoutReplyNotice(copilot, 'PONG')).toBeUndefined();
    expect(withoutReplyNotice(copilot, 'It said Info: Remote index: queued a/b for indexing')).toBeUndefined();
    expect(withoutReplyNotice({}, 'Info: Remote index: queued a/b for indexingPONG')).toBeUndefined();
  });
});
