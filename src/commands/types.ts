/** Shared types for ClikCode's local-first AI harness broker -- pulled out
 * of ai.ts so every module that needs a HarnessSession, an
 * AiLocalHarnessDefinition, or a picker shape imports one canonical
 * definition instead of ai.ts re-exporting its own internals. */


export type AiHarnessRoute = 'local' | 'gateway';

export type AiHarnessAuthKind = 'oauth' | 'api-key' | 'vendor-cli';

export type AiHarnessPermissionMode = 'ask' | 'bypass' | 'auto';
export type AiHarnessIntegrationLevel = 'native' | 'structured' | 'compatibility' | 'editor-only';
/** Mirrors of the catalog's declarative vocabulary (packages/clikrouter/src/
 * ai-local-harness.ts). The CLI reads these instead of checking harness names. */
export type AiHarnessTransport = 'codex-app-server' | 'acp' | 'structured-cli' | 'text-cli';
export type AiHarnessTier = 'primary' | 'more' | 'experimental';
export type AiHarnessParser =
  | 'claude-stream-json' | 'codex-items' | 'opencode-json'
  | 'cursor-stream-json' | 'pi-json' | 'cline-json' | 'antigravity' | 'goose'
  | 'generic-json' | 'text';
export type AiHarnessMemoryFile = 'CLAUDE.md' | 'AGENTS.md' | 'GEMINI.md' | 'QWEN.md' | 'CONVENTIONS.md';

export interface AiHarnessAcpDefinition {
  argv: readonly string[];
  binary?: string;
  optionPlacement?: 'before' | 'after';
  experimental?: boolean;
  effortArgvPrefix?: readonly string[];
  permissionArgv?: Readonly<Partial<Record<'bypass' | 'auto', readonly string[]>>>;
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

export interface AiHarnessTurnDefinition {
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
  resumeSupportsWorkspaceSelector?: boolean;
}

export type AiHarnessOptionKind = 'boolean' | 'string' | 'enum' | 'string-list' | 'path' | 'path-list' | 'number';

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
    add?: { argv: readonly string[]; shape: 'positional' | 'url-or-doubledash'; transportPrefix?: readonly string[] };
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
  credentialRef: string;
  /** Last usage reading for this account, shared across every terminal.
   * The figure belongs to the account, not to one chat, so caching it per
   * process meant the cost of displaying it scaled with the number of open
   * terminals -- which is what rate-limited the account out of reading its
   * own usage. */
  usage?: { at: string; label?: string; failed?: boolean };
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
  versionArgv?: readonly string[];
  launchArgv?: readonly string[];
  modelArgvPrefix?: readonly string[];
  modelDiscoveryArgv?: readonly string[];
  workspaceArgvPrefix?: readonly string[];
  effortArgvPrefix?: readonly string[];
  effortConfigKey?: string;
  permissionModes?: readonly AiHarnessPermissionMode[];
  permissionArgv?: Readonly<Partial<Record<AiHarnessPermissionMode, {
    argv: readonly string[];
    placement?: 'root' | 'turn';
  }>>>;
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
  harnessAcpLaunch(harness: AiLocalHarnessDefinition, input?: { model?: string | null; effort?: string | null; permissionMode?: AiHarnessPermissionMode }): AiHarnessAcpLaunch | undefined;
  harnessTurnTransport(harness: AiLocalHarnessDefinition, input?: { hasImages?: boolean; allowExperimentalAcp?: boolean }): AiHarnessTransport;
  harnessCanRunTurns(harness: AiLocalHarnessDefinition): boolean;
  harnessTierRank(harness: AiLocalHarnessDefinition): number;
  guardedPromptArgv(turn: Pick<AiHarnessTurnDefinition, 'promptGuard' | 'promptArgvPrefix'>, prompt: string): string[];
  promptExceedsArgvLimit(harness: AiLocalHarnessDefinition, prompt: string): boolean;
}

/** What a tool call DOES, as against what state it is in. Deliberately small:
 * five categories every harness's tools fall into, or nothing at all. */
export type ToolCategory = 'read' | 'edit' | 'run' | 'search' | 'fetch';

export interface HarnessActivityEvent {
  kind: 'thinking' | 'tool-start' | 'tool-done' | 'tool-error';
  label: string;
  /** Absent whenever the evidence does not settle it. A tool nobody has
   * catalogued renders exactly as it did before this existed, rather than
   * being assigned a plausible-looking category. */
  category?: ToolCategory;
  /** Vendor tool-call identity, when emitted, lets the TUI update an in-flight
   * row instead of appending a detached completion at the bottom. */
  id?: string;
  /** Bounded partial/final tool output supplied by the native event stream. */
  output?: string[];
  /** Only ever populated where the harness's own JSON genuinely carries the
   * before/after text (confirmed so far: Claude Code's Edit/Write tool_use
   * blocks) -- never synthesized from a "files updated" style event that
   * doesn't actually include the changed content. Each side is already
   * capped to a few lines before this is built; the activity trail below is
   * a 5-line rolling window (see TerminalHarnessPrompter.activity), not a
   * scrollback viewer, so an uncapped diff would just silently lose its
   * earlier lines to the window sliding past them, not show a real "more"
   * indicator -- capping here means the +N truncation notice is honest. */
  diff?: { removed: string[]; added: string[] };
}

export type ModelCatalogResult = { configured?: string; models: string[]; labels?: Readonly<Record<string, string>> };

export type NativeUsageProbe = (session: HarnessSession, environment: Readonly<Record<string, string>>) => Promise<string | undefined>;

export interface HarnessSession {
  id: string;
  /** Stable ClikCode conversation root. Native harness sessions are branches
   * beneath this root and are never rewritten into one another. */
  conversationId?: string;
  /** The ClikCode branch this session was created from, when it is a fork or
   * cross-provider handoff. */
  parentSessionId?: string;
  /** The terminal currently driving this conversation. Present only while a
   * process has it open, so a second terminal can tell a live chat from an
   * idle one and never attach to the same conversation twice. */
  claim?: { pid: number; host: string; startedAt: string; heartbeatAt: string };
  /** Describes a portable handoff; the source native session remains intact. */
  handoff?: { fromSessionId: string; fromHarness: string; at: string };
  route: AiHarnessRoute;
  accountId: string | null;
  provider: string | null;
  model: string | null;
  effort: string;
  permissionMode?: AiHarnessPermissionMode;
  name?: string;
  /** Who named it. `user` is a /rename and is never overwritten; `provider` is
   * the harness's own title, or one the first turn asked the model for. A name
   * with no source is a legacy one derived from the first message. */
  nameSource?: 'user' | 'provider';
  accountFailover: 'never' | 'on-quota-exhausted';
  createdAt: string;
  updatedAt: string;
  /** A closed chat is retained for history but is never reopened implicitly. */
  status: 'active' | 'closed' | 'archived';
  closedAt?: string;
  /** Native agent identity, owned by the selected vendor CLI and never sent to Gateway. */
  nativeHarness?: string;
  /**
   * Set only by an explicit Gateway selection (newGatewayConversation) --
   * never by aiSessionOpenDefault's own default-session-creation path, which
   * silently carries `route`/`provider`/`accountId` forward from whatever
   * session came before even when the user has configured nothing yet.
   * Mirrors nativeHarness's role as an "explicit choice happened" signal for
   * the one route (Gateway) that doesn't otherwise have one.
   */
  gatewayConfirmed?: true;
  nativeSessionId?: string;
  /** `nativeSessionId` was minted by ClikCode (structured-CLI `idKind: 'uuid'`)
   * and the vendor process has not yet confirmed it exists. While set, a retry
   * re-creates with the same id instead of resuming a session that never was. */
  nativeSessionPreallocated?: true;
  nativeStartedAt?: string;
  workspace?: string;
  /** Latest token/context reading reported by the transport for this chat. */
  lastUsage?: { at: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; totalTokens?: number; costUsd?: number; contextWindow?: number };
  /** What the harness said about itself on its own stream, rather than what it
   * was asked for. `model` is the model it actually ran -- a session set to
   * `automatic`, or one whose vendor silently substituted, showed the request
   * and not the answer. `permissionMode` is the mode it applied. */
  reported?: { at: string; model?: string; permissionMode?: string };
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Crash-safe turn journal. It remains separate until completion so a
   * provider retry cannot accidentally submit the same user prompt twice. */
  pendingTurn?: {
    prompt: string;
    response?: string;
    activities?: string[];
    /** Additional user instructions accepted by a provider's active-turn
     * steering protocol. They are part of this turn, not future prompts. */
    steers?: Array<{ text: string; submittedAt: string; responseOffset?: number }>;
    startedAt: string;
    updatedAt: string;
    outputStarted: boolean;
  };
  /** User messages submitted while a provider without active steering was
   * running. Persisted independently so process exit cannot discard them. */
  queuedTurns?: Array<{ id: string; text: string; submittedAt: string }>;
  attachments?: string[];
  /** Provider-native values validated against the selected harness manifest. */
  harnessOptions?: Record<string, unknown>;
}

export interface HarnessDefaultSettings {
  effort: string;
  permissionMode: AiHarnessPermissionMode;
  accountFailover: 'never' | 'on-quota-exhausted';
}

export interface HarnessState {
  version: number;
  installationId: string;
  /** Bearer secret for the loopback protocol; never rendered by CLI commands or HTTP responses. */
  localApiToken: string;
  /** Device-authentication keypair, never a provider credential. Private half stays local. */
  devicePrivateKeyPem: string;
  devicePublicKey: Record<string, unknown>;
  accounts: AiHarnessAccount[];
  sessions: HarnessSession[];
  invocations: Array<{ id: string; accountId: string; provider: string; model: string; at: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; totalTokens?: number; costUsd?: number; sessionId?: string; latencyMs: number }>;
  /** Applies to every provider unless a providerSettings entry overrides it. */
  globalSettings: HarnessDefaultSettings;
  /** Keyed by AiLocalHarnessDefinition.provider; only the fields a user has set. */
  providerSettings: Record<string, Partial<HarnessDefaultSettings & { model: string }>>;
}

export interface HarnessPrompter {
  question(
    prompt: string,
    commands?: readonly PickerOption<string>[],
    settings?: { cancellable?: boolean; rightArrowPalette?: boolean },
  ): Promise<string>;
  select?<T>(
    title: string,
    options: readonly PickerOption<T>[],
    onAction?: (value: T, action: string) => Promise<void>,
    settings?: {
      onBack?: () => void;
      onEscape?: () => void;
      refreshedOptions?: () => readonly PickerOption<T>[];
      refresh?: Promise<unknown>;
    },
  ): Promise<T | undefined>;
  render?(session: HarnessSession, account?: string, notice?: string): void;
  response?(text: string, mode?: 'append' | 'replace'): void;
  approval?(title: string, detail?: string): Promise<boolean>;
  activityEvent?(event: HarnessActivityEvent): void;
  panel?(title: string, body: string): void;
  close(): void;
}

export type MessageBlock =
  | { kind: 'paragraph'; text: string; quoteDepth: number; indent: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'heading'; text: string; level: number; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'rule'; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'code'; lines: string[]; language?: string; quoteDepth: number; indent: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'table'; header: string[]; rows: string[][]; align: Array<'left' | 'center' | 'right' | null>; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'list-item'; text: string; depth: number; ordered: boolean; number?: number; task: boolean; checked?: boolean; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean };

export interface PickerOption<T> {
  label: string;
  detail?: string;
  value: T;
  /** Alternate values represented by the same logical row (for example a
   * conversation's provider-history branches). Opened with Tab. */
  alternates?: readonly { label: string; value: T }[];
  /** Non-destructive maintenance actions such as reauthentication. */
  actions?: readonly { label: string; value: string }[];
  /** Destructive row action. The terminal picker always confirms it first. */
  deleteAction?: { label: string; value: string };
  /** Slash-palette rows: argument hint shown after the label, and the section
   * the row belongs to. Optional; a prompter that ignores them still works. */
  argHint?: string;
  group?: string;
}
