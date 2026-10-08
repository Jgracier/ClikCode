import { describe, expect, it } from 'vitest';
import { accountFailureReason, accountVerification, verificationNotice, accountSwitchNotice, classifyAccountFailure, quotaRetryHint } from './failover';
import { transferPrompt } from './transfer.js';
import { canonicalRecord } from '../session/canonical.js';
import type { HarnessSession } from '../session/model.js';

const failoverPrompt = (messages: HarnessSession['messages'], request: string, maxBytes?: number): string =>
  transferPrompt(canonicalRecord({ id: 's', messages } as HarnessSession), request, maxBytes ? { maxBytes } : {});

describe('ClikCode account failover', () => {
  it('does not confuse temporary throttling with exhausted quota', () => {
    expect(classifyAccountFailure(Object.assign(new Error('too many requests'), { statusCode: 429 }))).toBe('temporarily-throttled');
    expect(classifyAccountFailure(new Error('weekly usage limit reached'))).toBe('quota-exhausted');
    expect(classifyAccountFailure(new Error("You've hit your limit · resets tomorrow"))).toBe('quota-exhausted');
    expect(classifyAccountFailure(new Error("You've hit your usage limit. Upgrade to Pro or try again at 12:12 PM."))).toBe('quota-exhausted');
    // The model is full. Another account is refused the same way, so this is not a switch.
    expect(classifyAccountFailure(new Error('Selected model is at capacity. Please try a different model.'))).toBe('other');
    expect(classifyAccountFailure(Object.assign(new Error('payment required'), { statusCode: 402 }))).toBe('quota-exhausted');
    expect(classifyAccountFailure(new Error('Rate limited: API error (status 429 Too Many Requests): subscription:free-usage-exhausted'), { isResultError: true }))
      .toBe('quota-exhausted');
    expect(classifyAccountFailure(new Error('Rate limited: API error (status 429 Too Many Requests): subscription:free-usage-exhausted'), {
      isResultError: true, errorKind: 'rate_limit_error',
    })).toBe('quota-exhausted');
  });

  it('classifies authentication separately', () => {
    expect(classifyAccountFailure(Object.assign(new Error('unauthorized'), { statusCode: 401 }))).toBe('authentication-required');
  });

  it('classifies Qwen Code\'s own wording for a missing/unselected credential as auth-required', () => {
    // Confirmed verbatim from a real unhandledRejection on this machine:
    // "Qwen Code: No auth type is selected. Please configure an auth type
    // (e.g. via settings or `--auth-type`) before running in
    // non-interactive mode."
    expect(classifyAccountFailure(
      new Error('Qwen Code: No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode.'),
      { isResultError: true },
    )).toBe('authentication-required');
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

  it('keeps every request but retells only what fits, condensing older answers', () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: index % 2 === 0 ? `request-${index}` : `answer-${index} begins here. ${'Then a middle step. '.repeat(100)}answer-${index} ends here.`,
    }));
    const prompt = failoverPrompt(messages, 'continue', 16 * 1024);
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(16 * 1024);
    for (let index = 0; index < 60; index += 2) expect(prompt).toContain(`${index / 2 + 1}. request-${index}`);
    // The newest answer whole, older ones by their first and last sentences.
    expect(prompt).toContain(messages[59]!.content);
    expect(prompt).toContain('answer-41 begins here. … answer-41 ends here.');
    expect(prompt).not.toContain('Then a middle step. Then a middle step. Then a middle step. answer-41');
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
    expect(classifyAccountFailure(new Error('Authentication required: 403 Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code.'))).toBe('account-ineligible');
    expect(classifyAccountFailure(new Error('This client is no longer supported for Gemini Code Assist for individuals.'))).toBe('account-ineligible');
  });

  it('still recognizes a separate real quota or auth signal', () => {
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
    // Confirmed from command-code@1.62.1's own installed dist: the status
    // label constant SPEND_LIMIT_REACHED is literally "Spend limit reached".
    ['command', 'Spend limit reached'],
    // Confirmed in cursor-agent 2026.09.26 ActionRequiredError action map.
    ['cursor', 'Upgrade your plan to continue'],
    ['cursor-account', 'Upgrade your account to continue'],
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

const accountVerificationHint = (error: unknown): string | undefined => {
  const verification = accountVerification(error);
  return verification ? verificationNotice(verification) : undefined;
};

describe('the verification notice for an ineligible account', () => {
  it('surfaces the vendor verification link for an ineligible account', () => {
    const error = Object.assign(new Error('exit 1'), {
      stderrTail: 'Eligibility check failed: Verify your account to continue.\nhttps://accounts.google.com/signin/continue?sarp=1&x=2\n',
    });
    expect(accountVerificationHint(error)).toBe('Google needs verification: https://accounts.google.com/signin/continue?sarp=1&x=2');
  });
  it('is silent for other failures', () => {
    expect(accountVerificationHint(new Error('RESOURCE_EXHAUSTED quota reached'))).toBeUndefined();
  });
  it('extracts a non-Google verification link too, not just accounts.google.com', () => {
    const error = Object.assign(new Error('exit 1'), {
      stderrTail: 'Eligibility check failed: Verify your account to continue.\nhttps://vendor.example.com/verify?token=abc\n',
    });
    expect(accountVerificationHint(error)).toBe('Verification needed: https://vendor.example.com/verify?token=abc');
  });
  it('prefers the accounts.google.com link when multiple URLs are present', () => {
    const error = Object.assign(new Error('exit 1'), {
      stderrTail: 'Eligibility check failed: Verify your account to continue.\nSee https://example.com/help first, then https://accounts.google.com/signin/continue?sarp=1&x=2\n',
    });
    expect(accountVerificationHint(error)).toBe('Google needs verification: https://accounts.google.com/signin/continue?sarp=1&x=2');
  });
});

describe('credit refusals, verbatim', () => {
  it('reads a spent credit balance as quota, whatever the vendor calls it', () => {
    // Kilo Code CLI, stderr with its colour codes.
    expect(classifyAccountFailure(Object.assign(new Error('kilo exited 1'), { stderrTail: '\u001b[91m\u001b[1mError: \u001b[0mAdd credits to continue, or switch to a free model' }))).toBe('quota-exhausted');
    // Command Code 1.65.2.
    expect(classifyAccountFailure(Object.assign(new Error('cmdc exited 10'), { stderrTail: 'Error: Insufficient credits for Command Code.' }))).toBe('quota-exhausted');
  });
});

describe('when a quota refusal says it ends', () => {
  const now = Date.parse('2026-09-27T15:00:00.000Z');
  const at = (ms: number) => new Date(now + ms).toISOString();
  it("reads Antigravity's 'Resets in' duration", () => {
    const refusal = Object.assign(new Error('failed'), { stderrTail: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 76h57m39s.' });
    expect(quotaRetryHint(refusal, now)).toBe(at(((76 * 60 + 57) * 60 + 39) * 1000));
  });
  it('reads spelled-out units and retry-after seconds', () => {
    expect(quotaRetryHint(new Error("You've hit your usage limit. Try again in 2 days 3 hours 5 minutes."), now)).toBe(at(((2 * 24 + 3) * 60 + 5) * 60_000));
    // Grok Free, 2026-10-06.
    expect(quotaRetryHint(new Error("Rate limited: API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.7 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 603117/500000"), now)).toBe(at(24 * 3_600_000));
    expect(quotaRetryHint(new Error('quota exceeded, retry after 3600 seconds'), now)).toBe(at(3_600_000));
  });
  it("reads Codex's wall-clock time as its next occurrence, here", () => {
    // Captured from a real refusal (2026-10-05).
    const codex = (time: string) => new Error(`You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${time}.`);
    const local = (hours: number, minutes: number, dayOffset = 0) => {
      const at = new Date(now); at.setSeconds(0, 0); at.setHours(hours, minutes); at.setDate(at.getDate() + dayOffset); return at.toISOString();
    };
    const later = new Date(now + 2 * 3_600_000);
    const earlier = new Date(now - 2 * 3_600_000);
    const twelve = (date: Date) => `${(date.getHours() % 12) || 12}:${String(date.getMinutes()).padStart(2, '0')} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
    expect(quotaRetryHint(codex(twelve(later)), now)).toBe(local(later.getHours(), later.getMinutes(), later.getDate() === new Date(now).getDate() ? 0 : 1));
    // Already past today: tomorrow, never a time behind us.
    expect(Date.parse(quotaRetryHint(codex(twelve(earlier)), now)!)).toBeGreaterThan(now);
    expect(Date.parse(quotaRetryHint(codex(twelve(earlier)), now)!) - now).toBeLessThan(24 * 3_600_000);
    expect(quotaRetryHint(new Error('try again at 25:99'), now)).toBeUndefined();
  });

  it('reads a dated wall-clock time on that date', () => {
    const at = Date.parse(quotaRetryHint(new Error('try again at Oct 7th, 2026 9:00 AM'), now)!);
    const expected = new Date(2026, 9, 7, 9, 0, 0, 0).getTime();
    expect(at).toBe(expected);
  });

  it('says nothing for a refusal with no duration or a bare hour', () => {
    expect(quotaRetryHint(new Error('You have exceeded your monthly quota'), now)).toBeUndefined();
    expect(quotaRetryHint(new Error('usage limit reached, resets 8pm'), now)).toBeUndefined();
  });
});

describe('a limit named is not a limit reached', () => {
  it.each([
    'You have used 80% of your weekly limit.',
    'Error: exceeded the session limit of 200 tool calls',
    'The plan limit for file uploads is 10MB',
    'context window exceeded: usage limit of 200000 tokens',
  ])('does not read "%s" as spent usage', (text) => {
    expect(classifyAccountFailure(new Error(text), { isResultError: true })).not.toBe('quota-exhausted');
  });

  it('reads a refusal that also mentions signing in or expiry as spent usage', () => {
    expect(classifyAccountFailure(new Error('Your free trial has expired'), { isResultError: true })).toBe('quota-exhausted');
    expect(classifyAccountFailure(new Error('Quota exceeded for this model. Please sign in to Google AI Studio to continue.'), { isResultError: true })).toBe('quota-exhausted');
  });

  it('reads a 429 written into the vendor text as it reads a 401 or 402 there', () => {
    expect(classifyAccountFailure(new Error('API error (status 429): slow down'), { isResultError: true })).toBe('temporarily-throttled');
  });
});
