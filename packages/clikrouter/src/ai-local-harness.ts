// ============================================
// LOCAL AI HARNESS CONTRACT
// ============================================
// The gateway and a user's computer speak this small, provider-neutral
// vocabulary. Provider adapters remain in the router; credentials deliberately
// do not appear here. A BYO account is a local credential *reference*, never a
// token that can be uploaded to or read by ClikDeploy.

import { selectRouterCandidate, type AiRouterCandidate, type AiRoutingStrategy } from './ai-router-selection';

export type AiHarnessRoute = 'local' | 'gateway';
export type AiHarnessAuthKind = 'oauth' | 'api-key' | 'vendor-cli';
/** Automatic failover is deliberately limited to a known usage/quota exhaustion. */
export type AiHarnessAccountFailover = 'never' | 'on-quota-exhausted';

/**
 * The stable names exposed by the local harness.  They intentionally describe
 * an account surface rather than a vendor's implementation: direct API keys
 * stay direct, and a vendor CLI profile stays on the user's device.
 */
export interface AiLocalHarnessDefinition {
  command: string;
  provider: string;
  displayName: string;
  localAuth: readonly AiHarnessAuthKind[];
  /** Official executable; ClikCode never guesses a binary from a provider id. */
  binary: string;
  /** Official package identity where the vendor publishes one. */
  npmPackage?: string;
  /** Native argv that begins the vendor-owned interactive login flow. */
  loginArgv?: readonly string[];
}

export const AI_LOCAL_HARNESSES: readonly AiLocalHarnessDefinition[] = [
  { command: 'claude', provider: 'anthropic', displayName: 'Claude Code', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'claude', npmPackage: '@anthropic-ai/claude-code' },
  { command: 'codex', provider: 'openai', displayName: 'Codex', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'codex', npmPackage: '@openai/codex', loginArgv: ['login'] },
  { command: 'gemini', provider: 'google', displayName: 'Gemini CLI', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'gemini', npmPackage: '@google/gemini-cli' },
  { command: 'opencode', provider: 'opencode', displayName: 'OpenCode', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'opencode', loginArgv: ['auth', 'login'] },
  { command: 'copilot', provider: 'github-copilot', displayName: 'GitHub Copilot', localAuth: ['oauth', 'vendor-cli'], binary: 'copilot', npmPackage: '@github/copilot' },
  { command: 'aider', provider: 'aider', displayName: 'Aider', localAuth: ['api-key', 'vendor-cli'], binary: 'aider' },
  { command: 'goose', provider: 'goose', displayName: 'Goose', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'goose' },
  { command: 'amp', provider: 'amp', displayName: 'Amp', localAuth: ['oauth', 'vendor-cli'], binary: 'amp' },
  { command: 'pi', provider: 'pi', displayName: 'Pi Coding Agent', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'pi', npmPackage: '@mariozechner/pi-coding-agent' },
  { command: 'droid', provider: 'factory', displayName: 'Factory Droid', localAuth: ['oauth', 'vendor-cli'], binary: 'droid' },
  { command: 'kiro', provider: 'kiro', displayName: 'Kiro CLI', localAuth: ['oauth', 'vendor-cli'], binary: 'kiro' },
  { command: 'qwen', provider: 'qwen', displayName: 'Qwen Code', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'qwen' },
  { command: 'cline', provider: 'cline', displayName: 'Cline CLI', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'cline' },
  { command: 'roo', provider: 'roo', displayName: 'Roo Code CLI', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'roo' },
  { command: 'kilo', provider: 'kilo', displayName: 'Kilo Code CLI', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'kilo' },
  { command: 'cursor', provider: 'cursor', displayName: 'Cursor Agent', localAuth: ['oauth', 'vendor-cli'], binary: 'cursor' },
  { command: 'windsurf', provider: 'windsurf', displayName: 'Windsurf', localAuth: ['oauth', 'vendor-cli'], binary: 'windsurf' },
  { command: 'crush', provider: 'crush', displayName: 'Crush', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'crush' },
  { command: 'hermes', provider: 'nous', displayName: 'Hermes', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'hermes' },
  { command: 'command', provider: 'command-code', displayName: 'Command Code', localAuth: ['oauth', 'vendor-cli'], binary: 'command' },
];

export function localHarnessForCommand(command: string): AiLocalHarnessDefinition | undefined {
  return AI_LOCAL_HARNESSES.find((item) => item.command === command.trim().replace(/^\//, '').toLowerCase());
}

export function localHarnessForProvider(provider: string): AiLocalHarnessDefinition | undefined {
  return AI_LOCAL_HARNESSES.find((item) => item.provider === provider.trim().toLowerCase());
}

export interface AiHarnessAccount {
  /** Stable only on the owning device. Never use this as a gateway identity. */
  id: string;
  provider: string;
  label: string;
  authKind: AiHarnessAuthKind;
  /** Provider model ids the locally connected account can serve. */
  models: string[];
  status: 'ready' | 'needs_login' | 'offline';
  /** Local adapter's latest quota signal; never inferred from a generic error. */
  quotaState?: 'available' | 'exhausted';
  quotaRetryAt?: string;
  /**
   * Opaque local keychain/CLI-profile reference. It MUST NOT contain a token,
   * OAuth refresh token, cookie, or password and is never included in a
   * gateway registration or invocation log.
   */
  credentialRef: string;
}

export interface AiHarnessRouteRequest {
  route: AiHarnessRoute;
  strategy: AiRoutingStrategy;
  preferredModel?: string;
  estimatedPromptTokens?: number;
  accountId?: string;
}

export interface AiHarnessRouteSelection {
  route: AiHarnessRoute;
  accountId?: string;
  provider?: string;
  model?: string;
  reason: string;
}

/**
 * Resolve a local account through the SAME ranking function as the gateway.
 * Callers attach live cost, quota, latency and capability signals to candidates;
 * this contract only owns the account boundary and its no-credential invariant.
 */
export function selectLocalHarnessRoute(
  accounts: readonly AiHarnessAccount[],
  candidates: readonly (AiRouterCandidate & { accountId: string })[],
  request: AiHarnessRouteRequest,
): AiHarnessRouteSelection {
  if (request.route === 'gateway') {
    return { route: 'gateway', reason: 'gateway route explicitly selected' };
  }

  const ready = new Set(
    accounts
      .filter((account) => account.status === 'ready' && (!request.accountId || account.id === request.accountId))
      .map((account) => account.id),
  );
  const eligible = candidates.filter((candidate) => ready.has(candidate.accountId));
  const selected = selectRouterCandidate(
    eligible,
    request.strategy,
    request.preferredModel,
    request.estimatedPromptTokens,
  );
  if (!selected) {
    return {
      route: 'local',
      reason: request.accountId
        ? 'the selected local account has no eligible model'
        : 'no ready local account has an eligible model',
    };
  }
  const candidate = eligible.find(
    (item) => item.provider === selected.provider && item.model === selected.model,
  );
  return {
    route: 'local',
    accountId: candidate?.accountId,
    provider: selected.provider,
    model: selected.model,
    reason: selected.reason,
  };
}
