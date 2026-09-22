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

export type { ErrorCatalogEntry, ErrorSeverity } from './catalog.generated.js';
export { ERROR_CATALOG } from './catalog.generated.js';

/**
 * The platform's ONE problem+json decoder, generated into the same file from
 * packages/core/src/problem-json.ts. Re-exported here so the CLI has exactly one
 * import site for "how do I read an error out of an API response".
 */
export type { ProblemJson } from './catalog.generated.js';
export { parseProblemJson, problemJsonMessage } from './catalog.generated.js';


