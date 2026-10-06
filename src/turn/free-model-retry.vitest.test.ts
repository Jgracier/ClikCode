import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { freeModelAfterCreditRefusal } from './vendor-turn';

// cline 2.x, 2026-10-06: on all 12 accounts with a negative balance,
// ~anthropic/claude-opus-latest answered this while the default
// apodex/apodex-1.1-mini:free answered "OK".
const REFUSAL = new Error('Internal error: Insufficient balance. Your Cline Credits balance is $-0.20');
const LISTED = ['apodex/apodex-1.1-mini:free', 'openai/gpt-6.1-sol', 'qwen/qwen3.8-27b:free'];

describe('a paid model refused for spent credits', () => {
  const cline = localHarnessForCommand('cline')!;
  it('goes on, on the same account, with the first free model the vendor lists', () => {
    expect(freeModelAfterCreditRefusal(cline, '~anthropic/claude-opus-latest', REFUSAL, LISTED)).toBe('apodex/apodex-1.1-mini:free');
  });
  it('is not a free model\'s own refusal, nor any other failure, nor a harness without free models', () => {
    expect(freeModelAfterCreditRefusal(cline, 'qwen/qwen3.8-27b:free', REFUSAL, LISTED)).toBeUndefined();
    expect(freeModelAfterCreditRefusal(cline, '~anthropic/claude-opus-latest', new Error('Rate limited'), LISTED)).toBeUndefined();
    expect(freeModelAfterCreditRefusal(cline, '~anthropic/claude-opus-latest', REFUSAL, ['openai/gpt-6.1-sol'])).toBeUndefined();
    expect(freeModelAfterCreditRefusal(localHarnessForCommand('opencode')!, 'x', REFUSAL, LISTED)).toBeUndefined();
  });
  // kilo, 2026-10-06: ClikCode's model (the first listed,
  // kilo/aion-labs/aion-2.0) answered this; Kilo's :free models need no credits.
  it('on Kilo too, in its own words', () => {
    const kilo = localHarnessForCommand('kilo')!;
    const refusal = new Error('Internal error: Add credits to continue, or switch to a free model');
    expect(freeModelAfterCreditRefusal(kilo, 'kilo/aion-labs/aion-2.0', refusal, ['kilo/aion-labs/aion-2.0', 'kilo/cohere/north-mini-code:free'])).toBe('kilo/cohere/north-mini-code:free');
  });
});
