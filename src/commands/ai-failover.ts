export type AccountFailureKind = 'quota-exhausted' | 'temporarily-throttled' | 'authentication-required' | 'other';

/** Classify only signals strong enough to justify changing credentials. */
export function classifyAccountFailure(error: unknown): AccountFailureKind {
  const status = (error as { statusCode?: unknown; response?: { status?: unknown } } | null)?.statusCode
    ?? (error as { response?: { status?: unknown } } | null)?.response?.status;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403 || /(?:not authenticated|authentication required|login required|unauthorized)/i.test(message)) return 'authentication-required';
  if (status === 402 || /(?:quota (?:exceeded|exhausted)|(?:usage|session|plan|weekly|monthly|daily) limit(?: reached)?|you(?:'ve| have) hit your limit|credits? exhausted)/i.test(message)) return 'quota-exhausted';
  if (status === 429 || /(?:rate limit|too many requests|temporar(?:y|ily) throttled)/i.test(message)) return 'temporarily-throttled';
  return 'other';
}

/** Rehydrate a new vendor-native session after switching account profiles. */
export function failoverPrompt(
  messages: readonly { role: 'user' | 'assistant'; content: string }[],
  currentPrompt: string,
): string {
  const transcript = messages
    .map((message) => `<message role="${message.role}">\n${message.content}\n</message>`)
    .join('\n');
  return `Continue the same ClikCode conversation after an account failover. Preserve all prior decisions, files, and task state. Do not repeat completed work.\n\n<conversation>\n${transcript}\n</conversation>\n\n<current_request>\n${currentPrompt}\n</current_request>`;
}
