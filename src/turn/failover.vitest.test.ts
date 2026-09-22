import { describe, expect, it } from 'vitest';
import { classifyAccountFailure, failoverPrompt, usageLabelIsExhausted, usageLabelRemainingPercent } from './failover';

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
