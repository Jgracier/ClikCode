import { describe, expect, it } from 'vitest';
import { deferredWorkReply } from './deferred-work.js';

const IRREDUCIBLE_AUDIT = 'Please do an audit of clikcode current state and tell me if we are at an irreducible minimum for the complexity, and fix anything that is not';

describe('deferred implementation replies', () => {
  it.each([
    ['Complete it', 'It is not complete. I can do the next concrete step right away.'],
    ['I said fully complete it', 'Here is the list. We can do them in order, and I\'ll proceed from the first one.'],
    ['Please fix the bug', 'If you want, I can implement the fix next.'],
    ['ok please ensure it\'s fully completed. get it done', 'If you want, I can continue with the next step.'],
    ['fix the race in the lock file', 'I can fix the race in the lock file if you want.'],
    ['complete it', 'Here is the plan; I can implement it next.'],
    ['implement the retry logic', 'The retry logic is not implemented yet. If you want, I can implement it now.'],
    ['finish the migration', 'What remains to be done: three tables. I can do that next.'],
  ])('re-drives %j answered with %j', (request, reply) => {
    expect(deferredWorkReply(request, reply)).toBe(true);
  });

  it.each([
    // Finished, then offers an optional extra.
    ['fix the failing parser test', 'Fixed the off-by-one in the tokenizer; all 42 tests pass. If you want, I can also add a regression test next.'],
    ['implement the retry logic', 'Implemented exponential backoff in client.ts. If you want, I can do the same for the websocket path.'],
    ['fix the bug', 'Fixed. I\'ll proceed from here only if you confirm.'],
    ['Complete it', 'Implemented and tested the fix.'],
    ['Complete it', 'Pushed to main; tests pass. I can do the docs next if you want.'],
    // Blocked or honest status.
    ['Complete it', 'Blocked: the vendor account rejected authentication.'],
    ['Complete it', 'Done. The paid test is not complete because the account has no funds; what remains is that test.'],
    // Questions and report requests are answered by a report.
    ['How much did we get done?', 'If you want, I can do the rest next.'],
    [IRREDUCIBLE_AUDIT, 'The audit found two removals. If you want, I can implement them next.'],
    ['Please do an audit of the code and tell me if we are at an irreducible minimum', 'The audit is complete. If you want, I can implement the two removals next.'],
    ['Please do a review of the diff', 'If you want, I can fix these next.'],
    ['get me the status', 'If you want, I can do that next.'],
    ['explain the lock protocol', 'If you want, I can implement a simpler one next.'],
    ['why does the build fail', 'If you want, I can fix it now.'],
    ['fix it?', 'I can fix it if you want.'],
    // Not a work order at all.
    ['thanks', 'If you want, I can do more next.'],
  ])('accepts %j answered with %j', (request, reply) => {
    expect(deferredWorkReply(request, reply)).toBe(false);
  });
});
