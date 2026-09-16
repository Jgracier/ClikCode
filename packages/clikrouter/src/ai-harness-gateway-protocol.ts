// ============================================
// AI HARNESS GATEWAY PROTOCOL
// ============================================
// Provider-neutral wire shapes for a gateway talking to a user-owned local
// harness. These documents intentionally contain capability metadata and task
// authority only: a BYO provider credential never crosses this boundary.

import type { AiHarnessAccount } from './ai-local-harness';

export const AI_HARNESS_GATEWAY_PROTOCOL = 1;

export interface AiHarnessGatewayDeviceManifest {
  protocol: typeof AI_HARNESS_GATEWAY_PROTOCOL;
  installationId: string;
  credentialBoundary: 'local-only';
  capabilities: { chat: boolean; usage: boolean; sessions: boolean; gatewayJobs: boolean };
  accounts: Array<Omit<AiHarnessAccount, 'credentialRef'>>;
  models: Array<{ accountId: string; provider: string; model: string; status: AiHarnessAccount['status'] }>;
}

/** Device metadata registered through an authenticated ClikDeploy account. */
export interface AiHarnessDeviceRegistration {
  protocol: typeof AI_HARNESS_GATEWAY_PROTOCOL;
  installationId: string;
  /** Public verification key only; its private pair remains on the device. */
  devicePublicKey: Record<string, string>;
  manifest: AiHarnessGatewayDeviceManifest;
}

/** Narrow authority the gateway grants to exactly one device job. */
export interface AiHarnessTaskAuthority {
  subject: string;
  scopes: string[];
  expiresAt: string;
}

export interface AiHarnessGatewayJob {
  protocol: typeof AI_HARNESS_GATEWAY_PROTOCOL;
  id: string;
  installationId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  authority: AiHarnessTaskAuthority;
  kind: 'chat';
  payload: {
    sessionId: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    effort?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stable bytes for a detached gateway signature. */
export function canonicalizeAiHarnessGatewayJob(job: AiHarnessGatewayJob): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  };
  return JSON.stringify(normalize(job));
}

/**
 * Validates the untrusted job envelope before signature verification/execution.
 * Expiry is checked here as well as by the gateway, so an intercepted signed
 * message cannot be replayed after its narrow authority has lapsed.
 */
export function parseAiHarnessGatewayJob(input: unknown, now = Date.now()): AiHarnessGatewayJob | null {
  if (!isRecord(input) || input.protocol !== AI_HARNESS_GATEWAY_PROTOCOL || input.kind !== 'chat') return null;
  const required = ['id', 'installationId', 'issuedAt', 'expiresAt', 'nonce'];
  if (required.some((key) => typeof input[key] !== 'string' || !(input[key] as string).trim())) return null;
  if (!isRecord(input.authority) || typeof input.authority.subject !== 'string' || !Array.isArray(input.authority.scopes) || !input.authority.scopes.every((scope) => typeof scope === 'string') || typeof input.authority.expiresAt !== 'string') return null;
  if (!isRecord(input.payload) || typeof input.payload.sessionId !== 'string' || !Array.isArray(input.payload.messages) || !input.payload.messages.every((message) => isRecord(message) && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')) return null;
  const expiresAt = Date.parse(input.expiresAt as string);
  const authorityExpiresAt = Date.parse(input.authority.expiresAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(authorityExpiresAt) || expiresAt <= now || authorityExpiresAt <= now) return null;
  return input as unknown as AiHarnessGatewayJob;
}
