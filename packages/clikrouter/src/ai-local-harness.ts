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
export type AiHarnessPermissionMode = 'read-only' | 'workspace-write' | 'auto';

/**
 * The stable names exposed by the local harness.  They intentionally describe
 * an account surface rather than a vendor's implementation: direct API keys
 * stay direct, and a vendor CLI profile stays on the user's device.
 */
export interface AiLocalHarnessDefinition {
  command: string;
  provider: string;
  displayName: string;
  /** Only terminal harnesses can participate in the foreground broker. */
  surface: 'terminal' | 'editor-extension';
  localAuth: readonly AiHarnessAuthKind[];
  /** Official executable; ClikCode never guesses a binary from a provider id. */
  binary: string;
  /** Official package identity where the vendor publishes one. */
  npmPackage?: string;
  /** Native argv that begins the vendor-owned interactive login flow. */
  loginArgv?: readonly string[];
  statusArgv?: readonly string[];
  logoutArgv?: readonly string[];
  /** Side-effect-free version probe; defaults to --version. */
  versionArgv?: readonly string[];
  /** Arguments required before entering the vendor's normal interactive UI. */
  launchArgv?: readonly string[];
  /** Source-backed selectors ClikCode may safely append at launch. */
  modelArgvPrefix?: readonly string[];
  /** Side-effect-free vendor command that lists models available to the active account. */
  modelDiscoveryArgv?: readonly string[];
  workspaceArgvPrefix?: readonly string[];
  effortArgvPrefix?: readonly string[];
  /** Vendor config key used when effort is expressed as --config key=value. */
  effortConfigKey?: string;
  /** Canonical permission modes this vendor CLI actually maps to a real flag.
   * Absent (the common case) means ClikCode's permissionMode setting is a
   * no-op for this harness — declared here so callers can say so instead of
   * silently accepting a setting that changes nothing. */
  permissionModes?: readonly AiHarnessPermissionMode[];
  /** Argv that precedes each image path on a turn, e.g. `['--image']`. Absent
   * means this vendor CLI has no attach-an-image flag ClikCode knows about. */
  imageArgvPrefix?: readonly string[];
  /** Vendor-supported configuration root used for isolated local accounts. */
  profileEnv?: string;
  /** One-shot, non-interactive invocation used by the persistent ClikCode UI. */
  turn?: {
    startArgv: readonly string[];
    resumeArgv?: readonly string[];
    resumeIdPrefix?: readonly string[];
    resumeIdSuffix?: readonly string[];
    createIdPrefix?: readonly string[];
    createIdSuffix?: readonly string[];
    promptArgvPrefix?: readonly string[];
    promptInput?: 'argv' | 'stdin';
    output: 'text' | 'json' | 'json-lines';
    /** Ordered JSON property names that may contain the final assistant text. */
    responseFields?: readonly string[];
    resumeSupportsWorkspaceSelector?: boolean;
  };
  /**
   * Source-backed native session invocation.  Omitted means ClikCode may
   * launch the harness but must not claim it can centrally resume its chats.
   */
  session?: {
    continueArgv?: readonly string[];
    resumeIdPrefix?: readonly string[];
    resumeIdSuffix?: readonly string[];
    /** Let ClikCode allocate the UUID before the vendor process starts. */
    createIdPrefix?: readonly string[];
    createIdSuffix?: readonly string[];
    /** Ask the vendor CLI to allocate an empty session and print its id. */
    createSessionArgv?: readonly string[];
    /** Aider-style exact history file owned by the ClikCode session. */
    idKind?: 'uuid' | 'history-file';
    /** Machine-readable (or stable UUID-bearing) vendor session listing. */
    discoverArgv?: readonly string[];
    discoverFormat?: 'json' | 'json-lines' | 'text';
  };
}

export const AI_LOCAL_HARNESS_ADAPTER_VERSION = 2;

export const AI_LOCAL_HARNESSES: readonly AiLocalHarnessDefinition[] = [
  { command: 'claude', provider: 'anthropic', displayName: 'Claude Code', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'claude', npmPackage: '@anthropic-ai/claude-code', loginArgv: ['auth', 'login'], statusArgv: ['auth', 'status'], logoutArgv: ['auth', 'logout'], modelArgvPrefix: ['--model'], effortArgvPrefix: ['--effort'], permissionModes: ['read-only', 'workspace-write', 'auto'], profileEnv: 'CLAUDE_CONFIG_DIR', turn: { startArgv: ['-p', '--verbose', '--output-format', 'stream-json'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
  { command: 'codex', provider: 'openai', displayName: 'Codex', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'codex', npmPackage: '@openai/codex', loginArgv: ['login'], statusArgv: ['login', 'status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cd'], effortArgvPrefix: ['--config'], effortConfigKey: 'model_reasoning_effort', permissionModes: ['read-only', 'workspace-write', 'auto'], imageArgvPrefix: ['--image'], profileEnv: 'CODEX_HOME', turn: { startArgv: ['exec', '--json', '--skip-git-repo-check'], resumeArgv: ['exec', 'resume'], resumeIdSuffix: ['--json', '--skip-git-repo-check'], promptInput: 'stdin', output: 'json-lines', responseFields: ['text'], resumeSupportsWorkspaceSelector: false }, session: { resumeIdPrefix: ['resume'], continueArgv: ['resume', '--last'] } },
  { command: 'gemini', provider: 'google', displayName: 'Gemini CLI', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'gemini', npmPackage: '@google/gemini-cli', modelArgvPrefix: ['--model'], turn: { startArgv: ['--output-format', 'json'], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['-p'], output: 'json', responseFields: ['response', 'result', 'text'] }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--resume', 'latest'] } },
  { command: 'opencode', provider: 'opencode', displayName: 'OpenCode', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'opencode', loginArgv: ['auth', 'login'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], workspaceArgvPrefix: ['--dir'], effortArgvPrefix: ['--variant'], turn: { startArgv: ['run', '--format', 'json'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] }, session: { resumeIdPrefix: ['--session'], continueArgv: ['--continue'], discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json' } },
  { command: 'copilot', provider: 'github-copilot', displayName: 'GitHub Copilot', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'copilot', npmPackage: '@github/copilot', loginArgv: ['login'], statusArgv: ['status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], profileEnv: 'COPILOT_HOME', turn: { startArgv: ['-s'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session-id'], promptArgvPrefix: ['-p'], output: 'text' }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session-id'], continueArgv: ['--continue'] } },
  { command: 'aider', provider: 'aider', displayName: 'Aider', surface: 'terminal', localAuth: ['api-key', 'vendor-cli'], binary: 'aider', modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['--list-models', ''], turn: { startArgv: [], createIdPrefix: ['--chat-history-file'], resumeIdPrefix: ['--chat-history-file'], resumeIdSuffix: ['--restore-chat-history'], promptArgvPrefix: ['--message'], output: 'text' }, session: { idKind: 'history-file', createIdPrefix: ['--chat-history-file'], resumeIdPrefix: ['--chat-history-file'], resumeIdSuffix: ['--restore-chat-history'] } },
  { command: 'goose', provider: 'goose', displayName: 'Goose', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'goose', turn: { startArgv: ['run'], resumeIdPrefix: ['--resume', '--session-id'], promptArgvPrefix: ['--text'], output: 'text' }, session: { resumeIdPrefix: ['session', '--resume', '--session-id'], discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json' } },
  { command: 'amp', provider: 'amp', displayName: 'Amp', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'amp', npmPackage: '@ampcode/cli', loginArgv: ['login'], versionArgv: ['version'], turn: { startArgv: [], resumeArgv: ['threads', 'continue'], promptArgvPrefix: ['-x'], output: 'text' }, session: { resumeIdPrefix: ['threads', 'continue'] } },
  { command: 'pi', provider: 'pi', displayName: 'Pi Coding Agent', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'pi', npmPackage: '@earendil-works/pi-coding-agent', modelArgvPrefix: ['--model'], effortArgvPrefix: ['--thinking'], profileEnv: 'PI_CODING_AGENT_DIR', turn: { startArgv: ['-p', '--mode', 'json'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session'], continueArgv: ['--continue'] } },
  { command: 'droid', provider: 'factory', displayName: 'Factory Droid', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'droid', modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--reasoning-effort'], turn: { startArgv: ['exec', '--output-format', 'json'], resumeIdPrefix: ['--resume'], output: 'json', responseFields: ['result', 'response', 'text'] }, session: { resumeIdPrefix: ['--resume'] } },
  { command: 'kiro', provider: 'kiro', displayName: 'Kiro CLI', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'kiro-cli', launchArgv: ['chat'], turn: { startArgv: ['chat', '--no-interactive'], resumeIdPrefix: ['--resume-id'], output: 'text' }, session: { resumeIdPrefix: ['chat', '--resume-id'], continueArgv: ['chat', '--resume'] } },
  { command: 'qwen', provider: 'qwen', displayName: 'Qwen Code', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'qwen', modelArgvPrefix: ['--model'], profileEnv: 'QWEN_HOME', turn: { startArgv: ['-p', '--output-format', 'json'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], output: 'json', responseFields: ['result', 'response', 'text'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'], discoverArgv: ['sessions', 'list', '--json'], discoverFormat: 'json-lines' } },
  { command: 'cline', provider: 'cline', displayName: 'Cline CLI', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'cline', npmPackage: 'cline', loginArgv: ['auth'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--thinking'], profileEnv: 'CLINE_DATA_DIR', turn: { startArgv: ['--json'], resumeIdPrefix: ['--id'], output: 'json-lines', responseFields: ['text', 'content', 'result'] }, session: { resumeIdPrefix: ['--id'] } },
  { command: 'roo', provider: 'roo', displayName: 'Roo Code', surface: 'editor-extension', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'roo' },
  { command: 'kilo', provider: 'kilo', displayName: 'Kilo Code CLI', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'kilo', npmPackage: '@kilocode/cli', loginArgv: ['auth', 'login'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], turn: { startArgv: ['run', '--format', 'json'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] }, session: { resumeIdPrefix: ['--session'], continueArgv: ['--continue'] } },
  { command: 'cursor', provider: 'cursor', displayName: 'Cursor Agent', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'cursor-agent', loginArgv: ['login'], statusArgv: ['status', '--format', 'json'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], workspaceArgvPrefix: ['--workspace'], turn: { startArgv: ['-p', '--output-format', 'json'], resumeIdPrefix: ['--resume'], output: 'json', responseFields: ['result', 'response', 'text'] }, session: { createSessionArgv: ['create-chat'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
  { command: 'windsurf', provider: 'windsurf', displayName: 'Windsurf Cascade', surface: 'editor-extension', localAuth: ['oauth', 'vendor-cli'], binary: 'windsurf' },
  { command: 'crush', provider: 'crush', displayName: 'Crush', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'crush', npmPackage: '@charmland/crush', turn: { startArgv: ['run'], output: 'text' } },
  { command: 'hermes', provider: 'nous', displayName: 'Hermes', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'hermes', loginArgv: ['login'], statusArgv: ['status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--in'], effortArgvPrefix: ['--reasoning'], profileEnv: 'HERMES_HOME', turn: { startArgv: [], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['-z'], output: 'text' }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--continue'], discoverArgv: ['sessions', 'list', '--limit', '50'], discoverFormat: 'text' } },
  { command: 'command', provider: 'command-code', displayName: 'Command Code', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'cmdc', npmPackage: 'command-code', loginArgv: ['login'], statusArgv: ['status', '--json'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], effortArgvPrefix: ['--effort'], profileEnv: 'HOME', turn: { startArgv: ['--print', '--output-format', 'json', '--yolo', '--skip-onboarding', '--no-auto-update'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
];

export interface AiNativeHarnessLaunchInput {
  nativeSessionId?: string;
  createdHere?: boolean;
  launchedBefore?: boolean;
  model?: string | null;
  workspace?: string | null;
  effort?: string | null;
}

/** Build only argv declared by the adapter; user-controlled values never become shell text. */
export function nativeHarnessLaunchArgv(harness: AiLocalHarnessDefinition, input: AiNativeHarnessLaunchInput): string[] {
  let argv = [...(harness.launchArgv ?? [])];
  if (input.nativeSessionId) {
    if (input.createdHere && harness.session?.createIdPrefix) {
      argv = [...harness.session.createIdPrefix, input.nativeSessionId, ...(harness.session.createIdSuffix ?? [])];
    } else if (harness.session?.resumeIdPrefix) {
      argv = [...harness.session.resumeIdPrefix, input.nativeSessionId, ...(harness.session.resumeIdSuffix ?? [])];
    }
  } else if (input.launchedBefore && harness.session?.continueArgv) {
    argv = [...harness.session.continueArgv];
  }
  if (input.model && harness.modelArgvPrefix) argv.push(...harness.modelArgvPrefix, input.model);
  if (input.workspace && harness.workspaceArgvPrefix) argv.push(...harness.workspaceArgvPrefix, input.workspace);
  if (input.effort && harness.effortArgvPrefix) argv.push(...harness.effortArgvPrefix, harness.effortConfigKey ? `${harness.effortConfigKey}="${input.effort}"` : input.effort);
  return argv;
}

export interface AiNativeHarnessTurnInput extends AiNativeHarnessLaunchInput {
  prompt: string;
  permissionMode?: AiHarnessPermissionMode;
  images?: readonly string[];
}

/** Build a single non-interactive turn while keeping terminal ownership in ClikCode. */
export function nativeHarnessTurnArgv(harness: AiLocalHarnessDefinition, input: AiNativeHarnessTurnInput): string[] {
  if (!harness.turn) throw new Error(`${harness.displayName} has no centralized turn adapter`);
  const resumed = Boolean(input.nativeSessionId && !input.createdHere);
  let argv = [...(resumed && harness.turn.resumeArgv ? harness.turn.resumeArgv : harness.turn.startArgv)];
  if (input.nativeSessionId) {
    const prefix = input.createdHere ? harness.turn.createIdPrefix : harness.turn.resumeIdPrefix;
    if (prefix) argv.push(...prefix, input.nativeSessionId, ...(input.createdHere ? harness.turn.createIdSuffix ?? [] : harness.turn.resumeIdSuffix ?? []));
    else if (resumed && harness.turn.resumeArgv) argv.push(input.nativeSessionId, ...(harness.turn.resumeIdSuffix ?? []));
  }
  if (input.model && harness.modelArgvPrefix) argv.push(...harness.modelArgvPrefix, input.model);
  if (input.workspace && harness.workspaceArgvPrefix && (!resumed || harness.turn.resumeSupportsWorkspaceSelector !== false)) argv.push(...harness.workspaceArgvPrefix, input.workspace);
  if (input.effort && harness.effortArgvPrefix) argv.push(...harness.effortArgvPrefix, harness.effortConfigKey ? `${harness.effortConfigKey}="${input.effort}"` : input.effort);
  if (input.permissionMode && harness.permissionModes?.includes(input.permissionMode)) {
    if (harness.command === 'codex') {
      const permissionArgs = ['--sandbox', input.permissionMode === 'auto' ? 'workspace-write' : input.permissionMode];
      if (input.permissionMode === 'auto') permissionArgs.push('--approve-for-me');
      // `sandbox` belongs to `codex exec`, not its `resume` subcommand. Clap
      // accepts parent options before `resume` and rejects them after it.
      if (resumed && harness.turn.resumeArgv?.[0] === 'exec') argv.splice(1, 0, ...permissionArgs);
      else argv.push(...permissionArgs);
    } else if (harness.command === 'claude') {
      const mode = input.permissionMode === 'read-only' ? 'plan' : input.permissionMode === 'workspace-write' ? 'acceptEdits' : 'auto';
      argv.push('--permission-mode', mode, '--permission-prompts', 'none');
    }
  }
  if (harness.imageArgvPrefix) for (const image of input.images ?? []) argv.push(...harness.imageArgvPrefix, image);
  if (harness.turn.promptArgvPrefix) argv.push(...harness.turn.promptArgvPrefix);
  argv.push(harness.turn.promptInput === 'stdin' ? '-' : input.prompt);
  return argv;
}

export function localHarnessForCommand(command: string): AiLocalHarnessDefinition | undefined {
  return AI_LOCAL_HARNESSES.find((item) => item.command === command.trim().replace(/^\//, '').toLowerCase());
}

export function localHarnessForProvider(provider: string): AiLocalHarnessDefinition | undefined {
  return AI_LOCAL_HARNESSES.find((item) => item.provider === provider.trim().toLowerCase());
}

/** Whether setting this field on this harness actually changes its argv, so a
 * caller can refuse an override instead of silently accepting one that does
 * nothing — effort and permission mode are both vendor-declared capabilities,
 * not universal ones every harness honors. */
export function harnessSupportsEffort(harness: AiLocalHarnessDefinition): boolean {
  return Boolean(harness.effortArgvPrefix);
}

export function harnessSupportsPermissionMode(harness: AiLocalHarnessDefinition, mode: AiHarnessPermissionMode): boolean {
  return Boolean(harness.permissionModes?.includes(mode));
}

export function harnessSupportsImages(harness: AiLocalHarnessDefinition): boolean {
  return Boolean(harness.imageArgvPrefix);
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
