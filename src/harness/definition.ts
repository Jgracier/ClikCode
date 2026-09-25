/** What a harness is: the declared shape every vendor CLI is described by,
 * and the router runtime that reads it. One canonical definition, so a
 * per-vendor fact is always a field here and never a name in a branch. */

import type { HarnessSession } from '../session/model.js';

export type AiHarnessRoute = 'local' | 'gateway';

export type AiHarnessAuthKind = 'oauth' | 'api-key' | 'vendor-cli';

export type AiHarnessPermissionMode = 'ask' | 'bypass' | 'auto';

export type AiHarnessIntegrationLevel = 'native' | 'structured' | 'compatibility' | 'editor-only';

/** Mirrors of the catalog's declarative vocabulary (packages/clikrouter/src/
 * ai-local-harness.ts). The CLI reads these instead of checking harness names. */
export type AiHarnessTransport = 'codex-app-server' | 'acp' | 'structured-cli' | 'text-cli';

type AiHarnessTier = 'primary' | 'more' | 'experimental';

type AiHarnessParser =
  | 'claude-stream-json' | 'codex-items' | 'opencode-json'
  | 'cursor-stream-json' | 'pi-json' | 'cline-json' | 'antigravity' | 'goose'
  | 'generic-json' | 'text' | 'aider';

type AiHarnessMemoryFile = 'CLAUDE.md' | 'AGENTS.md' | 'GEMINI.md' | 'QWEN.md' | 'CONVENTIONS.md';

interface AiHarnessAcpDefinition {
  argv: readonly string[];
  binary?: string;
  optionPlacement?: 'before' | 'after';
  experimental?: boolean;
  effortArgvPrefix?: readonly string[];
  permissionArgv?: Readonly<Partial<Record<'bypass' | 'auto', readonly string[]>>>;
  listsModels?: boolean;
}

export interface AiHarnessAcpLaunch {
  binary: string;
  argv: string[];
  modeArgv: string[];
  optionArgv: string[];
  optionPlacement: 'before' | 'after';
  experimental: boolean;
}

export interface AiCustomAcpHarnessInput {
  command: string;
  binary: string;
  argv: readonly string[];
  displayName?: string;
  provider?: string;
  memoryFile?: AiHarnessMemoryFile;
}

interface AiHarnessTurnDefinition {
  startArgv: readonly string[];
  resumeArgv?: readonly string[];
  resumeIdPrefix?: readonly string[];
  resumeIdSuffix?: readonly string[];
  createIdPrefix?: readonly string[];
  createIdSuffix?: readonly string[];
  promptArgvPrefix?: readonly string[];
  promptInput?: 'argv' | 'stdin';
  stdinArgv?: readonly string[];
  promptGuard?: 'double-dash' | 'space';
  output: 'text' | 'json' | 'json-lines';
  responseFields?: readonly string[];
  /** A route that keeps no history between one-shot turns: when the turn
   * result's value at `path` is one of `values`, the session it names cannot
   * be resumed with context, so ClikCode carries its own transcript next turn
   * instead. OpenClaw's CLI back ends (`claude-cli`) refuse to reseed history
   * in `agent --local`. */
  statelessRoute?: { path: readonly string[]; values: readonly string[] };
  statelessProviders?: readonly string[];
  resumeSupportsWorkspaceSelector?: boolean;
}

type AiHarnessOptionKind = 'boolean' | 'string' | 'enum' | 'string-list' | 'path' | 'path-list' | 'number';

export interface AiHarnessOptionDefinition {
  id: string; label: string; description: string; category: string; kind: AiHarnessOptionKind;
  values?: readonly string[]; dangerous?: boolean; requiresNewSession?: boolean;
  /** Catalog argv mapping, mirrored so non-argv transports (ACP, app-server)
   * can honour declared options too. */
  argv?: readonly string[];
  argvStyle?: 'value' | 'flag' | 'repeat' | 'csv' | 'config';
  argvPlacement?: 'root' | 'turn';
  configKey?: string;
  appliesTo?: 'start' | 'resume' | 'both';
}

export interface AiHarnessCapabilityManifest {
  options: readonly AiHarnessOptionDefinition[];
  managers?: Readonly<Partial<Record<'mcp' | 'skills' | 'plugins' | 'agents' | 'hooks' | 'tools', {
    label: string;
    listArgv?: readonly string[];
    manageArgv?: readonly string[];
    /** How this harness spells "add an MCP server". Mirrors the catalog's own
     * definition so one ClikCode entry can be installed into every harness. */
    add?: { argv: readonly string[]; shape: 'positional' | 'url-or-doubledash' | 'doubledash-local'; transportPrefix?: readonly string[] };
  }>>>;
  features?: readonly string[];
}

export interface AiHarnessAccount {
  id: string;
  provider: string;
  label: string;
  authKind: AiHarnessAuthKind;
  models: string[];
  status: 'ready' | 'needs_login' | 'offline';
  quotaState?: 'available' | 'exhausted';
  quotaRetryAt?: string;
  /** The vendor signed this account in but will not serve it until the user
   * verifies it (e.g. Google's "Verify your account"). A fact about the
   * account, cleared by a turn that succeeds or by the user saying it is done. */
  verification?: { url?: string; at: string };
  credentialRef: string;
  /** Last usage reading for this account, shared across every terminal.
   * The figure belongs to the account, not to one chat, so caching it per
   * process meant the cost of displaying it scaled with the number of open
   * terminals -- which is what rate-limited the account out of reading its
   * own usage. */
  usage?: { at: string; label?: string; failed?: boolean };
  /** Learned quota shape, for the twenty-one harnesses that publish none.
   *  `highWater` is the largest cost ever ALLOWED in each candidate window
   *  (the limit estimate, converging from below) and `hits` is a bounded log
   *  of refusals with the window costs snapshotted at that moment. Nothing is
   *  displayed from this until it is mature -- see usage-learning.ts. */
  usageLearning?: {
    highWater: Record<string, number>;
    hits: { at: string; costs: Record<string, number> }[];
  };
  nativeProfile?: {
    env: string;
    path: string;
    /** Static env vars a specific harness's isolation needs beyond the one
     * profile-root variable -- currently only Antigravity CLI, whose
     * per-account isolation depends on Application Default Credentials
     * (a real file under the isolated HOME) rather than its own default
     * keyring-based auth, which ignores HOME entirely and would otherwise
     * silently collapse every isolated account back into one shared
     * identity. Optional and unused by every other harness. */
    extraEnv?: Readonly<Record<string, string>>;
  };
}

export interface AiLocalHarnessDefinition {
  command: string;
  provider: string;
  displayName: string;
  surface: 'terminal' | 'editor-extension';
  integration?: AiHarnessIntegrationLevel;
  /** Declared on every catalog entry. Optional here only because tests and
   * external callers build partial definitions by hand. */
  tier?: AiHarnessTier;
  transport?: AiHarnessTransport;
  parser?: AiHarnessParser;
  memoryFile?: AiHarnessMemoryFile;
  nativeSlashPassthrough?: boolean;
  customCommandDirs?: readonly string[];
  acp?: AiHarnessAcpDefinition;
  experimental?: boolean;
  effortValues?: readonly string[];
  normalizedPermissionOptionIds?: readonly string[];
  retiredOptionIds?: readonly string[];
  profileEnvPassthrough?: readonly string[];
  fallbackTurn?: AiHarnessTurnDefinition;
  localAuth: readonly AiHarnessAuthKind[];
  binary: string;
  npmPackage?: string;
  loginArgv?: readonly string[];
  loginCapturable?: boolean;
  statusArgv?: readonly string[];
  logoutArgv?: readonly string[];
  planMode?: { option: string; value: true | string };
  authFiles?: readonly { path: string; contains?: string; removeLine?: boolean }[];
  authEnv?: readonly string[];
  loginHint?: string;
  versionArgv?: readonly string[];
  launchArgv?: readonly string[];
  modelArgvPrefix?: readonly string[];
  modelProviderArgvPrefix?: readonly string[];
  providerLoginArgv?: readonly string[];
  modelProviderSeparator?: ':' | '/';
  replyErrorPatterns?: readonly { pattern: string; status?: number }[];
  modelDiscoveryArgv?: readonly string[];
  workspaceArgvPrefix?: readonly string[];
  effortArgvPrefix?: readonly string[];
  effortConfigKey?: string;
  permissionModes?: readonly AiHarnessPermissionMode[];
  permissionArgv?: Readonly<Partial<Record<AiHarnessPermissionMode, {
    argv: readonly string[];
    placement?: 'root' | 'turn';
  }>>>;
  /** Permission modes a vendor carries in its ENVIRONMENT rather than in
   *  argv. Goose is the case: it has no per-run mode flag at all, and an
   *  unset GOOSE_MODE auto-approves every tool call. See turnEnvironment. */
  permissionEnv?: Readonly<Partial<Record<AiHarnessPermissionMode, Readonly<Record<string, string>>>>>;
  imageArgvPrefix?: readonly string[];
  imageArgvStyle?: 'separate' | 'concatenated';
  profileEnv?: string;
  turn?: {
    startArgv: readonly string[];
    resumeArgv?: readonly string[];
    resumeIdPrefix?: readonly string[];
    resumeIdSuffix?: readonly string[];
    createIdPrefix?: readonly string[];
    createIdSuffix?: readonly string[];
    promptArgvPrefix?: readonly string[];
    promptInput?: 'argv' | 'stdin';
    stdinArgv?: readonly string[];
    promptGuard?: 'double-dash' | 'space';
    output: 'text' | 'json' | 'json-lines';
    responseFields?: readonly string[];
    statelessRoute?: { path: readonly string[]; values: readonly string[] };
  statelessProviders?: readonly string[];
    /** Literal phrases this vendor puts in its OWN result text when an
     *  account is out of usage, while still reporting the turn as a success.
     *  Augment's auggie does exactly that: is_error false, subtype "success",
     *  exit 0, and the upgrade notice where the answer should be -- so the
     *  turn looked fine, the notice was stored as the assistant's reply, the
     *  account was never marked exhausted and failover never fired.
     *
     *  Declared per harness and matched literally, never as a general
     *  heuristic. classifyAccountFailure deliberately refuses to read
     *  model-authored prose (a model discussing rate limits must not trigger
     *  failover); this is the narrow exception for text the VENDOR wrote, and
     *  it is opt-in one harness at a time so that exception can be audited. */
    quotaSignals?: readonly string[];
    resumeSupportsWorkspaceSelector?: boolean;
  };
  session?: {
    continueArgv?: readonly string[];
    resumeIdPrefix?: readonly string[];
    resumeIdSuffix?: readonly string[];
    createIdPrefix?: readonly string[];
    createIdSuffix?: readonly string[];
    createSessionArgv?: readonly string[];
    idKind?: 'uuid' | 'history-file';
    discoverArgv?: readonly string[];
    discoverFormat?: 'json' | 'json-lines' | 'text';
  };
}

export interface AiRouterRuntime {
  streamAiChatTurn(input: Record<string, unknown>): Promise<any>;
  AI_LOCAL_HARNESS_ADAPTER_VERSION: number;
  AI_LOCAL_HARNESSES: readonly AiLocalHarnessDefinition[];
  /** A provider row when this id is a model API that can be addressed
   *  directly, undefined when it merely names a tool (see catalog.ts). */
  getAiProvider(id: string): { id: string; envKey?: string } | undefined;
  localHarnessForCommand(command: string): AiLocalHarnessDefinition | undefined;
  localHarnessForProvider(provider: string): AiLocalHarnessDefinition | undefined;
  localHarnessCapabilityManifest(harness: AiLocalHarnessDefinition): AiHarnessCapabilityManifest;
  harnessSupportsEffort(harness: AiLocalHarnessDefinition): boolean;
  harnessSupportsPermissionMode(harness: AiLocalHarnessDefinition, mode: AiHarnessPermissionMode): boolean;
  harnessSupportsImages(harness: AiLocalHarnessDefinition): boolean;
  harnessIntegrationLevel(harness: AiLocalHarnessDefinition): AiHarnessIntegrationLevel;
  nativeHarnessTurnArgv(harness: AiLocalHarnessDefinition, input: {
    prompt: string; nativeSessionId?: string; createdHere?: boolean; launchedBefore?: boolean;
    model?: string | null; workspace?: string | null; effort?: string | null;
    permissionMode?: AiHarnessPermissionMode;
    images?: readonly string[];
    options?: Readonly<Record<string, unknown>>;
  }): string[];
  maxPromptArgvBytes: number;
  HOME_REDIRECT_ENV_DEFAULTS: Readonly<Record<string, string | null>>;
  allLocalHarnesses(): readonly AiLocalHarnessDefinition[];
  registerCustomHarnesses(definitions: readonly AiLocalHarnessDefinition[]): readonly AiLocalHarnessDefinition[];
  customAcpHarness(definition: AiCustomAcpHarnessInput): AiLocalHarnessDefinition;
  harnessLoginArgvForModel(harness: AiLocalHarnessDefinition, model: string | null | undefined): readonly string[] | undefined;
  harnessReplyError(harness: AiLocalHarnessDefinition, text: string): { statusCode?: number } | undefined;
  modelProvider(harness: AiLocalHarnessDefinition, model: string): string | undefined;
  modelDisplayId(harness: AiLocalHarnessDefinition, model: string): string;
  modelIdFromDisplay(harness: AiLocalHarnessDefinition, typed: string): string;
  harnessAcpLaunch(harness: AiLocalHarnessDefinition, input?: { model?: string | null; effort?: string | null; permissionMode?: AiHarnessPermissionMode }): AiHarnessAcpLaunch | undefined;
  harnessTurnTransport(harness: AiLocalHarnessDefinition, input?: { hasImages?: boolean; allowExperimentalAcp?: boolean }): AiHarnessTransport;
  harnessCanRunTurns(harness: AiLocalHarnessDefinition): boolean;
  harnessTierRank(harness: AiLocalHarnessDefinition): number;
  guardedPromptArgv(turn: Pick<AiHarnessTurnDefinition, 'promptGuard' | 'promptArgvPrefix'>, prompt: string): string[];
  promptExceedsArgvLimit(harness: AiLocalHarnessDefinition, prompt: string): boolean;
}

/** A provider the harness can reach but is not signed in to: the picker
 * offers `argv` (a vendor sign-in command) instead of models. Only
 * multi-provider harnesses publish these. `hint` is what to do once the
 * vendor opens, for one that signs in only from its own session (Pi). */
export type ModelCatalogConnect = { id: string; label: string; detail?: string; argv: readonly string[]; hint?: string };
export type ModelCatalogResult = { configured?: string; models: string[]; labels?: Readonly<Record<string, string>>; connect?: readonly ModelCatalogConnect[] };

export type NativeUsageProbe = (session: HarnessSession, environment: Readonly<Record<string, string>>) => Promise<string | undefined>;
