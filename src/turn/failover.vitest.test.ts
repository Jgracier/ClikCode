import { describe, expect, it } from 'vitest';
import { accountFailureReason, accountVerificationHint, accountSwitchNotice, accountSwitchPhase, classifyAccountFailure, failoverPrompt, usageLabelIsExhausted, usageLabelRemainingPercent } from './failover';

describe('ClikCode account failover', () => {
  it('does not confuse temporary throttling with exhausted quota', () => {
    expect(classifyAccountFailure(Object.assign(new Error('too many requests'), { statusCode: 429 }))).toBe('temporarily-throttled');
    expect(classifyAccountFailure(new Error('weekly usage limit reached'))).toBe('quota-exhausted');
    expect(classifyAccountFailure(new Error("You've hit your limit · resets tomorrow"))).toBe('quota-exhausted');
    expect(classifyAccountFailure(Object.assign(new Error('payment required'), { statusCode: 402 }))).toBe('quota-exhausted');
  });

  it('classifies authentication separately', () => {
    expect(classifyAccountFailure(Object.assign(new Error('unauthorized'), { statusCode: 401 }))).toBe('authentication-required');
  });

  it('routes around accounts whose live usage window is exhausted', () => {
    expect(usageLabelIsExhausted('5h 0% left · weekly 69% left')).toBe(true);
    expect(usageLabelIsExhausted('5h 58% left · weekly 0% left')).toBe(true);
    expect(usageLabelIsExhausted('5h 0.1% left · weekly 69% left')).toBe(false);
    expect(usageLabelIsExhausted('usage unavailable')).toBe(false);
    expect(usageLabelRemainingPercent('5h 58% left · weekly 29% left')).toBe(29);
    expect(usageLabelRemainingPercent('5h 42% used · weekly 71% used')).toBe(29);
    expect(usageLabelRemainingPercent('12k tok · $0.02')).toBeUndefined();
  });

  it('rehydrates the complete canonical transcript and interrupted request', () => {
    const prompt = failoverPrompt([
      { role: 'user', content: 'rename the parser' },
      { role: 'assistant', content: 'renamed it and updated tests' },
    ], 'now run the focused test');
    expect(prompt).toContain('rename the parser');
    expect(prompt).toContain('renamed it and updated tests');
    expect(prompt).toContain('now run the focused test');
  });

  it('caps replay to the most recent messages instead of growing unbounded with conversation length', () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as const,
      content: `message-${index}`,
    }));
    const prompt = failoverPrompt(messages, 'continue');
    expect(prompt).not.toContain('message-0\n');
    expect(prompt).not.toContain('message-19\n');
    expect(prompt).toContain('message-20\n');
    expect(prompt).toContain('message-59');
    expect(prompt).toContain('20 earlier messages omitted for brevity');
  });
});

describe('a rejected request is not an account failure', () => {
  /**
   * Antigravity encodes reasoning effort in its MODEL ID
   * (gemini-3.8-flash-high, gpt-oss-120b-medium), so `--effort` alongside
   * `--model` is a contradiction it refuses. ClikCode declared --effort for it
   * anyway, so every antigravity turn was refused -- and because the refusal
   * was classified 'other', failover then walked all seven of the user's
   * accounts collecting the identical error, paying a 60-second
   * interactive-auth timeout on the one that was not signed in. It read as
   * "Antigravity is failing on all accounts".
   *
   * The wording below is verbatim from agy 1.2.7 against a real authenticated
   * account, not paraphrased.
   */
  it('classifies a vendor argv refusal as request-invalid', () => {
    expect(classifyAccountFailure(new Error(
      'invalid model selection (--model "claude-opus-4-6-thinking" --effort "medium"): --effort is not supported for model "claude-opus-4-6-thinking"',
    ), { isResultError: true })).toBe('request-invalid');
    expect(classifyAccountFailure(new Error(
      'invalid model selection (--model "gpt-oss-120b-medium" --effort "high"): --model gpt-oss-120b-medium conflicts with --effort=high',
    ), { isResultError: true })).toBe('request-invalid');
  });

  it('still prefers a real account signal when one is present', () => {
    // These can be worded as refusals too, and they ARE worth another account,
    // so request-invalid is matched last and must never shadow them.
    expect(classifyAccountFailure(new Error('authentication failed or timed out'), { isResultError: true }))
      .toBe('authentication-required');
    expect(classifyAccountFailure(new Error('usage balance exhausted'), { isResultError: true }))
      .toBe('quota-exhausted');
    expect(classifyAccountFailure(new Error('rate limit exceeded'), { isResultError: true }))
      .toBe('temporarily-throttled');
  });

  it('does not claim an unrelated crash is a bad request', () => {
    expect(classifyAccountFailure(new Error('segmentation fault'), { isResultError: true })).toBe('other');
  });

  it('never reads a refusal out of model prose', () => {
    // The trust rule the rest of this classifier follows: an assistant
    // explaining flag validation is not a vendor rejecting argv.
    expect(classifyAccountFailure(
      new Error('Here is how "invalid model selection" errors work: the CLI conflicts with --effort when...'),
      { isResultError: false },
    )).toBe('other');
  });
});

describe('an ineligible account is named as such, not as a generic failure', () => {
  /**
   * Verbatim from agy 1.2.7 on a token that had just refreshed successfully,
   * so this is not an auth problem and signing in again cannot fix it. It
   * matched none of the existing patterns, classified as 'other', and the
   * user was told "account failed" -- true, useless, and indistinguishable
   * from a crash.
   */
  const ELIGIBILITY = 'Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue.';

  it('classifies the vendor eligibility refusal', () => {
    expect(classifyAccountFailure(new Error(ELIGIBILITY), { isResultError: true })).toBe('account-ineligible');
  });

  it('still prefers a real quota or auth signal over it', () => {
    // These can mention verification too; the account-level signals win.
    expect(classifyAccountFailure(new Error('usage balance exhausted'), { isResultError: true })).toBe('quota-exhausted');
    expect(classifyAccountFailure(new Error('oauth token has expired'), { isResultError: true })).toBe('authentication-required');
  });

  it('gives every failure kind a reason worth showing', () => {
    expect(accountFailureReason('quota-exhausted')).toBe('usage exhausted');
    expect(accountFailureReason('account-ineligible')).toBe('account not eligible');
    expect(accountFailureReason('authentication-required')).toBe('sign-in needed');
    expect(accountFailureReason('temporarily-throttled')).toBe('rate limited');
    expect(accountFailureReason('other')).toBe('account failed');
  });

  it('does not read an eligibility refusal out of model prose', () => {
    expect(classifyAccountFailure(
      new Error('Let me explain: "not eligible" errors happen when your account needs verification.'),
      { isResultError: false },
    )).toBe('other');
  });
});

describe('one wording for an account switch, wherever it happens', () => {
  // Four switch sites -- native and api-key, each with a pre-turn check and a
  // reactive one -- had each written this line for itself, and they had
  // drifted into two wordings for the same event: the pre-turn pair said
  // "quota exhausted … switching to X", the reactive pair "<reason> …
  // retrying…". Running out of usage is not a retry.
  it('says running out plainly, and calls it a switch rather than a retry', () => {
    expect(accountSwitchNotice('quota-exhausted', 'work@example.com'))
      .toBe('out of usage, switching to work@example.com');
  });

  it('never calls a switch a retry, for any failure kind', () => {
    const kinds = ['quota-exhausted', 'temporarily-throttled', 'authentication-required',
      'account-ineligible', 'native-thread-invalid', 'other'] as const;
    for (const kind of kinds) {
      const notice = accountSwitchNotice(kind, 'acct-b');
      expect(notice, kind).toContain('switching to acct-b');
      expect(notice, kind).not.toMatch(/retry|retrying/i);
    }
  });

  it('still names the real reason when it is not usage', () => {
    expect(accountSwitchNotice('temporarily-throttled', 'acct-b')).toBe('rate limited, switching to acct-b');
    expect(accountSwitchNotice('authentication-required', 'acct-b')).toBe('sign-in needed, switching to acct-b');
  });

  it('phrases the status line as a switch too', () => {
    expect(accountSwitchPhase('acct-b')).toBe('switching to acct-b');
  });
});

describe('classifying what a vendor actually says when it runs out', () => {
  // Every string here was captured from a real refusal on a real account.
  // Both of the first two were classified 'other' and shown as "account
  // failed … retrying", which is how a spent plan came to read like a crash:
  // the pattern wanted "quota exceeded" while antigravity writes "quota
  // reached" and copilot puts the verb BEFORE the noun.
  const quota = [
    ['antigravity', 'API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 76h57m39s.'],
    ['copilot', 'You have exceeded your monthly quota'],
    ['auggie', 'You have run out of usage for this month'],
    ['grok', 'API error (status 402 Payment Required): usage balance exhausted'],
  ] as const;

  it.each(quota)('reads %s running out as usage exhausted', (_vendor, text) => {
    const kind = classifyAccountFailure(new Error(text), { isResultError: true });
    expect(kind).toBe('quota-exhausted');
    expect(accountFailureReason(kind)).toBe('usage exhausted');
  });

  it('still separates a transient throttle from a spent plan', () => {
    // A 429 alone is not "out of usage" -- it comes back in seconds. Only the
    // quota wording promotes it, which is why antigravity's 429 counts and a
    // bare rate limit does not.
    for (const text of ['rate limit exceeded, please retry', 'Error: 429 Too Many Requests']) {
      expect(classifyAccountFailure(new Error(text), { isResultError: true })).toBe('temporarily-throttled');
    }
  });

  it('does not call an ordinary crash a spent plan', () => {
    // Saying it ran out when it did not would invent a reason, and would mark
    // a perfectly good account exhausted.
    expect(classifyAccountFailure(new Error('Error: spawn ENOENT'), { isResultError: true })).toBe('other');
  });
});

describe('accountVerificationHint', () => {
  it('surfaces the vendor verification link for an ineligible account', () => {
    const error = Object.assign(new Error('exit 1'), {
      stderrTail: 'Eligibility check failed: Verify your account to continue.\nhttps://accounts.google.com/signin/continue?sarp=1&x=2\n',
    });
    expect(accountVerificationHint('a@b.com', error)).toBe('a@b.com needs verifying with Google before it can be used: https://accounts.google.com/signin/continue?sarp=1&x=2');
  });
  it('is silent for other failures', () => {
    expect(accountVerificationHint('a@b.com', new Error('RESOURCE_EXHAUSTED quota reached'))).toBeUndefined();
  });
});
