/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source:    packages/core/src/errors.ts (ERROR_CATALOG)
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
  VALIDATION_FAILED: {
    message: 'The request failed validation.',
    remediation: 'Correct the highlighted fields and resubmit.',
    httpStatus: 400,
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
};
