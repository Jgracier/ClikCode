/**
 * The reason in a Gateway error body: the /v1 envelope nests it (`{ error: { message } }`), older
 * routes send it bare (`{ error: "..." }`). Undefined when neither is there.
 */
export function gatewayErrorMessage(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === 'string') return error;
  const nested = (error as { message?: unknown } | null | undefined)?.message;
  return typeof nested === 'string' && nested ? nested : undefined;
}
