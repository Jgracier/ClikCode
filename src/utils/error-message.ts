export function toCliErrorMessage(error: unknown): string {
  // Platform unreachable (origin down / Cloudflare 5xx / connection reset) — almost
  // always a transient deploy/restart window. Give a clear, actionable message instead
  // of a raw axios/stack error.
  const probe = error as { response?: { status?: number }; code?: string } | null;
  const status = Number(probe?.response?.status || 0);
  const code = String(probe?.code || "").toUpperCase();
  if (
    status === 502 || status === 503 || status === 504 ||
    (status >= 520 && status <= 526) ||
    code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" ||
    code === "ECONNABORTED" || code === "EPIPE" || code === "EAI_AGAIN"
  ) {
    return "ClikDeploy is temporarily unavailable (it may be deploying or restarting). Please retry in a few minutes.";
  }
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
