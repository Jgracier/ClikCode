/** Shared types for ClikCode's local-first AI harness broker -- pulled out
 * of ai.ts so every module that needs a HarnessSession, an
 * AiLocalHarnessDefinition, or a picker shape imports one canonical
 * definition instead of ai.ts re-exporting its own internals. */


export type AiHarnessRoute = 'local' | 'gateway';

export type AiHarnessAuthKind = 'oauth' | 'api-key' | 'vendor-cli';

export type AiHarnessPermissionMode = 'ask' | 'bypass' | 'auto';

export type AiHarnessOptionKind = 'boolean' | 'string' | 'enum' | 'string-list' | 'path' | 'path-list' | 'number';

export interface AiHarnessOptionDefinition {
  id: string; label: string; description: string; category: string; kind: AiHarnessOptionKind;
  values?: readonly string[]; dangerous?: boolean; requiresNewSession?: boolean;
}

export interface AiHarnessCapabilityManifest {
  options: readonly AiHarnessOptionDefinition[];
  managers?: Readonly<Partial<Record<'mcp' | 'skills' | 'plugins' | 'agents' | 'hooks' | 'tools', { label: string; listArgv?: readonly string[]; manageArgv?: readonly string[] }>>>;
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
    discoverFormat?: 'json' | 'json-lines' | 'text' | 'numbered-list';
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
  nativeHarnessTurnArgv(harness: AiLocalHarnessDefinition, input: {
    prompt: string; nativeSessionId?: string; createdHere?: boolean; launchedBefore?: boolean;
    model?: string | null; workspace?: string | null; effort?: string | null;
    permissionMode?: AiHarnessPermissionMode;
    images?: readonly string[];
    options?: Readonly<Record<string, unknown>>;
  }): string[];
}

export interface HarnessActivityEvent {
  kind: 'thinking' | 'tool-start' | 'tool-done';
  label: string;
  /** Only ever populated where the harness's own JSON genuinely carries the
   * before/after text (confirmed so far: Claude Code's Edit/Write tool_use
   * blocks) -- never synthesized from a "files updated" style event that
   * doesn't actually include the changed content. Each side is already
   * capped to a few lines before this is built; the activity trail below is
   * a 5-line rolling window (see FullScreenHarnessPrompter.activity), not a
   * scrollback viewer, so an uncapped diff would just silently lose its
   * earlier lines to the window sliding past them, not show a real "more"
   * indicator -- capping here means the +N truncation notice is honest. */
  diff?: { removed: string[]; added: string[] };
}

export type ModelCatalogResult = { configured?: string; models: string[]; labels?: Readonly<Record<string, string>> };

export type NativeUsageProbe = (session: HarnessSession, environment: Readonly<Record<string, string>>) => Promise<string | undefined>;

export interface HarnessSession {
  id: string;
  route: AiHarnessRoute;
  accountId: string | null;
  provider: string | null;
  model: string | null;
  effort: string;
  permissionMode?: AiHarnessPermissionMode;
  name?: string;
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
  nativeStartedAt?: string;
  workspace?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
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
  invocations: Array<{ id: string; accountId: string; provider: string; model: string; at: string; inputTokens?: number; outputTokens?: number; latencyMs: number }>;
  /** Applies to every provider unless a providerSettings entry overrides it. */
  globalSettings: HarnessDefaultSettings;
  /** Keyed by AiLocalHarnessDefinition.provider; only the fields a user has set. */
  providerSettings: Record<string, Partial<HarnessDefaultSettings & { model: string }>>;
}

export interface HarnessPrompter {
  question(prompt: string, commands?: readonly PickerOption<string>[], settings?: { cancellable?: boolean }): Promise<string>;
  select?<T>(title: string, options: readonly PickerOption<T>[], onAction?: (value: T, action: string) => Promise<void>): Promise<T | undefined>;
  render?(session: HarnessSession, account?: string, notice?: string): void;
  response?(text: string, mode?: 'append' | 'replace'): void;
  panel?(title: string, body: string): void;
  close(): void;
}

export type MessageBlock = { kind: 'code'; lines: string[] } | { kind: 'text'; paragraph: string };

export interface FormattedParagraph {
  prefix: string;
  hangIndent: string;
  text: string;
  bold: boolean;
  /** A horizontal rule has no text at all -- the render loop draws a full
   * dim rule line and skips wrapping entirely for it. */
  rule: boolean;
}

export interface PickerOption<T> { label: string; detail?: string; value: T; actions?: readonly { label: string; value: string }[] }
