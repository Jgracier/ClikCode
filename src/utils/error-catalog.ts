/**
 * Local mirror of the platform ERROR_CATALOG (see packages/core/src/errors.ts).
 *
 * The CLI ships standalone and cannot import from `@/packages/core`, so we
 * carry a small copy of the stable error-code → { message, remediation }
 * vocabulary here. Used to render actionable deploy failures when the API
 * doesn't already hand us an RFC7807 problem+json body with code/remediation.
 */

export interface ErrorCatalogEntry {
  message: string;
  remediation?: string;
  httpStatus?: number;
}

export const ERROR_CATALOG: Record<string, ErrorCatalogEntry> = {
  BUILDER_TIMEOUT: {
    message: 'Image build exceeded its maximum runtime.',
    remediation: 'Retry the deploy; if it persists, reduce build work or raise the build timeout.',
    httpStatus: 504,
  },
  BUILDER_IDLE_TIMEOUT: {
    message: 'Image build stalled with no progress before completing.',
    remediation: 'Check builder load and network to the base-image registry, then retry.',
    httpStatus: 504,
  },
  BUILDER_BUILD_FAILED: {
    message: 'Image build failed.',
    remediation: 'Inspect the build logs for the failing step and fix the Dockerfile/source.',
    httpStatus: 422,
  },
  AGENT_DOCKER_OP_FAILED: {
    message: 'A Docker operation on the target server failed.',
    remediation: 'Verify the Docker daemon is healthy and has capacity, then retry.',
    httpStatus: 502,
  },
  AGENT_UNAVAILABLE: {
    message: 'The server agent is not reachable.',
    remediation: 'Confirm the agent process is running and connected, then retry.',
    httpStatus: 503,
  },
  DEPLOY_HEALTHCHECK_FAILED: {
    message: 'The deployed container failed its health check.',
    remediation: 'Review container logs and the health-check/port configuration.',
    httpStatus: 502,
  },
  IMAGE_NOT_INSPECTABLE: {
    message: 'The built image could not be inspected on the target server.',
    remediation: 'The transfer or registry blob is likely incomplete; rebuild and redeploy.',
    httpStatus: 502,
  },
  OOM_KILLED: {
    message: 'The container was killed for exceeding its memory limit.',
    remediation: 'Increase the memory limit or reduce the workload footprint.',
    httpStatus: 503,
  },
  REGISTRY_BLOB_MISSING: {
    message: 'A required image layer was missing from the registry.',
    remediation: 'Re-push the base image or rebuild so all layers are re-uploaded.',
    httpStatus: 502,
  },
  RATE_LIMITED: {
    message: 'Rate limit exceeded.',
    remediation: 'Back off and retry after the indicated window.',
    httpStatus: 429,
  },
  WORKER_NOT_CONNECTED: {
    message: 'The deployment worker is not connected.',
    remediation: 'Wait for the worker to reconnect, or restart it, then retry.',
    httpStatus: 503,
  },
  DISK_FULL: {
    message: 'The target server ran out of disk space.',
    remediation: 'Free up disk on the server (prune old images/volumes) and retry.',
    httpStatus: 507,
  },
  VALIDATION_FAILED: {
    message: 'The request failed validation.',
    remediation: 'Correct the highlighted fields and resubmit.',
    httpStatus: 400,
  },
  INTERNAL: {
    message: 'An internal error occurred.',
    remediation: 'Retry; if it persists, contact support with the trace id.',
    httpStatus: 500,
  },
};

export interface ResolvedCatalogError {
  code: string;
  message: string;
  remediation?: string;
}

/**
 * Best-effort map a free-text deployment error string to a catalog entry.
 * Returns null when nothing matches (caller should fall back to the raw error).
 */
export function inferCatalogCode(error?: string | null): string | null {
  if (!error || typeof error !== 'string') return null;
  const lower = error.toLowerCase();
  if (/no space left|disk (space|usage|full)|enospc|insufficient disk|free up space/.test(lower)) return 'DISK_FULL';
  if (/out of memory|oom|memory limit|killed.*memory/.test(lower)) return 'OOM_KILLED';
  if (/health ?check|healthy|unhealthy/.test(lower)) return 'DEPLOY_HEALTHCHECK_FAILED';
  if (/not inspectable|could not be inspected/.test(lower)) return 'IMAGE_NOT_INSPECTABLE';
  if (/blob (unknown|missing)|short read|missing.*layer/.test(lower)) return 'REGISTRY_BLOB_MISSING';
  if (/idle|stalled|no progress/.test(lower)) return 'BUILDER_IDLE_TIMEOUT';
  if (/build (failed|error)|dockerfile|failed to build/.test(lower)) return 'BUILDER_BUILD_FAILED';
  if (/timed out|timeout|max runtime/.test(lower)) return 'BUILDER_TIMEOUT';
  if (/agent (unavailable|not reachable|offline|disconnected)/.test(lower)) return 'AGENT_UNAVAILABLE';
  if (/worker.*(not connected|disconnected|unavailable)/.test(lower)) return 'WORKER_NOT_CONNECTED';
  if (/docker (op|operation|daemon)/.test(lower)) return 'AGENT_DOCKER_OP_FAILED';
  if (/rate limit/.test(lower)) return 'RATE_LIMITED';
  return null;
}

/**
 * Resolve the best code + message + remediation for a failed deploy given an
 * explicit code (e.g. from an RFC7807 body) and/or a free-text error message.
 */
export function resolveCatalogError(
  explicitCode?: string | null,
  errorText?: string | null
): ResolvedCatalogError | null {
  const code = (explicitCode && ERROR_CATALOG[explicitCode] ? explicitCode : null) || inferCatalogCode(errorText);
  if (!code) return null;
  const entry = ERROR_CATALOG[code] ?? ERROR_CATALOG.INTERNAL;
  return { code, message: entry.message, remediation: entry.remediation };
}
