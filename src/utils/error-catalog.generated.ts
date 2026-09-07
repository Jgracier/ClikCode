/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source:    packages/core/src/errors.ts (ERROR_CATALOG)
 *            packages/core/src/problem-json.ts (the one problem+json decoder)
 * Generator: apps/cli/scripts/generate-error-catalog.cjs
 * Guard:     src/utils/error-catalog.drift.vitest.test.ts fails if this is stale.
 *
 * Regenerate with: pnpm --filter clikdeploy-cli generate:error-catalog
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
  BUILDER_TIMEOUT: {
    message: 'Image build exceeded its maximum runtime.',
    remediation: 'Retry the deploy; if it persists, reduce build work or raise the build timeout.',
    httpStatus: 504,
    severity: 'error',
    userFacing: true,
  },
  BUILDER_IDLE_TIMEOUT: {
    message: 'Image build stalled with no progress before completing.',
    remediation: 'Check builder load and network to the base-image registry, then retry.',
    httpStatus: 504,
    severity: 'error',
    userFacing: true,
  },
  BUILDER_BUILD_FAILED: {
    message: 'Image build failed.',
    remediation: 'Inspect the build logs for the failing step and fix the Dockerfile/source.',
    httpStatus: 422,
    severity: 'error',
    userFacing: true,
  },
  AGENT_DOCKER_OP_FAILED: {
    message: 'A Docker operation on the target server failed.',
    remediation: 'Verify the Docker daemon is healthy and has capacity, then retry.',
    httpStatus: 502,
    severity: 'error',
    userFacing: true,
  },
  AGENT_UNAVAILABLE: {
    message: 'The server agent is not reachable.',
    remediation: 'Confirm the agent process is running and connected, then retry.',
    httpStatus: 503,
    severity: 'error',
    userFacing: true,
  },
  DEPLOY_HEALTHCHECK_FAILED: {
    message: 'The deployed container failed its health check.',
    remediation: 'Review container logs and the health-check/port configuration.',
    httpStatus: 502,
    severity: 'error',
    userFacing: true,
  },
  IMAGE_NOT_INSPECTABLE: {
    message: 'The built image could not be inspected on the target server.',
    remediation: 'The transfer or registry blob is likely incomplete; rebuild and redeploy.',
    httpStatus: 502,
    severity: 'error',
    userFacing: true,
  },
  OOM_KILLED: {
    message: 'The container was killed for exceeding its memory limit.',
    remediation: 'Increase the memory limit or reduce the workload footprint.',
    httpStatus: 503,
    severity: 'error',
    userFacing: true,
  },
  REGISTRY_BLOB_MISSING: {
    message: 'A required image layer was missing from the registry.',
    remediation: 'Re-push the base image or rebuild so all layers are re-uploaded.',
    httpStatus: 502,
    severity: 'error',
    userFacing: false,
  },
  RATE_LIMITED: {
    message: 'Rate limit exceeded.',
    remediation: 'Back off and retry after the indicated window.',
    httpStatus: 429,
    severity: 'warning',
    userFacing: true,
  },
  WORKER_NOT_CONNECTED: {
    message: 'The deployment worker is not connected.',
    remediation: 'Wait for the worker to reconnect, or restart it, then retry.',
    httpStatus: 503,
    severity: 'error',
    userFacing: true,
  },
  MCP_TOOL_FAILED: {
    message: 'An MCP tool invocation failed.',
    remediation: 'Check the tool arguments and the upstream service, then retry.',
    httpStatus: 502,
    severity: 'error',
    userFacing: true,
  },
  MCP_TOOL_TIMEOUT: {
    message: 'The tool did not finish within its time budget and was cancelled.',
    remediation:
      'Retry, or narrow the request (a smaller time window, fewer lines, a single target) so the tool has less work to do.',
    httpStatus: 504,
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
  DEPLOY_POLICY_BLOCKED: {
    message: 'Deployment blocked by policy.',
    remediation:
      'Satisfy the policy that refused the deploy (e.g. make the required GitHub checks pass on the deployed commit) and retry.',
    httpStatus: 409,
    severity: 'warning',
    userFacing: true,
  },
  SERVER_DOCKER_NOT_READY: {
    message: 'Docker is not ready on the target server.',
    remediation:
      'Wait for the agent to finish setting up Docker (or fix the Docker failure it reported) and retry the deploy.',
    httpStatus: 409,
    severity: 'warning',
    userFacing: true,
  },
  APP_DELETE_IN_PROGRESS: {
    message: 'This app is currently being deleted.',
    remediation: 'Wait for the delete to finish; then re-create the app if you still need it.',
    httpStatus: 409,
    severity: 'warning',
    userFacing: true,
  },
  APP_NOT_FOUND: {
    message: 'The requested app was not found.',
    remediation: 'Verify the app id/name and that it belongs to your account.',
    httpStatus: 404,
    severity: 'error',
    userFacing: true,
  },
  SERVER_NOT_FOUND: {
    message: 'The requested server was not found.',
    remediation:
      'Verify the server id and that it belongs to your account, or add the server first.',
    httpStatus: 404,
    severity: 'error',
    userFacing: true,
  },
  SOURCE_RESOLVE_FAILED: {
    message: 'Could not resolve a deployable image or source.',
    remediation:
      'Check the image name/tag or source repository, supply concrete values for any template variables, then retry.',
    httpStatus: 422,
    severity: 'error',
    userFacing: true,
  },
  DB_PROVISION_FAILED: {
    message: 'A required database dependency did not become ready.',
    remediation: 'Check the database container logs and resources, then retry the deploy.',
    httpStatus: 500,
    severity: 'error',
    userFacing: true,
  },
  DOMAIN_ATTACH_FAILED: {
    message: 'Attaching the domain/route (DNS, TLS, or reverse proxy) failed.',
    remediation:
      'Verify DNS points to the server and ports 80/443 are reachable, then retry.',
    httpStatus: 502,
    severity: 'error',
    userFacing: true,
  },
  GIT_AUTH_REQUIRED: {
    message: 'Your Git connection is missing or has expired.',
    remediation: 'Reconnect your Git provider and try again.',
    httpStatus: 401,
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

  // ── Control-plane gate codes ───────────────────────────────────────────────
  //
  // These five were a SECOND code namespace: `ControlPlaneErrorCode` in
  // apps/web/src/lib/control-plane/response.ts, six codes used by 7 of the 45
  // /api/gate routes and by none of the other 477. A client decoding a `code`
  // therefore had to know which of two vocabularies a route spoke, and the CLI's
  // ERROR_CATALOG — generated from THIS table — could resolve neither the code
  // nor a remediation for any of them.
  //
  // Folded in rather than deleted, because the gate routes' `{ success, data }`
  // envelope is a real wire contract with shipped CLI versions. `cpError` is now
  // a thin wrapper that keeps that envelope and takes its codes from here; the
  // sixth code, `INTERNAL_ERROR`, is an alias of `INTERNAL` above and was
  // collapsed into it.
  AUTH_REQUIRED: {
    message: 'Authentication is required for this request.',
    remediation: 'Run `clik login`, or supply a valid API key, then retry.',
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

// ─────────────────────────────────────────────────────────────────────────────
// Inlined verbatim from packages/core/src/problem-json.ts
// ─────────────────────────────────────────────────────────────────────────────

// =============================================================================
// PROBLEM+JSON — the ONE decoder for the platform's HTTP error contract.
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// `toProblemJson` (errors.ts) has emitted RFC 7807 on every route that goes
// through apps/web/src/lib/api/route-handlers.ts for a long time:
//
//   { type, title, status, code, traceId, remediation }
//
// Both first-party clients then decoded it by reading `data.error ?? data.message`
// — two keys problem+json does not have. `detail` is the only key resembling
// either, and `toProblemJson` omits it in production by design. So in production
// the decode always missed and the client fell back to its transport library's
// sentence: the CLI printed axios's "Request failed with status code 404" and
// the MCP transport printed "Request failed (404)". `title`, `code` and the
// ERROR_CATALOG's `remediation` — the entire point of the catalog — reached no
// user and no model.
//
// THE RULE: one decoder. A client does not get to invent its own idea of where
// the error lives in a response body. Everything the platform has ever emitted
// as an error envelope is decoded HERE, into one shape, and nothing downstream
// reaches into a response body for an error string again.
//
// ZERO IMPORTS, DELIBERATELY. apps/cli ships as a standalone npm package and
// genuinely cannot import from `@/packages/core` (see apps/cli/src/utils/
// error-catalog.ts). This file is therefore self-contained so the CLI's
// generator can inline it verbatim — the catalog it needs for enrichment is
// passed in, never imported. One source, two copies, a drift test.

/** Structured, user-safe quota payload (QUOTA_EXCEEDED only — see toProblemJson). */
export interface ProblemDetails {
  [key: string]: unknown;
}

/** RFC 7807 problem+json, as this platform emits and consumes it. */
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
   * is every control-plane `cpError` body.
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
 * Decode ANY error body this platform emits into one `ProblemJson`.
 *
 * Recognised envelopes, in order:
 *
 *  1. RFC 7807 — `{ type, title, status, code, traceId?, remediation?, detail? }`.
 *     What `toProblemJson` emits on every route-handlers route.
 *  2. Control-plane — `{ success: false, error: { code, message, details?, traceId? } }`.
 *     What `cpError` emits on the gate routes.
 *  3. Legacy flat — `{ error: string | object }` or `{ message: string }`.
 *     What hand-rolled `NextResponse.json({ error })` routes emit.
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
      type: str(root.type) ?? `https://errors.clikdeploy.com/${rfcCode}`,
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

  // ── 2. Control-plane envelope ─────────────────────────────────────────────
  const cp = root.success === false ? record(root.error) : null;
  if (cp) {
    const code = str(cp.code) ?? 'INTERNAL';
    const entry = enrich(code);
    const title = str(cp.message) ?? entry?.message ?? 'Request failed.';
    const problem: ProblemJson = {
      type: `https://errors.clikdeploy.com/${code}`,
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
    type: `https://errors.clikdeploy.com/${code ?? 'INTERNAL'}`,
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
