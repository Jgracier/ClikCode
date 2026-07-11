/**
 * Extract a correlation/trace id from an error, if the API returned one.
 *
 * Sources, in priority order:
 *  1. `error.traceId` — attached by the ApiClient response interceptor.
 *  2. RFC7807 problem+json body field `traceId` (or `trace_id`).
 *  3. The `x-request-id` response header we echoed on the request.
 */
export function extractTraceId(error: unknown): string | undefined {
  const e = error as
    | {
        traceId?: unknown;
        response?: {
          data?: { traceId?: unknown; trace_id?: unknown } | unknown;
          headers?: Record<string, unknown>;
        };
      }
    | null;

  const direct = e?.traceId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const data = e?.response?.data as { traceId?: unknown; trace_id?: unknown } | undefined;
  const bodyTrace = data?.traceId ?? data?.trace_id;
  if (typeof bodyTrace === 'string' && bodyTrace.trim()) return bodyTrace.trim();

  const headers = e?.response?.headers;
  if (headers) {
    const headerTrace =
      (headers['x-request-id'] as unknown) ??
      (headers['X-Request-Id'] as unknown) ??
      (headers['x-trace-id'] as unknown);
    if (typeof headerTrace === 'string' && headerTrace.trim()) return headerTrace.trim();
  }

  return undefined;
}

/** Human-readable base message for an error (without the trace line). */
export function toCliErrorMessageBase(error: unknown): string {
  // Platform unreachable (origin down / Cloudflare 5xx / connection reset) — almost
  // always a transient deploy/restart window. Give a clear, actionable message instead
  // of a raw axios/undici/stack error.
  const probe = error as
    | { response?: { status?: number }; code?: string; message?: string; cause?: { code?: string; message?: string } }
    | null;
  const status = Number(probe?.response?.status || 0);
  // undici's fetch() throws `TypeError: fetch failed` with the real syscall code on
  // `.cause.code` (not `.code`) — inspect both so connection failures don't leak raw.
  const code = String(probe?.code || probe?.cause?.code || "").toUpperCase();
  const message = String(probe?.message || "");
  const isBareFetchFailure =
    /^fetch failed$/i.test(message.trim()) ||
    /\bfetch failed\b/i.test(message) ||
    /UND_ERR/i.test(code);
  if (
    status === 502 || status === 503 || status === 504 ||
    (status >= 520 && status <= 526) ||
    code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" ||
    code === "ECONNABORTED" || code === "EPIPE" || code === "EAI_AGAIN" ||
    code === "ENOTFOUND" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_SOCKET" ||
    isBareFetchFailure
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

/**
 * Friendly, user-facing error message. When the API handed back a correlation
 * id, ends with a `trace <id>` line the user can quote in support.
 */
export function toCliErrorMessage(error: unknown): string {
  const base = toCliErrorMessageBase(error);
  const traceId = extractTraceId(error);
  return traceId ? `${base}\ntrace ${traceId}` : base;
}

/**
 * Shared replacement for the byte-identical local `apiError()` helpers that used
 * to live in individual command files. Delegates to {@link toCliErrorMessage} so
 * every command surfaces the friendly fetch-failed mapping and a `trace <id>` line
 * instead of a raw `fetch failed` / `Request failed with status code 502`.
 */
export function apiErrorMessage(error: unknown): string {
  return toCliErrorMessage(error);
}

/**
 * Debug escape-hatch details: HTTP status, response body and stack. Returned as
 * an already-formatted multi-line string (empty when there's nothing extra).
 */
export function toCliErrorDebugDetails(error: unknown): string {
  const e = error as
    | { response?: { status?: number; statusText?: string; data?: unknown }; code?: string; stack?: string }
    | null;
  const lines: string[] = [];

  const status = Number(e?.response?.status || 0);
  if (status) {
    const statusText = String(e?.response?.statusText || '').trim();
    lines.push(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
  }
  if (e?.code) lines.push(`code: ${e.code}`);

  const body = e?.response?.data;
  if (body !== undefined && body !== null && body !== '') {
    let rendered: string;
    try {
      rendered = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    } catch {
      rendered = String(body);
    }
    lines.push(`response body:\n${rendered}`);
  }

  if (typeof e?.stack === 'string' && e.stack.trim()) {
    lines.push(`stack:\n${e.stack}`);
  }

  return lines.join('\n');
}

/** Machine-readable error shape for `--json` mode. */
export function toCliErrorJson(error: unknown): Record<string, unknown> {
  const e = error as { response?: { status?: number; data?: unknown }; code?: string } | null;
  const traceId = extractTraceId(error);
  return {
    status: 'error',
    message: toCliErrorMessageBase(error),
    ...(traceId ? { traceId } : {}),
    ...(e?.response?.status ? { httpStatus: Number(e.response.status) } : {}),
    ...(e?.code ? { code: e.code } : {}),
    ...(e?.response?.data !== undefined ? { responseBody: e.response.data } : {}),
  };
}
