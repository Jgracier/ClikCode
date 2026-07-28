/**
 * The platform ERROR_CATALOG, as available to the standalone CLI.
 *
 * The CLI ships as its own npm package and cannot import from `@/packages/core`,
 * so it carries a copy of the stable error-code → { message, remediation }
 * vocabulary. That copy is now GENERATED from packages/core/src/errors.ts by
 * scripts/generate-error-catalog.cjs — the hand-maintained version had drifted
 * to 14 codes against core's 20, so the platform sent remediation text for the
 * most common failure classes and the CLI rendered a bare message instead.
 *
 * Edit packages/core/src/errors.ts, then regenerate. error-catalog.drift.vitest.test.ts
 * fails the suite if the generated file is stale.
 */

export type { ErrorCatalogEntry, ErrorSeverity } from './error-catalog.generated';
export { ERROR_CATALOG } from './error-catalog.generated';

import { ERROR_CATALOG } from './error-catalog.generated';

export interface ResolvedCatalogError {
  code: string;
  message: string;
  remediation?: string;
}

/**
 * Resolve a catalog entry from the code the API attached.
 *
 * `inferCatalogCode` used to sit behind this as a fallback: twelve regexes guessing a code out of
 * the error prose. It was deleted, not replaced. Every one of its patterns was a guess at a value
 * the platform already knows and now always sends — and its guesses were routinely wrong in a way
 * that mattered, because `/build (failed|error)/` matches almost any build output and would relabel
 * a specific verdict as the generic BUILDER_BUILD_FAILED. Showing the user the real code, or no
 * code and the raw error, is strictly more honest than showing a confident wrong one.
 */
export function resolveCatalogError(
  explicitCode?: string | null
): ResolvedCatalogError | null {
  const code = explicitCode && ERROR_CATALOG[explicitCode] ? explicitCode : null;
  if (!code) return null;
  const entry = ERROR_CATALOG[code] ?? ERROR_CATALOG.INTERNAL;
  return { code, message: entry.message, remediation: entry.remediation };
}
