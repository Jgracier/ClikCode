// Public provider-registry facade.
//
// Keep this as a FILE rather than relying on TypeScript's directory-index
// resolution. ClikDeploy CLI is published as native ESM, where Node refuses a
// directory import before it can discover `ai-provider-registry/index`.

export * from './ai-provider-registry/types';
export * from './ai-provider-registry/providers';
export * from './ai-provider-registry/lookups';
export * from './ai-provider-registry/model-limits';
