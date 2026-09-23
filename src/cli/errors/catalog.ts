/** Stable error-code → { message, remediation } vocabulary and the problem+json decoder. */

export type { ErrorCatalogEntry, ErrorSeverity } from './problem-json.js';
export { ERROR_CATALOG } from './problem-json.js';

export type { ProblemJson } from './problem-json.js';
export { parseProblemJson, problemJsonMessage } from './problem-json.js';
