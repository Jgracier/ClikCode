import { describe, expect, it } from 'vitest';
import { classifyAccountFailure, failoverPrompt } from './ai-failover';

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

  it('rehydrates the complete canonical transcript and interrupted request', () => {
    const prompt = failoverPrompt([
      { role: 'user', content: 'rename the parser' },
      { role: 'assistant', content: 'renamed it and updated tests' },
    ], 'now run the focused test');
    expect(prompt).toContain('rename the parser');
    expect(prompt).toContain('renamed it and updated tests');
    expect(prompt).toContain('now run the focused test');
  });
});
