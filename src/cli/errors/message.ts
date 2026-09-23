import {
  ERROR_CATALOG,
  parseProblemJson,
  problemJsonMessage,
  type ProblemJson,
} from './catalog.js';

/**
 * Decode the platform's error contract off a thrown HTTP error.
 *
 * THE ONE DECODER, for the whole CLI. Everything the platform emits — RFC 7807
 * (route-handlers, ~470 routes), the control-plane `{ success:false, error }`
 * envelope (the gate routes) and the hand-rolled `{ error: "..." }` bodies —
 * goes through `parseProblemJson`. Nothing in this file reaches into a response
 * body for an error string on its own any more.
 *
 * That is the whole defect this replaces: `toCliErrorMessageBase` read
 * `data.error ?? data.message`, and problem+json has NEITHER key. `detail` is
 * the only near-match and `toProblemJson` omits it in production by design, so
 * in production the decode always missed and axios's own sentence ("Request
 * failed with status code 404") was printed instead of the catalogued title and
 * remediation.
 */
function decodeProblem(error: unknown): ProblemJson | null {
  const e = error as { response?: { data?: unknown; status?: number } } | null;
  const response = e?.response;
  if (!response) return null;
  return parseProblemJson(response.data, {
    status: Number(response.status) || undefined,
    catalog: ERROR_CATALOG,
  });
}

/**
 * Extract a correlation/trace id from an error, if the API returned one.
 *
 * Sources, in priority order:
 *  1. `error.traceId` — attached by the ApiClient response interceptor.
 *  2. The decoded problem body's `traceId` — via the one decoder above, so this
 *     stopped being a second, partial reading of the same body.
 *  3. The `x-request-id` response header we echoed on the request.
 */
function extractTraceId(error: unknown): string | undefined {
  const e = error as
    | {
        traceId?: unknown;
        response?: {
          headers?: Record<string, unknown>;
        };
      }
    | null;

  const direct = e?.traceId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const bodyTrace = decodeProblem(error)?.traceId;
  if (bodyTrace) return bodyTrace;

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
function toCliErrorMessageBase(error: unknown): string {
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
  // A LOCAL timeout is not an outage, and conflating them is expensive. The
  // client aborts on its own deadline while the server keeps working, so
  // "temporarily unavailable — please retry" invites a second upload of
  // something that already succeeded. Say what actually happened and say that
  // the work may have landed.
  if (code === 'ECONNABORTED' && /timeout of \d+ms exceeded/i.test(message)) {
    return (
      `${message}. The request was abandoned HERE, not refused by the server — ` +
      'it may still have completed. Check the current state before retrying, ' +
      'especially for a publish or upload.'
    );
  }
  if (
    status === 502 || status === 503 || status === 504 ||
    (status >= 520 && status <= 526) ||
    code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" ||
    code === "ECONNABORTED" || code === "EPIPE" || code === "EAI_AGAIN" ||
    code === "ENOTFOUND" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_SOCKET" ||
    isBareFetchFailure
  ) {
    return "The ClikDeploy Gateway is temporarily unavailable. Please retry in a few minutes.";
  }
  // THE decode. `problemJsonMessage` renders the catalogued title and the
  // catalogued remediation — the reason ERROR_CATALOG has a `remediation` column
  // at all, and text no CLI user had ever seen before this.
  const problem = decodeProblem(error);
  if (problem) return problemJsonMessage(problem);

  // No error contract in the body (a non-JSON body, an empty 500, a local
  // throw). The thrown error's own message is the honest answer; inventing a
  // catalogued title for an error the platform never classified would be worse
  // than axios's sentence, not better.
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Unknown error';
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
function apiErrorMessage(error: unknown): string {
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
