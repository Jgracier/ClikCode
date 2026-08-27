import { describe, expect, it } from 'vitest';
import { APICallError } from 'ai';
import {
  isPermanentAiCallFailure,
  isRequestTooLargeFailure,
  parseNamedTokenLimit,
} from './ai-provider-models';

/** The refusal groq actually sent, verbatim, on 2026-08-26 at 17:35. */
const GROQ_TPM_REFUSAL =
  'Request too large for model `qwen/qwen3.8-27b` in organization `org_01jbdj077zf9ybjgcx3n5s715f` ' +
  'service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 10911, ' +
  'please reduce your message size and try again.';

const apiError = (init: {
  message: string;
  statusCode?: number;
  responseBody?: string;
  isRetryable?: boolean;
}) =>
  new APICallError({
    message: init.message,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    requestBodyValues: {},
    statusCode: init.statusCode ?? 413,
    responseHeaders: {},
    responseBody: init.responseBody,
    isRetryable: init.isRetryable ?? false,
  });

describe('isRequestTooLargeFailure', () => {
  it('recognises the refusal that cooled two healthy models for 24 hours', () => {
    expect(isRequestTooLargeFailure(apiError({ message: GROQ_TPM_REFUSAL }))).toBe(true);
  });

  it('overrides the permanent classification that caused the lockout', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. 413 is neither 429 nor 5xx, so the AI
    // SDK marks it non-retryable and isPermanentAiCallFailure agrees — which is
    // correct for a dead credential and catastrophic for "your prompt was big".
    // Both must stay true of the same error; the CALLER checks this one first.
    const error = apiError({ message: GROQ_TPM_REFUSAL });
    expect(isPermanentAiCallFailure(error)).toBe(true);
    expect(isRequestTooLargeFailure(error)).toBe(true);
  });

  it('reads the explanation out of the BODY when the message is generic', () => {
    // Most providers return 400 with the real reason only in the body.
    expect(
      isRequestTooLargeFailure(
        apiError({
          message: 'Bad Request',
          statusCode: 400,
          responseBody: '{"error":{"code":"context_length_exceeded"}}',
        }),
      ),
    ).toBe(true);
  });

  it('treats a bare 413 as a size refusal whatever it says', () => {
    expect(isRequestTooLargeFailure(apiError({ message: 'nope', statusCode: 413 }))).toBe(true);
  });

  it('does NOT fire on the failures that genuinely are the model’s fault', () => {
    // A renamed id, a dead key and a revoked entitlement must keep their real
    // cooldowns — widening this predicate would stop the router excluding
    // anything at all.
    for (const status of [401, 402, 403, 404]) {
      const error = apiError({ message: 'Unauthorized', statusCode: status });
      expect(isRequestTooLargeFailure(error), `status ${status}`).toBe(false);
      expect(isPermanentAiCallFailure(error), `status ${status}`).toBe(true);
    }
  });

  it('ignores anything that is not an APICallError', () => {
    expect(isRequestTooLargeFailure(new Error('request too large'))).toBe(false);
    expect(isRequestTooLargeFailure(null)).toBe(false);
  });
});

describe('parseNamedTokenLimit', () => {
  it('learns the ceiling the vendor stated in the refusal', () => {
    // The provider names the exact number the router needs. One refusal is then
    // enough to stop over-budget requests reaching it again.
    expect(parseNamedTokenLimit(apiError({ message: GROQ_TPM_REFUSAL }))).toBe(8000);
  });

  it('handles a thousands-separated limit', () => {
    expect(
      parseNamedTokenLimit(apiError({ message: 'on tokens per minute (TPM): Limit 200,000' })),
    ).toBe(200_000);
  });

  it('returns null rather than guessing when no limit is named', () => {
    // A guessed ceiling would exclude a provider that never published one — the
    // opposite of the defect this whole path exists to fix.
    expect(parseNamedTokenLimit(apiError({ message: 'Request too large.' }))).toBeNull();
    expect(parseNamedTokenLimit(apiError({ message: 'Limit exceeded' }))).toBeNull();
  });
});
