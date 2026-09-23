/**
 * Error catalog and the one problem+json (RFC 7807) decoder for Gateway responses.
 */

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface ErrorCatalogEntry {
  message: string;
  remediation?: string;
  httpStatus?: number;
  severity?: ErrorSeverity;
  userFacing?: boolean;
}

export const ERROR_CATALOG: Record<string, ErrorCatalogEntry> = {
  RATE_LIMITED: {
    message: 'Rate limit exceeded.',
    remediation: 'Back off and retry after the indicated window.',
    httpStatus: 429,
    severity: 'warning',
    userFacing: true,
  },
  VALIDATION_FAILED: {
    message: 'The request failed validation.',
    remediation: 'Correct the highlighted fields and resubmit.',
    httpStatus: 400,
    severity: 'warning',
    userFacing: true,
  },
  INTERNAL: {
    message: 'An internal error occurred.',
    remediation: 'Retry; if it persists, contact support with the trace id.',
    httpStatus: 500,
    severity: 'critical',
    userFacing: false,
  },
  AUTH_REQUIRED: {
    message: 'Authentication is required for this request.',
    remediation: 'Run `clikcode gateway login`, then retry.',
    httpStatus: 401,
    severity: 'warning',
    userFacing: true,
  },
  INVALID_INPUT: {
    message: 'The request payload was not valid.',
    remediation: 'Correct the request fields and retry.',
    httpStatus: 400,
    severity: 'warning',
    userFacing: true,
  },
  NOT_FOUND: {
    message: 'The requested resource was not found.',
    remediation: 'Verify the identifier and that the resource belongs to your account.',
    httpStatus: 404,
    severity: 'error',
    userFacing: true,
  },
  CONFLICT: {
    message: 'The request conflicts with the current state of the resource.',
    remediation: 'Re-read the current state, then retry with a non-conflicting request.',
    httpStatus: 409,
    severity: 'warning',
    userFacing: true,
  },
  UPSTREAM_ERROR: {
    message: 'An upstream service returned an error.',
    remediation: 'The upstream is likely transient — retry shortly; if it persists, contact support with the trace id.',
    httpStatus: 502,
    severity: 'error',
    userFacing: true,
  },
};

/** Structured, user-safe detail payload attached to a problem. */
export interface ProblemDetails {
  [key: string]: unknown;
}

/** RFC 7807 problem+json, as the Gateway emits it. */
export interface ProblemJson {
  type: string;
  title: string;
  status: number;
  code: string;
  traceId?: string;
  remediation?: string;
  detail?: string;
  cause?: string[];
  details?: ProblemDetails;
}

/** The slice of an ERROR_CATALOG entry the decoder can enrich from. */
export interface ProblemCatalogEntry {
  message: string;
  remediation?: string;
  httpStatus?: number;
}

export interface ParseProblemJsonOptions {
  /** HTTP status of the response the body came from — used when the body omits one. */
  status?: number;
  /**
   * ERROR_CATALOG, injected rather than imported (see the header). Supplies
   * `title`/`remediation` for envelopes that carry a code but no prose — which
   * is every `{ success, error }` envelope body.
   */
  catalog?: Readonly<Record<string, ProblemCatalogEntry>>;
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** JSON where it works, `String()` where it does not (circular graphs). */
function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Decode ANY error body the Gateway emits into one `ProblemJson`.
 *
 * Recognised envelopes, in order:
 *
 *  1. RFC 7807 — `{ type, title, status, code, traceId?, remediation?, detail? }`.
 *  2. Envelope — `{ success: false, error: { code, message, details?, traceId? } }`.
 *  3. Flat — `{ error: string | object }` or `{ message: string }`.
 *
 * Returns `null` — never a guess — when the body carries no error contract at
 * all. A null answer is the caller's signal to fall back to the thrown error's
 * own message, which is strictly more honest than inventing a title.
 */
export function parseProblemJson(
  body: unknown,
  options: ParseProblemJsonOptions = {}
): ProblemJson | null {
  const root = record(body);
  if (!root) return null;

  const catalog = options.catalog;
  const enrich = (code: string | undefined): ProblemCatalogEntry | undefined =>
    code && catalog ? catalog[code] : undefined;

  // ── 1. RFC 7807 ───────────────────────────────────────────────────────────
  const rfcCode = str(root.code);
  const rfcTitle = str(root.title);
  if (rfcCode && rfcTitle) {
    const entry = enrich(rfcCode);
    const status = num(root.status) ?? options.status ?? entry?.httpStatus ?? 500;
    const problem: ProblemJson = {
      type: str(root.type) ?? `urn:clikcode:error:${rfcCode}`,
      title: rfcTitle,
      status,
      code: rfcCode,
    };
    const traceId = str(root.traceId) ?? str(root.trace_id);
    if (traceId) problem.traceId = traceId;
    // The server sends remediation for every catalogued code; the catalog is a
    // fallback for a body that lost it (an older server, a proxy that trimmed).
    const remediation = str(root.remediation) ?? entry?.remediation;
    if (remediation) problem.remediation = remediation;
    const detail = str(root.detail);
    if (detail) problem.detail = detail;
    if (Array.isArray(root.cause)) {
      const chain = root.cause.filter((c): c is string => typeof c === 'string');
      if (chain.length) problem.cause = chain;
    }
    const details = record(root.details);
    if (details) problem.details = details;
    return problem;
  }

  // ── 2. `{ success, error }` envelope ─────────────────────────────────────────────
  const cp = root.success === false ? record(root.error) : null;
  if (cp) {
    const code = str(cp.code) ?? 'INTERNAL';
    const entry = enrich(code);
    const title = str(cp.message) ?? entry?.message ?? 'Request failed.';
    const problem: ProblemJson = {
      type: `urn:clikcode:error:${code}`,
      title,
      status: options.status ?? entry?.httpStatus ?? 500,
      code,
    };
    const traceId = str(cp.traceId) ?? str(cp.trace_id) ?? str(root.traceId);
    if (traceId) problem.traceId = traceId;
    if (entry?.remediation) problem.remediation = entry.remediation;
    const details = record(cp.details);
    if (details) problem.details = details;
    return problem;
  }

  // ── 3. Legacy flat ────────────────────────────────────────────────────────
  const flat = root.error ?? root.message;
  let title = str(flat);
  let code: string | undefined;
  if (!title) {
    if (flat === undefined || flat === null) return null;
    const nested = record(flat);
    if (nested) {
      title = str(nested.message) ?? str(nested.error);
      code = str(nested.code);
      if (!title && code) title = enrich(code)?.message ?? code;
      // An `error` object in no shape we know. Showing its contents is still
      // strictly more than the transport library's "Request failed" sentence.
      if (!title) title = stringifySafe(nested);
    } else {
      // A number, a boolean — a body that put a scalar under `error`.
      title = String(flat);
    }
    if (!title) return null;
  }
  code = code ?? str(root.code);
  // A legacy body whose `error` IS a catalog code ("APP_NOT_FOUND") — several
  // routes do exactly this — becomes the catalogued sentence, not the token.
  const asCode = catalog && catalog[title] ? title : undefined;
  if (asCode) {
    code = asCode;
    title = catalog![asCode]!.message;
  }
  const entry = enrich(code);
  const problem: ProblemJson = {
    type: `urn:clikcode:error:${code ?? 'INTERNAL'}`,
    title,
    status: options.status ?? entry?.httpStatus ?? 500,
    code: code ?? 'INTERNAL',
  };
  const traceId = str(root.traceId) ?? str(root.trace_id);
  if (traceId) problem.traceId = traceId;
  if (entry?.remediation) problem.remediation = entry.remediation;
  return problem;
}

/**
 * Render a decoded problem as the message a HUMAN or a MODEL reads.
 *
 * `title` is the catalogued sentence, `remediation` is the catalogued next
 * action — the pair is the whole reason ERROR_CATALOG has a `remediation`
 * column. Both clients render through here so the CLI and the MCP tool surface
 * cannot drift into saying different things about the same failure.
 */
export function problemJsonMessage(problem: ProblemJson): string {
  const lines: string[] = [];
  const detail = problem.detail?.trim();
  lines.push(
    detail && detail !== problem.title ? `${problem.title} ${detail}` : problem.title
  );
  if (problem.remediation) lines.push(problem.remediation);
  return lines.join('\n');
}
