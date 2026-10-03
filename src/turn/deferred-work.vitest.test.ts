import { describe, expect, it } from 'vitest';
import { deferredWorkReply } from './deferred-work.js';

describe('deferred implementation replies', () => {
  it('continues work orders answered with an offer to do the work later', () => {
    expect(deferredWorkReply('Complete it', 'It is not complete. I can do the next concrete step right away.')).toBe(true);
    expect(deferredWorkReply('I said fully complete it', 'Here is the list. We can do them in order, and I\'ll proceed from the first one.')).toBe(true);
    expect(deferredWorkReply('Please fix the bug', 'If you want, I can implement the fix next.')).toBe(true);
    expect(deferredWorkReply('ok please ensure it\'s fully completed. get it done', 'If you want, I can continue with the next step.')).toBe(true);
  });

  it('never treats a question, audit or report request as a work order', () => {
    expect(deferredWorkReply('How much did we get done?', 'If you want, I can do the rest next.')).toBe(false);
    expect(deferredWorkReply('Please do an audit of the code and tell me if we are at an irreducible minimum',
      'The audit is complete. If you want, I can implement the two removals next.')).toBe(false);
    expect(deferredWorkReply('Please do a review of the diff', 'If you want, I can fix these next.')).toBe(false);
    expect(deferredWorkReply('get me the status', 'If you want, I can do that next.')).toBe(false);
  });

  it('accepts honest finished or blocked answers that mention remaining work', () => {
    expect(deferredWorkReply('Complete it', 'Implemented and tested the fix.')).toBe(false);
    expect(deferredWorkReply('Complete it', 'Blocked: the vendor account rejected authentication.')).toBe(false);
    expect(deferredWorkReply('Complete it', 'Done. The paid test is not complete because the account has no funds; what remains is that test.')).toBe(false);
  });
});
