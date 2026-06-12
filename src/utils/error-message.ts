export function toCliErrorMessage(error: unknown): string {
  const httpErr = error as { response?: { data?: { error?: unknown; message?: unknown } }; message?: string } | null;
  const raw =
    httpErr?.response?.data?.error ??
    httpErr?.response?.data?.message ??
    (error instanceof Error ? error.message : null) ??
    'Unknown error';

  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const nested = (raw as Record<string, unknown>).message || (raw as Record<string, unknown>).error || (raw as Record<string, unknown>).code;
    if (typeof nested === 'string' && nested.trim()) return nested;
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}
