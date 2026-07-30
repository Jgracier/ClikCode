import { EXIT_CODE_UNDETERMINED, isUndeterminedOutcome } from './determination';

/**
 * Process exit code for an error leaving a command.
 *
 * Two-valued exit codes cannot express "accepted, outcome unknown", and forcing it into `1` tells
 * every script that a converged operation failed. See EXIT_CODE_UNDETERMINED for the reasoning.
 */
export function toCliExitCode(error: unknown): number {
  if (isUndeterminedOutcome(error)) {
    return typeof error.exitCode === 'number' && error.exitCode > 0 ? error.exitCode : EXIT_CODE_UNDETERMINED;
  }
  return 1;
}

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

/**
 * WHAT DID WE ACTUALLY OBSERVE about the platform?
 *
 * This distinction is the whole point of the type, and getting it wrong is a measured bug: a run of
 * `app list` whose only request the server answered `200` printed "ClikDeploy is temporarily
 * unavailable" because a local socket error was rendered as a verdict about the SERVER. A response
 * is an observation about the server. A transport error is an observation about OUR SOCKET, and
 * entitles us to say only "this CLI could not complete a request".
 *
 *  • `unavailable`  — the platform (or its edge) ANSWERED, and the answer was "I cannot serve this":
 *                     502/503/504/52x. Reporting it as unavailable is quoting what it told us.
 *  • `timed-out`    — OUR deadline expired first. The request may have completed server-side; we
 *                     established nothing about its outcome.
 *  • `unreachable`  — the request never completed at the transport layer. Same: nothing established.
 *  • `none`         — not a connectivity problem. The response body / error message IS the answer.
 */
export type ConnectivityObservation = 'unavailable' | 'timed-out' | 'unreachable' | 'none';

/** Our own deadline ran out, or the peer never finished a phase in time. Not a server verdict. */
const TIMEOUT_CODES = new Set([
  'ECONNABORTED', // axios' client-side timeout
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** The connection broke or was never made. Not a server verdict either. */
const TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * THE ONE READER of "which transport code does this error carry".
 *
 * Exported because the retry policy in `api/client.ts` needs the SAME answer, and used to keep its
 * own copy of the extraction — reading `error.code` alone. undici's `fetch()` puts the real syscall
 * code on `.cause.code`, so a socket reset scored `code === undefined` AND `response === undefined`
 * there: not retriable by code, not retriable by status, no retry at all — for exactly the restart
 * window the retry layer exists to absorb. Measured on `clikdeploy --local app list`, whose only
 * request the server answered 200 in 921 ms (the break was in `await res.text()`); three immediate
 * manual retries all succeeded. Two literals for one fact is how that happened; there is now one.
 */
export function observeConnectivity(error: unknown): { kind: ConnectivityObservation; code: string } {
  const probe = error as
    | { response?: { status?: number }; code?: string; message?: string; cause?: { code?: string; message?: string } }
    | null;

  // A response — ANY response — means the platform answered us. Only then may we make a claim
  // about the platform, and only the claim its status line supports.
  if (probe?.response) {
    const status = Number(probe.response.status || 0);
    if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 526)) {
      return { kind: 'unavailable', code: `HTTP ${status}` };
    }
    return { kind: 'none', code: '' };
  }

  // undici's fetch() throws `TypeError: fetch failed` with the real syscall code on `.cause.code`
  // (not `.code`) — inspect both so connection failures don't leak raw.
  const code = String(probe?.code || probe?.cause?.code || '').toUpperCase();
  const message = String(probe?.message || '').trim();

  if (TIMEOUT_CODES.has(code) || /^timeout of \d+ms exceeded$/i.test(message)) {
    return { kind: 'timed-out', code: code || 'timeout' };
  }

  // undici reports a broken connection as EXACTLY `fetch failed`, or `terminated` when the socket
  // dies mid-body-read. The predicate this replaces also matched /\bfetch failed\b/ ANYWHERE in ANY
  // message and against no response at all, so any server-authored string that merely CONTAINED the
  // phrase was laundered into a platform-outage claim. Anchored, and only when there is no response.
  const isUndiciTransportFailure = message === 'fetch failed' || message === 'terminated';
  if (TRANSPORT_CODES.has(code) || code.startsWith('UND_ERR') || isUndiciTransportFailure) {
    return { kind: 'unreachable', code: code || message };
  }

  return { kind: 'none', code: '' };
}

/** Where we were talking to, when axios recorded it. Empty string when unknown. */
function describeRequestTarget(error: unknown): string {
  const config = (error as { config?: { baseURL?: unknown; url?: unknown } } | null)?.config;
  const base = String(config?.baseURL || '').replace(/\/$/, '');
  const path = String(config?.url || '');
  const target = `${base}${path}`;
  return target.trim();
}

/**
 * The message the platform itself put in the response body, if any. Single-sourced so the
 * "unavailable" branch can QUOTE it instead of throwing it away: a 502 whose body says
 * "builder pool exhausted" is strictly more information than the generic retry line, and
 * discarding it is the same defect as discarding a successful result.
 */
function extractResponseBodyMessage(error: unknown): string {
  const httpErr = error as { response?: { data?: { error?: unknown; message?: unknown } } } | null;
  const raw = httpErr?.response?.data?.error ?? httpErr?.response?.data?.message;
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object') {
    const nested =
      (raw as Record<string, unknown>).message ||
      (raw as Record<string, unknown>).error ||
      (raw as Record<string, unknown>).code;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return '';
}

/** Human-readable base message for an error (without the trace line). */
export function toCliErrorMessageBase(error: unknown): string {
  const observed = observeConnectivity(error);

  if (observed.kind === 'unavailable') {
    // The platform answered "I cannot serve this", so the claim about the platform is earned.
    const detail = extractResponseBodyMessage(error);
    return detail
      ? `ClikDeploy is temporarily unavailable (it may be deploying or restarting): ${detail}`
      : 'ClikDeploy is temporarily unavailable (it may be deploying or restarting). Please retry in a few minutes.';
  }

  if (observed.kind === 'timed-out') {
    const target = describeRequestTarget(error);
    return (
      `This CLI stopped waiting for a response${target ? ` from ${target}` : ''} (${observed.code}). ` +
      'Nothing was established about the request: it may have completed server-side. Re-run to read current state.'
    );
  }

  if (observed.kind === 'unreachable') {
    const target = describeRequestTarget(error);
    return (
      `This CLI could not complete its request${target ? ` to ${target}` : ''} (${observed.code}). ` +
      "That is a transport failure on this machine's connection — it establishes nothing about ClikDeploy's state. Retry."
    );
  }

  const bodyMessage = extractResponseBodyMessage(error);
  if (bodyMessage) return bodyMessage;

  const httpErr = error as { response?: { data?: { error?: unknown; message?: unknown } } } | null;
  const raw =
    httpErr?.response?.data?.error ??
    httpErr?.response?.data?.message ??
    (error instanceof Error ? error.message : null) ??
    'Unknown error';

  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
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

/**
 * Machine-readable error shape for `--json` mode.
 *
 * `status` is THREE-valued, not two: an outcome we could not determine emits
 * `"undetermined"` with its `reason`, never `"error"`. A `--json` consumer that
 * treated an unconfirmed delete as a failed delete is how a fleet got deployed on
 * top of apps believed to have survived a delete that had in fact converged.
 */
export function toCliErrorJson(error: unknown): Record<string, unknown> {
  const e = error as { response?: { status?: number; data?: unknown }; code?: string } | null;
  const traceId = extractTraceId(error);
  if (isUndeterminedOutcome(error)) {
    return {
      status: 'undetermined',
      reason: error.reason,
      message: String(error.message || error.reason),
      ...(error.detail ? { detail: error.detail } : {}),
      ...(traceId ? { traceId } : {}),
    };
  }
  return {
    status: 'error',
    message: toCliErrorMessageBase(error),
    ...(traceId ? { traceId } : {}),
    ...(e?.response?.status ? { httpStatus: Number(e.response.status) } : {}),
    ...(e?.code ? { code: e.code } : {}),
    ...(e?.response?.data !== undefined ? { responseBody: e.response.data } : {}),
  };
}
