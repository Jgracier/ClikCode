export type AccountFailureKind = 'quota-exhausted' | 'temporarily-throttled' | 'authentication-required' | 'native-thread-invalid' | 'other';

/** Classify only signals strong enough to justify changing credentials. */
export function classifyAccountFailure(error: unknown): AccountFailureKind {
  const status = (error as { statusCode?: unknown; response?: { status?: unknown } } | null)?.statusCode
    ?? (error as { response?: { status?: unknown } } | null)?.response?.status;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403 || /(?:not authenticated|authentication required|login required|unauthorized)/i.test(message)) return 'authentication-required';
  if (status === 402 || /(?:quota (?:exceeded|exhausted)|(?:usage|session|plan|weekly|monthly|daily) limit(?: reached)?|you(?:'ve| have) hit your limit|credits? exhausted)/i.test(message)) return 'quota-exhausted';
  if (status === 429 || /(?:rate limit|too many requests|temporar(?:y|ily) throttled)/i.test(message)) return 'temporarily-throttled';
  // Confirmed verbatim from a real, reproduced Codex error: "thread/resume:
  // thread/resume failed: no rollout found for thread id ...". A stale
  // nativeSessionId (the account it was created under no longer matches the
  // session's current account -- switching accounts within the same
  // provider used to leave it untouched) is recoverable, not fatal: clear
  // it and let the existing failoverPrompt rehydration path start a fresh
  // thread from the real stored transcript instead of surfacing this raw
  // vendor error. Only Codex's exact confirmed wording is matched here --
  // no other vendor's equivalent phrasing has been verified, so none is
  // guessed at.
  if (/no rollout found/i.test(message)) return 'native-thread-invalid';
  return 'other';
}

/**
 * Caps how much prior transcript gets replayed into a fresh native thread.
 * Uncapped replay grows every prompt's cost and context-window usage in lockstep
 * with total conversation length, on every provider/account switch — bounding it
 * to the most recent exchanges keeps switching cheap regardless of how long the
 * conversation has run.
 */
const MAX_REPLAY_MESSAGES = 40;

/** Rehydrate a new vendor-native session after switching account profiles or providers. */
export function failoverPrompt(
  messages: readonly { role: 'user' | 'assistant'; content: string }[],
  currentPrompt: string,
): string {
  const recent = messages.slice(-MAX_REPLAY_MESSAGES);
  const transcript = recent
    .map((message) => `<message role="${message.role}">\n${message.content}\n</message>`)
    .join('\n');
  const omitted = messages.length - recent.length;
  const note = omitted > 0 ? `\n\n(${omitted} earlier message${omitted === 1 ? '' : 's'} omitted for brevity.)` : '';
  return `Continue the same ClikCode conversation after an account or provider failover. Preserve all prior decisions, files, and task state. Do not repeat completed work.\n\n<conversation>${note}\n${transcript}\n</conversation>\n\n<current_request>\n${currentPrompt}\n</current_request>`;
}
