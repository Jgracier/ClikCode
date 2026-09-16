// ============================================
// CLIKROUTER — provider-agnostic AI dialect normalization + router selection
// ============================================
// See the package README for scope: what lives here (registry, request/
// response dialect normalization across ~40 providers, the candidate-
// ranking algorithm) vs. what deliberately does NOT (storage, credential
// resolution, billing — those are the calling app's job, injected as plain
// data into the functions here, never read from a database or Redis client
// this package owns).

export * from './ai-provider-registry';
export * from './ai-provider-http';
export * from './ai-router-selection';
export * from './ai-provider-models';
export * from './ai-local-harness';
export * from './ai-harness-gateway-protocol';
