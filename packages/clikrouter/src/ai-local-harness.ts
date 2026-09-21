// ============================================
// LOCAL AI HARNESS CONTRACT
// ============================================
// The gateway and a user's computer speak this small, provider-neutral
// vocabulary. Provider adapters remain in the router; credentials deliberately
// do not appear here. A BYO account is a local credential *reference*, never a
// token that can be uploaded to or read by ClikDeploy.

import {
  selectRouterCandidate,
  selectRouterCandidateDynamic,
  type AiRouterCandidate,
  type AiRoutingStrategy,
} from './ai-router-selection';

export type AiHarnessRoute = 'local' | 'gateway';
export type AiHarnessAuthKind = 'oauth' | 'api-key' | 'vendor-cli';
/** Automatic failover is deliberately limited to a known usage/quota exhaustion. */
export type AiHarnessAccountFailover = 'never' | 'on-quota-exhausted';
export type AiHarnessPermissionMode = 'ask' | 'bypass' | 'auto';
/** Honest integration depth. This describes the transport ClikCode actually
 * uses today, not every feature the vendor product happens to offer. */
export type AiHarnessIntegrationLevel = 'native' | 'structured' | 'compatibility' | 'editor-only';
/** The transport ClikCode PREFERS for a harness. `acp` and `codex-app-server`
 * are shared protocol clients; the two `*-cli` values are the one-shot argv
 * contract in `turn`, which also remains the fallback for an `acp` harness. */
export type AiHarnessTransport = 'codex-app-server' | 'acp' | 'structured-cli' | 'text-cli';
/** Picker placement. `primary` is shown first, `more` sits behind "More
 * providers", `experimental` is reserved for adapters nobody has run live. */
export type AiHarnessTier = 'primary' | 'more' | 'experimental';
/** Stream-adapter FAMILY, not a vendor name: two vendors that emit the same
 * envelope (Qwen/Amp -> Claude stream-json, Kilo -> OpenCode) declare the same
 * family here instead of being name-mapped inside the CLI. */
export type AiHarnessParser =
  | 'claude-stream-json' | 'codex-items' | 'opencode-json'
  | 'cursor-stream-json' | 'pi-json' | 'cline-json' | 'antigravity' | 'goose'
  | 'generic-json' | 'text';
/** Project instruction file the vendor loads on its own; /init and /memory target it. */
export type AiHarnessMemoryFile = 'CLAUDE.md' | 'AGENTS.md' | 'GEMINI.md' | 'QWEN.md' | 'CONVENTIONS.md';

/** Agent Client Protocol launch contract. Everything the shared ACP client
 * needs to spawn a vendor comes from here; it holds no vendor table itself. */
export interface AiHarnessAcpDefinition {
  /** Argv that puts the vendor binary into ACP-over-stdio mode. */
  argv: readonly string[];
  /** Dedicated ACP executable when it is not `binary` (Mistral `vibe-acp`). */
  binary?: string;
  /** Where model/effort/permission flags go relative to `argv`. `after` is for
   * vendors whose flags belong to the ACP subcommand (Droid `exec`). */
  optionPlacement?: 'before' | 'after';
  /** Declared from vendor documentation but not yet run live by ClikCode; the
   * CLI should keep preferring the proven one-shot `turn` until verified. */
  experimental?: boolean;
  /** Only when the ACP mode accepts an effort flag the one-shot mode lacks. */
  effortArgvPrefix?: readonly string[];
  /** Only when ACP needs a different mapping than `permissionArgv`. `ask` is
   * never sent: ACP's own permission requests implement it. */
  permissionArgv?: Readonly<Partial<Record<'bypass' | 'auto', readonly string[]>>>;
}

export type AiHarnessOptionCategory =
  | 'model' | 'reasoning' | 'mode' | 'permissions' | 'tools' | 'context'
  | 'session' | 'output' | 'safety' | 'advanced';
export type AiHarnessOptionKind = 'boolean' | 'string' | 'enum' | 'string-list' | 'path' | 'path-list' | 'number';

export interface AiHarnessOptionDefinition {
  /** Stable normalized key stored by ClikCode. */
  id: string;
  label: string;
  description: string;
  category: AiHarnessOptionCategory;
  kind: AiHarnessOptionKind;
  values?: readonly string[];
  /** Explicit argv mapping. `repeat` emits the prefix once per list value. */
  argv?: readonly string[];
  argvStyle?: 'value' | 'flag' | 'repeat' | 'csv' | 'config';
  /** Some CLIs only accept a flag before their turn subcommand. */
  argvPlacement?: 'root' | 'turn';
  configKey?: string;
  appliesTo?: 'start' | 'resume' | 'both';
  dangerous?: boolean;
  requiresNewSession?: boolean;
}

export interface AiHarnessManagerDefinition {
  label: string;
  /** Side-effect-free list/status command, captured by ClikCode. */
  listArgv?: readonly string[];
  /** Vendor-owned interactive manager. ClikCode suspends its TUI before running it. */
  manageArgv?: readonly string[];
}

export interface AiHarnessCapabilityManifest {
  options: readonly AiHarnessOptionDefinition[];
  managers?: Readonly<Partial<Record<'mcp' | 'skills' | 'plugins' | 'agents' | 'hooks' | 'tools', AiHarnessManagerDefinition>>>;
  features?: readonly string[];
}

/** One-shot, non-interactive invocation used by the persistent ClikCode UI. */
export interface AiHarnessTurnDefinition {
  startArgv: readonly string[];
  resumeArgv?: readonly string[];
  resumeIdPrefix?: readonly string[];
  resumeIdSuffix?: readonly string[];
  createIdPrefix?: readonly string[];
  createIdSuffix?: readonly string[];
  promptArgvPrefix?: readonly string[];
  promptInput?: 'argv' | 'stdin';
  /** Argv standing in for the prompt when it is piped. Defaults to `['-']`
   * (Codex). `[]` is for a vendor that reads stdin when no prompt is given. */
  stdinArgv?: readonly string[];
  /** How an argv prompt beginning with `-` is kept from parsing as a flag.
   * `double-dash` only for a POSITIONAL prompt on a vendor whose parser
   * honors `--`; the default prefixes one space, which every parser treats
   * as a value and no model treats as meaningful. */
  promptGuard?: 'double-dash' | 'space';
  output: 'text' | 'json' | 'json-lines';
  /** Ordered JSON property names that may contain the final assistant text. */
  responseFields?: readonly string[];
  resumeSupportsWorkspaceSelector?: boolean;
}

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
  /** Picker placement; the CLI sorts on this and never on a command name. */
  tier: AiHarnessTier;
  /** Preferred transport. A harness that is `structured` ONLY through ACP
   * (Copilot, Hermes: their one-shot mode is plain text) says so here. */
  transport: AiHarnessTransport;
  /** Explicit on every catalog entry. Optional only so an externally supplied
   * definition still classifies structurally via harnessIntegrationLevel(). */
  integration?: AiHarnessIntegrationLevel;
  /** Stream-adapter family that decodes `turn` output. */
  parser: AiHarnessParser;
  /** Instruction file the vendor itself loads for a project. */
  memoryFile: AiHarnessMemoryFile;
  /** True only where `/command` sent as the headless prompt is executed by the
   * vendor. False means ClikCode must expand custom commands itself. */
  nativeSlashPassthrough: boolean;
  /** Vendor custom-command directories, project-relative or `~`-relative. */
  customCommandDirs?: readonly string[];
  acp?: AiHarnessAcpDefinition;
  /** The one-shot `turn` contract below comes from vendor documentation and has
   * not been run live by ClikCode. Details are in the comment above the entry. */
  experimental?: boolean;
  /** Accepted values for `effortArgvPrefix`, in ascending order. */
  effortValues?: readonly string[];
  /** Live provider options hidden because the normalized permission selector
   * owns them. A stored value under one of these ids is ignored, not an error. */
  normalizedPermissionOptionIds?: readonly string[];
  /** Option ids this adapter once declared and no longer does. Session state
   * written by an older ClikCode is ignored instead of failing its next turn. */
  retiredOptionIds?: readonly string[];
  /** Only for `profileEnv: 'HOME'`. Redirecting HOME also hides the user's git,
   * ssh-agent, npm, gh and docker configuration from the agent's tools; these
   * are the variables the CLI must set (see HOME_REDIRECT_ENV_DEFAULTS) or pass
   * through so real turns still commit, push and install as the user. */
  profileEnvPassthrough?: readonly string[];
  localAuth: readonly AiHarnessAuthKind[];
  /** Official executable; ClikCode never guesses a binary from a provider id. */
  binary: string;
  /** Official package identity where the vendor publishes one. */
  npmPackage?: string;
  /** Native argv that begins the vendor-owned interactive login flow. */
  loginArgv?: readonly string[];
  /** True only for a harness whose loginArgv is confirmed to complete its
   * own auth (e.g. opening a browser via an OS-level call) without ever
   * needing the real terminal -- confirmed for Antigravity CLI by running
   * its login command with stdout/stderr fully piped away instead of
   * inherited, and it still authenticated successfully. When true, the
   * login flow runs captured, with ClikCode's own UI and spinner staying
   * up the whole time, instead of suspending the alt-screen to hand the
   * terminal to the child process -- never guessed for a harness whose
   * login might actually need to print a URL or read a pasted code back. */
  loginCapturable?: boolean;
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
  /** Exact vendor argv for each normalized permission choice. An empty argv is
   * deliberate: it means the vendor's unflagged default implements that mode. */
  permissionArgv?: Readonly<Partial<Record<AiHarnessPermissionMode, {
    argv: readonly string[];
    placement?: 'root' | 'turn';
  }>>>;
  /** Argv that precedes each image path on a turn, e.g. `['--image']`. Absent
   * means this vendor CLI has no attach-an-image flag ClikCode knows about. */
  imageArgvPrefix?: readonly string[];
  imageArgvStyle?: 'separate' | 'concatenated';
  /** Vendor-supported configuration root used for isolated local accounts. */
  profileEnv?: string;
  turn?: AiHarnessTurnDefinition;
  /** Proven contract to retry with when an `experimental` structured `turn`
   * is rejected by an older vendor build. */
  fallbackTurn?: AiHarnessTurnDefinition;
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

export const AI_LOCAL_HARNESS_ADAPTER_VERSION = 7;

/** Largest prompt ClikCode will place in argv. Linux caps ONE argument at
 * 128 KiB (MAX_ARG_STRLEN) and Windows caps the whole command line at ~32 KiB
 * of UTF-16; 96 KiB leaves room for the rest of argv on POSIX. A caller with a
 * larger prompt must use a `promptInput: 'stdin'` harness or spill to a file. */
export const maxPromptArgvBytes = 96 * 1024;

/** Variables a HOME-redirected account needs so the agent's tools still act as
 * the user. Value = path under the REAL home to point the variable at; `null`
 * = pass the caller's own value through unchanged. ssh itself resolves keys
 * from the passwd home, not $HOME, so only the agent socket needs carrying. */
export const HOME_REDIRECT_ENV_DEFAULTS: Readonly<Record<string, string | null>> = {
  GIT_CONFIG_GLOBAL: '~/.gitconfig',
  NPM_CONFIG_USERCONFIG: '~/.npmrc',
  GH_CONFIG_DIR: '~/.config/gh',
  DOCKER_CONFIG: '~/.docker',
  GNUPGHOME: '~/.gnupg',
  CARGO_HOME: '~/.cargo',
  RUSTUP_HOME: '~/.rustup',
  SSH_AUTH_SOCK: null,
  GIT_SSH_COMMAND: null,
};
const HOME_REDIRECT_ENV_PASSTHROUGH: readonly string[] = Object.keys(HOME_REDIRECT_ENV_DEFAULTS);

/** Kilo Code CLI is an OpenCode fork: same subcommands, same `run --format
 * json` envelope, same session store layout. It derives from this base so a
 * corrected OpenCode flag can never leave a stale copy behind in Kilo. Only
 * identity, packaging and the permission mapping differ per entry.
 * `opencode acp` is confirmed present in `opencode --help`; it stays
 * experimental because ClikCode has not yet driven a turn through it. */
const OPENCODE_FAMILY = {
  surface: 'terminal', transport: 'structured-cli', integration: 'structured', parser: 'opencode-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false,
  customCommandDirs: ['.opencode/command', '~/.config/opencode/command'],
  acp: { argv: ['acp'], experimental: true },
  localAuth: ['api-key', 'oauth', 'vendor-cli'], loginArgv: ['auth', 'login'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], workspaceArgvPrefix: ['--dir'],
  effortArgvPrefix: ['--variant'], effortValues: ['minimal', 'low', 'medium', 'high', 'max'],
  permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--auto'] } }, normalizedPermissionOptionIds: ['auto-approve'],
  imageArgvPrefix: ['--file'],
  turn: { promptGuard: 'double-dash', startArgv: ['run', '--format', 'json'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] },
  session: { resumeIdPrefix: ['--session'], continueArgv: ['--continue'], discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json' },
} as const satisfies Partial<AiLocalHarnessDefinition>;
// OpenCode-only declarations a fork must not inherit by accident.
const { customCommandDirs: _openCodeCommandDirs, normalizedPermissionOptionIds: _openCodePermissionAliases, ...OPENCODE_FORK_BASE } = OPENCODE_FAMILY;

export const AI_LOCAL_HARNESSES: readonly AiLocalHarnessDefinition[] = [
  { command: 'claude', provider: 'anthropic', displayName: 'Claude Code', surface: 'terminal', tier: 'primary', transport: 'structured-cli', integration: 'structured', parser: 'claude-stream-json', memoryFile: 'CLAUDE.md', nativeSlashPassthrough: true, customCommandDirs: ['.claude/commands', '~/.claude/commands'], effortValues: ['low', 'medium', 'high', 'xhigh', 'max'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'claude', npmPackage: '@anthropic-ai/claude-code', loginArgv: ['auth', 'login'], statusArgv: ['auth', 'status'], logoutArgv: ['auth', 'logout'], modelArgvPrefix: ['--model'], effortArgvPrefix: ['--effort'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--permission-mode', 'manual', '--permission-prompts', 'none'] }, bypass: { argv: ['--permission-mode', 'bypassPermissions', '--permission-prompts', 'none', '--allow-dangerously-skip-permissions'] }, auto: { argv: ['--permission-mode', 'auto', '--permission-prompts', 'none'] } }, profileEnv: 'CLAUDE_CONFIG_DIR', turn: { startArgv: ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], promptInput: 'stdin', stdinArgv: [], output: 'json-lines', responseFields: ['result'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
  // Grok Build speaks Claude Code's stream-json shape exactly -- verified live
  // against `grok -p --output-format streaming-messages-json`, whose first
  // line is {"type":"system","subtype":"init","session_id":…} and whose last
  // is {"type":"result",…,"usage":{…}} -- so it reuses that parser rather
  // than getting a near-identical one of its own. It publishes no quota
  // window (its errors are balance-based: "usage balance exhausted", HTTP
  // 402), so it reports no usage, which is the honest answer.
  { command: 'grok', provider: 'xai', displayName: 'Grok Build', surface: 'terminal', tier: 'primary', transport: 'structured-cli', integration: 'structured', parser: 'claude-stream-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, effortValues: ['low', 'medium', 'high'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'grok', npmPackage: '@xai-official/grok', loginArgv: ['login'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--reasoning-effort'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--permission-mode', 'default'] }, bypass: { argv: ['--permission-mode', 'bypassPermissions'] }, auto: { argv: ['--permission-mode', 'auto'] } }, turn: { startArgv: ['--output-format', 'streaming-messages-json', '--include-partial-messages'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['-p'], output: 'json-lines', responseFields: ['result'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
  { command: 'codex', provider: 'openai', displayName: 'Codex', surface: 'terminal', tier: 'primary', transport: 'codex-app-server', integration: 'native', parser: 'codex-items', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, customCommandDirs: ['~/.codex/prompts'], effortValues: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'codex', npmPackage: '@openai/codex', loginArgv: ['login'], statusArgv: ['login', 'status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cd'], effortArgvPrefix: ['--config'], effortConfigKey: 'model_reasoning_effort', permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'], placement: 'root' }, bypass: { argv: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'], placement: 'root' }, auto: { argv: ['--approve-for-me'], placement: 'root' } }, imageArgvPrefix: ['--image'], profileEnv: 'CODEX_HOME', turn: { startArgv: ['exec', '--json', '--skip-git-repo-check'], resumeArgv: ['exec', 'resume'], resumeIdSuffix: ['--json', '--skip-git-repo-check'], promptInput: 'stdin', output: 'json-lines', responseFields: ['text'], resumeSupportsWorkspaceSelector: false }, session: { resumeIdPrefix: ['resume'], continueArgv: ['resume', '--last'] } },
  { ...OPENCODE_FAMILY, command: 'opencode', provider: 'opencode', displayName: 'OpenCode', tier: 'primary', binary: 'opencode' },
  { command: 'copilot', provider: 'github-copilot', displayName: 'GitHub Copilot', surface: 'terminal', tier: 'primary', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['--acp', '--stdio'], effortArgvPrefix: ['--effort'] }, retiredOptionIds: ['allow-all'], localAuth: ['oauth', 'vendor-cli'], binary: 'copilot', npmPackage: '@github/copilot', loginArgv: ['login'], statusArgv: ['status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['-C'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--allow-all'] } }, imageArgvPrefix: ['--attachment'], profileEnv: 'COPILOT_HOME', turn: { startArgv: ['-s'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session-id'], promptArgvPrefix: ['-p'], output: 'text' }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session-id'], continueArgv: ['--continue'] } },
  { command: 'aider', provider: 'aider', displayName: 'Aider', surface: 'terminal', tier: 'more', transport: 'text-cli', integration: 'compatibility', parser: 'text', memoryFile: 'CONVENTIONS.md', nativeSlashPassthrough: false, localAuth: ['api-key', 'vendor-cli'], binary: 'aider', modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['--list-models', ''], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--yes-always'] } }, imageArgvPrefix: ['--file'], turn: { startArgv: [], createIdPrefix: ['--chat-history-file'], resumeIdPrefix: ['--chat-history-file'], resumeIdSuffix: ['--restore-chat-history'], promptArgvPrefix: ['--message'], output: 'text' }, session: { idKind: 'history-file', createIdPrefix: ['--chat-history-file'], resumeIdPrefix: ['--chat-history-file'], resumeIdSuffix: ['--restore-chat-history'] } },
  { command: 'goose', provider: 'goose', displayName: 'Goose', surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'goose', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['acp'], experimental: true }, localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'goose', modelArgvPrefix: ['--model'], turn: { startArgv: ['run', '--output-format', 'stream-json'], createIdPrefix: ['--name'], resumeIdPrefix: ['--resume', '--name'], promptArgvPrefix: ['--text'], output: 'json-lines', responseFields: ['text', 'content', 'response'] }, session: { idKind: 'uuid', createIdPrefix: ['--name'], resumeIdPrefix: ['session', '--resume', '--name'], discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json' } },
  // Amp's execute mode has a documented `--stream-json` switch that emits
  // Claude Code-compatible stream-json (system/assistant/result envelopes), so
  // it borrows the claude-stream-json parser family. UNVERIFIED LIVE: amp is
  // not installed where this was written, hence `experimental`; `fallbackTurn`
  // is the previously shipped plain-text contract, unchanged.
  { command: 'amp', provider: 'amp', displayName: 'Amp', surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'claude-stream-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, experimental: true, localAuth: ['oauth', 'vendor-cli'], binary: 'amp', npmPackage: '@ampcode/cli', loginArgv: ['login'], versionArgv: ['version'], turn: { startArgv: ['--stream-json'], resumeArgv: ['threads', 'continue'], resumeIdSuffix: ['--stream-json'], promptArgvPrefix: ['-x'], output: 'json-lines', responseFields: ['result'] }, fallbackTurn: { startArgv: [], resumeArgv: ['threads', 'continue'], promptArgvPrefix: ['-x'], output: 'text' }, session: { resumeIdPrefix: ['threads', 'continue'] } },
  // Verified against Antigravity's own official headless-mode docs
  // (antigravity.google/docs/cli/headless/): -p/--print for a single
  // non-interactive prompt, --model <slug>, --continue/-c for the most
  // recent conversation, --conversation <id> to resume a specific one, and
  // --output-format text|json|stream-json -- these are the real, documented
  // flags, not guessed. No loginArgv: the same doc states headless mode
  // "uses your cached credentials -- authenticate once with an interactive
  // agy session first," meaning there's no scriptable login command, only
  // an interactive one -- loginArgv: [] here is the same pattern already
  // used for Gemini CLI for exactly this reason: it still routes through
  // ClikCode's suspend/resume handoff into agy's own interactive session
  // rather than being skipped entirely for lacking a real login argv.
  // Genuinely NOT verified: the JSON field names inside a stream-json
  // event carrying the final response text, and whether a conversation id
  // reliably comes back in that output at all -- Antigravity's own issue
  // tracker (google-antigravity/antigravity-cli#7) was, as of this
  // research, still requesting that a per-conversation id be emitted at
  // all, meaning --conversation-based resume may not work reliably yet.
  // responseFields here matches the same best-effort convention already
  // used for other harnesses with an unconfirmed inner schema (Pi, Kilo
  // Code) rather than a fabricated certainty.
  // loginArgv runs a minimal real print-mode turn rather than launching agy
  // bare: bare agy needs its own bubbletea TUI, which requires a real
  // /dev/tty and never returns on its own once open (confirmed live: a
  // proper login flow, but the wrong shape for a broker that hands off and
  // gets control back automatically). --print, by contrast, opens the same
  // OAuth browser flow when unauthenticated and returns control the moment
  // that completes -- confirmed live: it triggered the real browser OAuth
  // prompt with no TTY at all in a plain piped shell, not just under a
  // pty. The one real cost: unlike Claude/Codex's dedicated login
  // subcommands, this is a genuine (trivial) turn, not a free auth-only
  // call, since agy has no login-only command in its own CLI surface.
  // profileEnv: 'HOME' -- confirmed live: agy resolves its entire config
  // tree (~/.gemini/antigravity-cli/, credentials included) from $HOME, the
  // same way it would with a real home directory, so redirecting HOME per
  // account is a real isolation mechanism here, not a guess -- verified
  // `agy models` runs cleanly under a freshly isolated HOME. This is what
  // makes "add a new/different account" actually work: a fresh, empty HOME
  // has no cached credential, so the loginArgv turn below genuinely
  // triggers OAuth rather than silently reusing whatever's cached under
  // the real HOME. Reauthenticating an account whose own isolated HOME
  // still holds a *valid* credential will still silently reuse it, same as
  // a fresh install would -- agy has no forced-relogin flag in its own CLI
  // surface to force past that, confirmed via --help.
  // loginCapturable was tried and reverted: piping stdout/stderr away
  // "worked" in this dev environment only because it has some ambient
  // Google credential satisfying auth before OAuth is ever needed --
  // confirmed by testing a genuinely fresh, isolated HOME directly with
  // output visible, which *also* succeeded silently with zero prompt shown
  // here. That's not representative of a user with no ambient credential:
  // for them, piping this away hides whatever agy would otherwise print
  // (a URL, a code) with nothing to interact with, exactly the "signing
  // in... then gave up, no consent page" report this reverts. Back to
  // stdio: 'inherit' via suspend/resume, same as Claude Code/Codex --
  // real output on screen, including the actual prompt a fresh user needs
  // to complete it, at the cost of the raw JSON dump this doesn't hide.
  { command: 'antigravity', provider: 'antigravity', displayName: 'Antigravity CLI', surface: 'terminal', tier: 'primary', transport: 'structured-cli', integration: 'structured', parser: 'antigravity', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, effortValues: ['low', 'medium', 'high'], profileEnvPassthrough: HOME_REDIRECT_ENV_PASSTHROUGH, localAuth: ['oauth', 'vendor-cli'], binary: 'agy', loginArgv: ['-p', 'hi', '--output-format', 'json'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], effortArgvPrefix: ['--effort'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--dangerously-skip-permissions'] } }, profileEnv: 'HOME', turn: { startArgv: ['--output-format', 'stream-json'], promptArgvPrefix: ['-p'], resumeIdPrefix: ['--conversation'], output: 'json-lines', responseFields: ['text', 'result', 'response'] }, session: { resumeIdPrefix: ['--conversation'], continueArgv: ['--continue'] } },
  { command: 'pi', provider: 'pi', displayName: 'Pi Coding Agent', surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'pi-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, effortValues: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'pi', npmPackage: '@earendil-works/pi-coding-agent', modelArgvPrefix: ['--model'], effortArgvPrefix: ['--thinking'], imageArgvPrefix: ['@'], imageArgvStyle: 'concatenated', profileEnv: 'PI_CODING_AGENT_DIR', turn: { startArgv: ['-p', '--mode', 'json'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session'], continueArgv: ['--continue'] } },
  { command: 'droid', provider: 'factory', displayName: 'Factory Droid', surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['exec', '--output-format', 'acp'], optionPlacement: 'after' }, effortValues: ['low', 'medium', 'high', 'xhigh'], localAuth: ['oauth', 'vendor-cli'], binary: 'droid', modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--reasoning-effort'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--skip-permissions-unsafe'] }, auto: { argv: ['--auto', 'low'] } }, turn: { startArgv: ['exec', '--output-format', 'json'], resumeIdPrefix: ['--session-id'], output: 'json', responseFields: ['result', 'response', 'text'] }, session: { resumeIdPrefix: ['--session-id'] } },
  { command: 'kiro', provider: 'kiro', displayName: 'Kiro CLI', surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['acp'], experimental: true }, effortValues: ['low', 'medium', 'high', 'xhigh', 'max'], localAuth: ['api-key'], binary: 'kiro-cli', launchArgv: ['chat'], effortArgvPrefix: ['--effort'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--trust-all-tools'] } }, turn: { promptGuard: 'double-dash', startArgv: ['chat', '--no-interactive', '--agent-engine', 'v3', '--output-format', 'stream-json'], resumeIdPrefix: ['--resume-id'], output: 'json-lines', responseFields: ['text', 'content', 'result'] }, session: { resumeIdPrefix: ['chat', '--resume-id'], continueArgv: ['chat', '--resume'], discoverArgv: ['chat', '--list-sessions'], discoverFormat: 'text' } },
  { command: 'qwen', provider: 'qwen', displayName: 'Qwen Code', surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'claude-stream-json', memoryFile: 'QWEN.md', nativeSlashPassthrough: false, customCommandDirs: ['.qwen/commands', '~/.qwen/commands'], acp: { argv: ['--experimental-acp'], experimental: true }, normalizedPermissionOptionIds: ['approval-mode'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'qwen', modelArgvPrefix: ['--model'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--approval-mode', 'default'] }, bypass: { argv: ['--approval-mode', 'yolo'] }, auto: { argv: ['--approval-mode', 'auto'] } }, profileEnv: 'QWEN_HOME', turn: { startArgv: ['-p', '--output-format', 'stream-json', '--include-partial-messages'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'], discoverArgv: ['sessions', 'list', '--json'], discoverFormat: 'json-lines' } },
  { command: 'cline', provider: 'cline', displayName: 'Cline CLI', surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'cline-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['--acp'], permissionArgv: { auto: ['--auto-approve', 'true'] } }, effortValues: ['none', 'low', 'medium', 'high', 'xhigh'], normalizedPermissionOptionIds: ['auto-approve'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'cline', npmPackage: 'cline', loginArgv: ['auth'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--thinking'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: ['--auto-approve', 'false'] }, bypass: { argv: ['--auto-approve', 'true'] } }, turn: { startArgv: ['--json'], resumeIdPrefix: ['--id'], output: 'json-lines', responseFields: ['text', 'content', 'result'] }, session: { resumeIdPrefix: ['--id'] } },
  { ...OPENCODE_FORK_BASE, command: 'kilo', provider: 'kilo', displayName: 'Kilo Code CLI', tier: 'more', binary: 'kilo', npmPackage: '@kilocode/cli', permissionModes: ['ask', 'auto'], permissionArgv: { ask: { argv: [] }, auto: { argv: ['--auto'] } } },
  { command: 'cursor', provider: 'cursor', displayName: 'Cursor Agent', surface: 'terminal', tier: 'primary', transport: 'structured-cli', integration: 'structured', parser: 'cursor-stream-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, customCommandDirs: ['.cursor/commands', '~/.cursor/commands'], normalizedPermissionOptionIds: ['auto-review', 'force'], localAuth: ['oauth', 'vendor-cli'], binary: 'cursor-agent', loginArgv: ['login'], statusArgv: ['status', '--format', 'json'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], workspaceArgvPrefix: ['--workspace'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--force'] }, auto: { argv: ['--auto-review'] } }, turn: { promptGuard: 'double-dash', startArgv: ['-p', '--output-format', 'stream-json', '--stream-partial-output'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { createSessionArgv: ['create-chat'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
  { command: 'crush', provider: 'crush', displayName: 'Crush', surface: 'terminal', tier: 'more', transport: 'text-cli', integration: 'compatibility', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, effortValues: ['low', 'medium', 'high'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'crush', npmPackage: '@charmland/crush', modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--reasoning-effort'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--yolo'], placement: 'root' } }, turn: { promptGuard: 'double-dash', startArgv: ['run', '--quiet'], resumeIdPrefix: ['--session'], output: 'text' }, session: { resumeIdPrefix: ['--session'], continueArgv: ['--continue'] } },
  { command: 'hermes', provider: 'nous', displayName: 'Hermes', surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['acp'] }, effortValues: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], normalizedPermissionOptionIds: ['yolo'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'hermes', loginArgv: ['login'], statusArgv: ['status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--in'], effortArgvPrefix: ['--reasoning'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--yolo'] } }, imageArgvPrefix: ['--image'], profileEnv: 'HERMES_HOME', turn: { startArgv: ['chat', '--quiet'], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['--query'], output: 'text' }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--continue'], discoverArgv: ['sessions', 'list', '--limit', '50'], discoverFormat: 'text' } },
  { command: 'command', provider: 'command-code', displayName: 'Command Code', surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, effortValues: ['low', 'medium', 'high'], profileEnvPassthrough: HOME_REDIRECT_ENV_PASSTHROUGH, localAuth: ['oauth', 'vendor-cli'], binary: 'cmdc', npmPackage: 'command-code', loginArgv: ['login'], statusArgv: ['status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['--list-models'], effortArgvPrefix: ['--effort'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--permission-mode', 'standard'] }, bypass: { argv: ['--yolo'] }, auto: { argv: ['--permission-mode', 'auto-accept'] } }, profileEnv: 'HOME', turn: { startArgv: ['--print', '--output-format', 'json', '--skip-onboarding', '--no-auto-update'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
  // ---- Added from vendor documentation; none of these binaries was available
  // to run live, so every one-shot contract below is `experimental` and only
  // flags the vendor documents are declared. No session selectors are claimed:
  // an absent `session` means ClikCode launches but never pretends to resume.
  // Kimi CLI (MoonshotAI): `kimi --acp` is the documented ACP entry point and
  // the preferred transport. `--print` is its non-interactive mode and
  // `--command` carries the prompt; stream-json output is left undeclared.
  { command: 'kimi', provider: 'kimi', displayName: 'Kimi CLI', surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['--acp'] }, experimental: true, localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'kimi', modelArgvPrefix: ['--model'], turn: { startArgv: ['--print'], promptArgvPrefix: ['--command'], output: 'text' } },
  // Augment Auggie: `--print` with `--output-format json` returns one JSON
  // document; `--acp` is documented. The JSON field holding the answer is not
  // confirmed, so responseFields is the usual best-effort list.
  { command: 'auggie', provider: 'augment', displayName: 'Augment Auggie', surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, customCommandDirs: ['.augment/commands', '~/.augment/commands'], acp: { argv: ['--acp'], experimental: true }, experimental: true, localAuth: ['oauth', 'vendor-cli'], binary: 'auggie', npmPackage: '@augmentcode/auggie', loginArgv: ['login'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], turn: { startArgv: ['--print', '--output-format', 'json'], output: 'json', responseFields: ['result', 'response', 'text'] } },
  // Mistral Vibe ships ACP as a SEPARATE executable, `vibe-acp`, with no argv.
  // `vibe --prompt` is its documented programmatic mode (plain text).
  { command: 'vibe', provider: 'mistral-vibe', displayName: 'Mistral Vibe', surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { binary: 'vibe-acp', argv: [] }, experimental: true, localAuth: ['api-key', 'vendor-cli'], binary: 'vibe', turn: { startArgv: [], promptArgvPrefix: ['--prompt'], output: 'text' } },
  // OpenHands CLI: `openhands acp` is documented; headless is `--headless`
  // with the task in `-t`. Its JSON event mode is left undeclared.
  { command: 'openhands', provider: 'openhands', displayName: 'OpenHands CLI', surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['acp'] }, experimental: true, localAuth: ['api-key', 'vendor-cli'], binary: 'openhands', turn: { startArgv: ['--headless'], promptArgvPrefix: ['-t'], output: 'text' } },
  // Continue CLI: `cn -p` is the documented headless mode and prints the final
  // answer as text. No ACP mode is declared because none is documented.
  // Flags read from `cn --help` on a real install: -p/--print for headless,
  // --model <slug>, and a permission surface of --readonly (plan, read-only
  // tools) / --auto (all tools allowed) / --allow / --exclude. `--format json`
  // exists too but is left unwired: the flag is documented, the shape its
  // output takes is not, and a parser declared against an unverified shape
  // fails at the one moment it matters.
  { command: 'cn', provider: 'continue', displayName: 'Continue', surface: 'terminal', tier: 'more', transport: 'text-cli', integration: 'compatibility', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, experimental: true, localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'cn', npmPackage: '@continuedev/cli', loginArgv: ['login'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: ['--readonly'] }, bypass: { argv: ['--auto'] } }, turn: { startArgv: [], promptArgvPrefix: ['-p'], output: 'text' } },
];

/** Every catalog entry declares `integration`; this reads it first. The
 * remainder is a purely STRUCTURAL classification for definitions supplied
 * from outside the catalog -- it never looks at a command or provider name. */
export function harnessIntegrationLevel(harness: AiLocalHarnessDefinition): AiHarnessIntegrationLevel {
  if (harness.integration) return harness.integration;
  if (harness.surface === 'editor-extension') return 'editor-only';
  if (harness.transport === 'codex-app-server') return 'native';
  if (harness.transport === 'acp' && harness.acp) return 'structured';
  if (harness.transport === 'text-cli') return 'compatibility';
  return harness.turn && harness.turn.output !== 'text' ? 'structured' : 'compatibility';
}

const flag = (
  id: string, label: string, description: string, category: AiHarnessOptionCategory,
  argv: readonly string[], extra: Partial<AiHarnessOptionDefinition> = {},
): AiHarnessOptionDefinition => ({ id, label, description, category, kind: 'boolean', argv, argvStyle: 'flag', appliesTo: 'both', ...extra });
const value = (
  id: string, label: string, description: string, category: AiHarnessOptionCategory,
  argv: readonly string[], kind: AiHarnessOptionKind = 'string', extra: Partial<AiHarnessOptionDefinition> = {},
): AiHarnessOptionDefinition => ({ id, label, description, category, kind, argv, argvStyle: 'value', appliesTo: 'both', ...extra });

/**
 * Heterogeneous vendor behavior belongs here. The UI consumes this data and
 * never branches on a provider name. Entries are intentionally explicit: a
 * missing capability means "not verified", not "probably supported".
 */
export const AI_LOCAL_HARNESS_CAPABILITIES: Readonly<Record<string, AiHarnessCapabilityManifest>> = {
  claude: {
    options: [
      value('agent', 'Agent', 'Use a configured Claude agent', 'mode', ['--agent']),
      value('tools', 'Built-in tools', 'Choose the built-in tools available to the session', 'tools', ['--tools'], 'string-list', { argvStyle: 'csv' }),
      value('allowed-tools', 'Allowed tools', 'Tool patterns allowed without prompting', 'permissions', ['--allowed-tools'], 'string-list', { argvStyle: 'csv' }),
      value('disallowed-tools', 'Denied tools', 'Tool patterns that must not run', 'permissions', ['--disallowed-tools'], 'string-list', { argvStyle: 'csv' }),
      value('add-dir', 'Additional directories', 'Additional directories Claude may access', 'context', ['--add-dir'], 'path-list', { argvStyle: 'repeat' }),
      value('fallback-model', 'Fallback models', 'Ordered models used when the primary is unavailable', 'model', ['--fallback-model']),
      value('max-budget-usd', 'Maximum budget (USD)', 'Maximum API spend for a print-mode turn', 'safety', ['--max-budget-usd'], 'number'),
      value('mcp-config', 'MCP configuration', 'JSON files or inline MCP configuration', 'tools', ['--mcp-config'], 'path-list', { argvStyle: 'repeat' }),
      value('plugin-dir', 'Plugin directories', 'Plugin folders or archives loaded for this session', 'tools', ['--plugin-dir'], 'path-list', { argvStyle: 'repeat' }),
      value('autocompact', 'Auto compact', 'Automatic context compaction threshold', 'session', ['--autocompact']),
      flag('safe-mode', 'Safe mode', 'Disable customizations, plugins, skills, hooks, and MCP', 'safety', ['--safe-mode']),
      flag('restricted', 'Restricted mode', 'Remove code-running tools and constrain file access', 'safety', ['--restricted']),
      flag('bare', 'Bare mode', 'Skip hooks, plugins, memory, settings, and instruction discovery', 'safety', ['--bare']),
      flag('disable-skills', 'Disable skills', 'Disable skill slash commands', 'tools', ['--disable-slash-commands']),
      flag('chrome', 'Chrome integration', 'Enable Claude in Chrome integration', 'tools', ['--chrome']),
    ],
    managers: {
      mcp: { label: 'MCP servers', listArgv: ['mcp', 'list'], manageArgv: ['mcp'] },
      plugins: { label: 'Plugins', listArgv: ['plugin', 'list'], manageArgv: ['plugin'] },
      agents: { label: 'Agents', listArgv: ['agents'], manageArgv: ['agents'] },
    },
    features: ['skills', 'hooks', 'custom commands', 'settings layers'],
  },
  codex: {
    options: [
      value('profile', 'Configuration profile', 'Layer a named Codex profile over config.toml', 'advanced', ['--profile']),
      value('add-dir', 'Additional writable directories', 'Writable roots in addition to the workspace', 'context', ['--add-dir'], 'path-list', { argvStyle: 'repeat' }),
      value('output-schema', 'Output schema', 'JSON Schema for the final response', 'output', ['--output-schema'], 'path'),
      value('local-provider', 'Local provider', 'Local OSS runtime used with OSS mode', 'model', ['--local-provider'], 'enum', { values: ['lmstudio', 'ollama'] }),
      flag('oss', 'Open-source model', 'Use a configured local open-source provider', 'model', ['--oss']),
      flag('search', 'Web search', 'Enable the native web-search tool', 'tools', ['--search'], { argvPlacement: 'root' }),
      flag('network-access', 'Network access', 'Allow outbound network from Codex workspace-write commands (required for GitHub in Ask mode)', 'safety', ['--config', 'sandbox_workspace_write.network_access=true'], { argvPlacement: 'root' }),
      flag('worktree', 'Managed worktree', 'Run in a new managed Git worktree', 'session', ['--worktree'], { requiresNewSession: true }),
      flag('ephemeral', 'Ephemeral session', 'Do not persist native session files', 'session', ['--ephemeral'], { requiresNewSession: true }),
      flag('ignore-user-config', 'Ignore user config', 'Do not load CODEX_HOME/config.toml', 'safety', ['--ignore-user-config']),
      flag('ignore-rules', 'Ignore execution rules', 'Do not load user or project execpolicy rules', 'safety', ['--ignore-rules']),
      flag('strict-config', 'Strict configuration', 'Fail on unrecognized configuration keys', 'safety', ['--strict-config']),
    ],
    managers: {
      mcp: { label: 'MCP servers', listArgv: ['mcp', 'list'], manageArgv: ['mcp'] },
      plugins: { label: 'Plugins', listArgv: ['plugin', 'list'], manageArgv: ['plugin'] },
      agents: { label: 'Agents', listArgv: ['agents'], manageArgv: ['agents'] },
    },
    features: ['skills', 'plugins', 'approval policies', 'feature flags', 'configuration profiles'],
  },
  opencode: {
    options: [
      value('agent', 'Agent', 'Agent configuration used for the turn', 'mode', ['--agent']),
      value('title', 'Session title', 'Title assigned to a new native session', 'session', ['--title'], 'string', { appliesTo: 'start' }),
      flag('pure', 'Pure mode', 'Run without external plugins', 'safety', ['--pure']),
      flag('auto-approve', 'Auto approve', 'Auto-approve permissions not explicitly denied', 'permissions', ['--auto'], { dangerous: true }),
      flag('thinking-output', 'Show thinking events', 'Include provider thinking blocks in event output', 'output', ['--thinking']),
      flag('fork-native-session', 'Fork native session', 'Fork before continuing the selected session', 'session', ['--fork'], { appliesTo: 'resume', requiresNewSession: true }),
      flag('share', 'Share session', 'Publish the native session through OpenCode', 'session', ['--share']),
    ],
    managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] }, agents: { label: 'Agents', manageArgv: ['agent'] } },
    features: ['plugins', 'commands', 'remote server attachment'],
  },
  copilot: {
    options: [
      value('agent', 'Agent', 'Custom Copilot agent', 'mode', ['--agent']),
      value('additional-mcp-config', 'Additional MCP config', 'Per-session MCP JSON or @file', 'tools', ['--additional-mcp-config']),
      value('allow-tool', 'Allowed tools', 'Tool or MCP permission patterns', 'permissions', ['--allow-tool'], 'string-list', { argvStyle: 'repeat' }),
      value('deny-tool', 'Denied tools', 'Tool or MCP denial patterns', 'permissions', ['--deny-tool'], 'string-list', { argvStyle: 'repeat' }),
      value('context-tier', 'Context tier', 'Context-window tier for supported models', 'model', ['--context'], 'enum', { values: ['default', 'long_context'] }),
      value('max-autopilot-continues', 'Autopilot continuation limit', 'Maximum automatic continuation messages', 'safety', ['--max-autopilot-continues'], 'number'),
      flag('plan', 'Plan mode', 'Start in read-only planning mode', 'mode', ['--plan']),
      flag('no-ask-user', 'Disable questions', 'Prevent the agent from asking clarifying questions', 'mode', ['--no-ask-user']),
      flag('sandbox', 'Shell sandbox', 'Enable Copilot’s OS-level shell sandbox', 'safety', ['--sandbox']),
      flag('no-custom-instructions', 'Ignore custom instructions', 'Do not load repository instruction files', 'context', ['--no-custom-instructions']),
      flag('no-remote', 'Disable remote access', 'Disable remote control for this session', 'safety', ['--no-remote']),
      flag('no-remote-export', 'Disable remote export', 'Do not export this session to GitHub remote clients', 'safety', ['--no-remote-export']),
      flag('worktree', 'Managed worktree', 'Run in a separate managed Git worktree', 'session', ['--worktree'], { requiresNewSession: true }),
    ],
    managers: { mcp: { label: 'MCP servers', listArgv: ['mcp', 'list', '--json'], manageArgv: ['mcp'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] }, skills: { label: 'Skills', manageArgv: ['skill'] }, agents: { label: 'Instructions and agents', manageArgv: ['instruction'] } },
    features: ['skills', 'custom agents', 'hooks', 'plugins', 'built-in GitHub MCP'],
  },
  aider: {
    options: [
      value('edit-format', 'Edit format', 'Editing protocol used by the primary model', 'mode', ['--edit-format']),
      value('weak-model', 'Weak model', 'Model used for commits and history summarization', 'model', ['--weak-model']),
      value('editor-model', 'Editor model', 'Model used for editor tasks', 'model', ['--editor-model']),
      value('file', 'Editable files', 'Files added to the editable chat context', 'context', ['--file'], 'path-list', { argvStyle: 'repeat' }),
      value('read', 'Read-only files', 'Files added as read-only context', 'context', ['--read'], 'path-list', { argvStyle: 'repeat' }),
      value('lint-command', 'Lint command', 'Command Aider runs to lint changes', 'tools', ['--lint-cmd']),
      value('test-command', 'Test command', 'Command Aider runs for tests', 'tools', ['--test-cmd']),
      value('map-tokens', 'Repository map tokens', 'Token budget for the repository map', 'context', ['--map-tokens'], 'number'),
      value('map-refresh', 'Repository map refresh', 'When Aider refreshes its repository map', 'context', ['--map-refresh'], 'enum', { values: ['auto', 'always', 'files', 'manual'] }),
      value('max-history-tokens', 'History token limit', 'Soft limit before chat-history summarization', 'session', ['--max-chat-history-tokens'], 'number'),
      flag('architect', 'Architect mode', 'Use architect/editor two-stage changes', 'mode', ['--architect']),
      flag('dry-run', 'Dry run', 'Analyze without modifying files', 'safety', ['--dry-run']),
      flag('no-git', 'Disable Git integration', 'Do not inspect or modify Git state', 'safety', ['--no-git']),
      flag('no-auto-commits', 'Disable auto commits', 'Do not automatically commit agent changes', 'safety', ['--no-auto-commits']),
      flag('cache-prompts', 'Prompt caching', 'Enable provider prompt caching', 'advanced', ['--cache-prompts']),
    ],
    features: ['architect/ask/code modes', 'lint and test commands', 'repository map', 'voice'],
  },
  goose: {
    options: [
      value('provider', 'Inference provider', 'Provider used for this run', 'model', ['--provider']),
      value('system', 'Additional instructions', 'Additional system instructions for the agent', 'context', ['--system']),
      value('max-tool-repetitions', 'Tool repetition limit', 'Maximum identical consecutive tool calls', 'safety', ['--max-tool-repetitions'], 'number'),
      value('max-turns', 'Maximum turns', 'Maximum autonomous turns without user input', 'safety', ['--max-turns'], 'number'),
      value('container', 'Extension container', 'Run extensions in the selected Docker container', 'safety', ['--container']),
      value('with-extension', 'Stdio extensions', 'Additional stdio extension commands', 'tools', ['--with-extension'], 'string-list', { argvStyle: 'repeat' }),
      value('with-http-extension', 'HTTP extensions', 'Additional Streamable HTTP extension URLs', 'tools', ['--with-streamable-http-extension'], 'string-list', { argvStyle: 'repeat' }),
      value('with-builtin', 'Built-in extensions', 'Built-in extensions enabled for the run', 'tools', ['--with-builtin'], 'string-list'),
      flag('ephemeral', 'Ephemeral session', 'Do not store the Goose session', 'session', ['--no-session'], { requiresNewSession: true }),
    ],
    managers: { mcp: { label: 'Extensions and MCP', manageArgv: ['configure'] }, skills: { label: 'Skills', listArgv: ['skills', 'list'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] } },
    features: ['extensions', 'recipes', 'ACP', 'scheduled recipes', 'session export'],
  },
  amp: {
    options: [
      value('mcp-config', 'MCP configuration', 'Per-turn MCP server configuration', 'tools', ['--mcp-config']),
      flag('fast', 'Fast mode', 'Use Amp Fast mode for this invocation', 'mode', ['--fast']),
      value('plugin-ready-timeout', 'Plugin startup timeout', 'Wait this many seconds for plugins before starting', 'tools', ['--plugin-ready-timeout'], 'number'),
    ],
    managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] } },
    features: ['skills', 'plugins', 'orbs', 'settings layers'],
  },
  antigravity: {
    options: [
      value('agent', 'Agent', 'Agent used for the current session', 'mode', ['--agent']),
      value('add-dir', 'Additional directories', 'Additional directories included in the workspace', 'context', ['--add-dir'], 'path-list', { argvStyle: 'repeat' }),
      value('json-schema', 'Output schema', 'JSON schema string or file for the final result', 'output', ['--json-schema']),
      value('print-timeout', 'Turn timeout', 'Maximum print-mode duration, such as 15m', 'safety', ['--print-timeout']),
      value('project', 'Project', 'Project id or name for this session', 'context', ['--project'], 'string', { requiresNewSession: true }),
      value('mode', 'Execution mode', 'Use edit-accepting or read-only planning behavior', 'mode', ['--mode'], 'enum', { values: ['accept-edits', 'plan'] }),
      flag('sandbox', 'Terminal sandbox', 'Run terminal commands with sandbox restrictions', 'safety', ['--sandbox']),
      flag('disable-skills', 'Disable skills', 'Disable slash-command and skill expansion', 'tools', ['--disable-slash-commands']),
    ],
    managers: {
      mcp: { label: 'MCP servers', listArgv: ['mcp', 'list'], manageArgv: ['mcp'] },
      plugins: { label: 'Plugins', listArgv: ['plugin', 'list'], manageArgv: ['plugin'] },
      agents: { label: 'Agents', listArgv: ['agents'], manageArgv: ['agents'] },
    },
    features: ['skills', 'plugins', 'custom agents', 'remote control', 'sandbox'],
  },
  pi: {
    options: [
      value('provider', 'Inference provider', 'Provider used for this turn', 'model', ['--provider']),
      value('tools', 'Allowed tools', 'Allowlist built-in, extension, and custom tools', 'tools', ['--tools'], 'string-list', { argvStyle: 'csv' }),
      value('exclude-tools', 'Excluded tools', 'Disable matching tool names', 'tools', ['--exclude-tools'], 'string-list', { argvStyle: 'csv' }),
      value('models', 'Model cycle', 'Models available for in-session cycling', 'model', ['--models'], 'string-list', { argvStyle: 'csv' }),
      value('session-dir', 'Session directory', 'Custom directory for native session storage', 'session', ['--session-dir'], 'path', { requiresNewSession: true }),
      value('session-name', 'Session name', 'Name assigned to a new native session', 'session', ['--name'], 'string', { appliesTo: 'start' }),
      flag('no-builtin-tools', 'Disable built-in tools', 'Keep extension tools but disable built-in tools', 'tools', ['--no-builtin-tools']),
      flag('no-tools', 'Disable all tools', 'Start without any tools enabled', 'tools', ['--no-tools']),
      flag('ephemeral', 'Ephemeral session', 'Do not save a native session', 'session', ['--no-session'], { requiresNewSession: true }),
    ],
    managers: { plugins: { label: 'Packages and extensions', listArgv: ['list'], manageArgv: ['config'] } },
    features: ['extensions', 'skills', 'prompt templates', 'provider/model registry'],
  },
  droid: {
    options: [
      value('restrict-tools', 'Restricted tools', 'Allow only the selected tool ids', 'tools', ['--restrict-tools'], 'string-list'),
      value('additional-tools', 'Additional tools', 'Enable tools beyond the defaults', 'tools', ['--additional-tools'], 'string-list'),
      value('disabled-tools', 'Disabled tools', 'Disable selected tool ids', 'tools', ['--disabled-tools'], 'string-list'),
      value('spec-model', 'Specification model', 'Model used during specification planning', 'model', ['--spec-model']),
      value('spec-effort', 'Specification effort', 'Reasoning effort used during specification planning', 'reasoning', ['--spec-reasoning-effort']),
      value('append-system-prompt', 'Additional instructions', 'Append text to Droid’s system prompt', 'context', ['--append-system-prompt']),
      value('append-system-prompt-file', 'Instruction file', 'Append a file to Droid’s system prompt', 'context', ['--append-system-prompt-file'], 'path'),
      flag('spec-mode', 'Specification mode', 'Plan in read-only specification mode before execution', 'mode', ['--use-spec']),
      flag('disable-builtin-skills', 'Disable built-in skills', 'Hide Factory-provided skills while retaining other skill sources', 'tools', ['--disable-builtin-skills']),
      flag('worktree', 'Managed worktree', 'Run in an isolated Droid worktree', 'session', ['--worktree'], { requiresNewSession: true }),
      flag('mission', 'Mission mode', 'Run multi-agent mission orchestration', 'mode', ['--mission']),
    ],
    managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] } },
    features: ['skills', 'custom droids', 'hooks', 'missions', 'auto/spec modes', 'JSON-RPC permission transport'],
  },
  kiro: {
    options: [
      value('agent-engine', 'Agent engine', 'Headless engine version', 'advanced', ['--agent-engine'], 'enum', { values: ['v1', 'v2', 'v3'], requiresNewSession: true }),
      value('trusted-tools', 'Trusted tools', 'Tool categories approved in advance', 'permissions', ['--trust-tools'], 'string-list', { argvStyle: 'csv' }),
      flag('require-mcp-startup', 'Require MCP startup', 'Fail the run if any MCP server cannot start', 'tools', ['--require-mcp-startup']),
    ],
    managers: { mcp: { label: 'MCP servers', listArgv: ['mcp', 'list'], manageArgv: ['mcp'] } },
    features: ['skills', 'custom agents', 'hooks', 'steering', 'powers', 'plan mode'],
  },
  qwen: {
    options: [
      value('approval-mode', 'Approval mode', 'Tool-call approval policy', 'permissions', ['--approval-mode'], 'enum', { values: ['plan', 'default', 'auto-edit', 'auto', 'yolo'] }),
      value('include-directories', 'Additional directories', 'Additional roots included in context', 'context', ['--include-directories'], 'path-list'),
      value('max-session-turns', 'Maximum turns', 'Limit model/tool turns in this run', 'safety', ['--max-session-turns'], 'number'),
      value('max-wall-time', 'Maximum wall time', 'Wall-clock limit such as 10m', 'safety', ['--max-wall-time']),
      value('max-tool-calls', 'Maximum tool calls', 'Cumulative tool-call limit', 'safety', ['--max-tool-calls'], 'number'),
      flag('safe-mode', 'Safe mode', 'Disable context, hooks, extensions, skills, MCP, subagents, and memory', 'safety', ['--safe-mode']),
    ],
    managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] }, skills: { label: 'Skills', manageArgv: ['skills'] } },
    features: ['skills', 'extensions', 'subagents', 'workflows', 'memory', 'plan mode'],
  },
  cline: {
    options: [
      value('provider', 'Inference provider', 'Cline inference provider id', 'model', ['--provider']),
      value('system-prompt', 'System prompt', 'Override the default system prompt', 'context', ['--system']),
      value('auto-approve', 'Auto approve', 'Whether Cline auto-approves tool use', 'permissions', ['--auto-approve'], 'enum', { values: ['true', 'false'], dangerous: true }),
      value('compaction', 'Context compaction', 'Context compaction strategy', 'session', ['--compaction'], 'enum', { values: ['agentic', 'basic', 'off'] }),
      value('retries', 'Retry limit', 'Maximum consecutive mistakes before stopping', 'safety', ['--retries'], 'number'),
      value('timeout', 'Turn timeout', 'Maximum run time in seconds; zero disables the limit', 'safety', ['--timeout'], 'number'),
      value('data-dir', 'Data directory', 'Isolated Cline state directory', 'session', ['--data-dir'], 'path', { requiresNewSession: true }),
      value('hooks-dir', 'Hooks directory', 'Additional runtime hooks directory', 'tools', ['--hooks-dir'], 'path'),
      flag('plan', 'Plan mode', 'Run read-only planning behavior', 'mode', ['--plan']),
      flag('worktree', 'Managed worktree', 'Run in a detached managed worktree', 'session', ['--worktree'], { requiresNewSession: true }),
    ],
    managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] }, skills: { label: 'Skills', manageArgv: ['skill'] }, hooks: { label: 'Hooks', manageArgv: ['hook'] } },
    features: ['skills', 'rules', 'checkpoints', 'plan/act modes', 'schedules'],
  },
  kilo: {
    options: [
      value('agent', 'Agent', 'Agent configuration used for the turn', 'mode', ['--agent']),
      value('title', 'Session title', 'Title assigned to a new native session', 'session', ['--title'], 'string', { appliesTo: 'start' }),
      flag('pure', 'Pure mode', 'Run without external plugins', 'safety', ['--pure']),
      flag('thinking-output', 'Show thinking events', 'Include provider thinking blocks in event output', 'output', ['--thinking']),
      flag('fork-native-session', 'Fork native session', 'Fork before continuing the selected session', 'session', ['--fork'], { appliesTo: 'resume', requiresNewSession: true }),
      flag('cloud-fork', 'Fork cloud session', 'Fetch and fork the selected cloud session locally', 'session', ['--cloud-fork'], { appliesTo: 'resume', requiresNewSession: true }),
      flag('share', 'Share session', 'Publish the native session through Kilo', 'session', ['--share']),
    ],
    managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] } },
    features: ['skills', 'architect/ask/debug/orchestrator modes', 'custom agents'],
  },
  cursor: {
    options: [
      value('mode', 'Execution mode', 'Read-only plan or question mode', 'mode', ['--mode'], 'enum', { values: ['plan', 'ask'] }),
      value('sandbox', 'Sandbox', 'Explicitly enable or disable the Cursor sandbox', 'safety', ['--sandbox'], 'enum', { values: ['enabled', 'disabled'] }),
      value('add-dir', 'Additional directories', 'Additional workspace roots', 'context', ['--add-dir'], 'path-list', { argvStyle: 'repeat' }),
      value('plugin-dir', 'Plugin directories', 'Local plugins loaded for the session', 'tools', ['--plugin-dir'], 'path-list', { argvStyle: 'repeat' }),
      flag('auto-review', 'Auto review', 'Automatically run safe tools and review the rest', 'permissions', ['--auto-review']),
      flag('approve-mcps', 'Approve MCP servers', 'Automatically approve configured MCP servers', 'permissions', ['--approve-mcps'], { dangerous: true }),
      flag('trust', 'Trust workspace', 'Trust the current workspace without prompting', 'permissions', ['--trust'], { dangerous: true }),
      flag('force', 'Force commands', 'Allow commands unless explicitly denied', 'permissions', ['--force'], { dangerous: true }),
      flag('worktree', 'Managed worktree', 'Start in an isolated Cursor worktree', 'session', ['--worktree'], { requiresNewSession: true }),
    ],
    managers: { mcp: { label: 'MCP servers', listArgv: ['mcp', 'list'], manageArgv: ['mcp'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] } },
    features: ['plugins', 'rules', 'worktrees', 'plan/ask modes'],
  },
  crush: {
    options: [
      value('data-dir', 'Data directory', 'Custom Crush state directory', 'session', ['--data-dir'], 'path', { requiresNewSession: true }),
      value('small-model', 'Small model', 'Model used for lightweight tasks', 'model', ['--small-model']),
    ],
    features: ['MCP', 'LSP', 'provider/model configuration', 'tool allow/deny rules'],
  },
  hermes: {
    options: [
      value('provider', 'Inference provider', 'Override the inference provider', 'model', ['--provider']),
      value('toolsets', 'Toolsets', 'Comma-separated toolsets enabled for the turn', 'tools', ['--toolsets']),
      value('skills', 'Preloaded skills', 'Skills loaded for this session', 'tools', ['--skills'], 'string-list'),
      flag('worktree', 'Isolated worktree', 'Run in an isolated Git worktree', 'session', ['--worktree'], { requiresNewSession: true }),
      flag('safe-mode', 'Safe mode', 'Disable user config, rules, plugins, and MCP', 'safety', ['--safe-mode']),
      flag('ignore-user-config', 'Ignore user config', 'Use built-in defaults while retaining credentials', 'safety', ['--ignore-user-config']),
      flag('ignore-rules', 'Ignore rules', 'Skip AGENTS.md, memory, and preloaded skills', 'safety', ['--ignore-rules']),
      flag('yolo', 'Bypass approvals', 'Bypass dangerous-command approvals', 'permissions', ['--yolo'], { dangerous: true }),
    ],
    managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] }, skills: { label: 'Skills', manageArgv: ['skills'] }, plugins: { label: 'Plugins', manageArgv: ['plugins'] }, tools: { label: 'Tools', manageArgv: ['tools'] }, hooks: { label: 'Hooks', manageArgv: ['hooks'] } },
    features: ['skills', 'bundles', 'plugins', 'hooks', 'memory', 'fallback providers', 'toolsets'],
  },
  command: {
    options: [
      value('max-turns', 'Maximum turns', 'Maximum turns in print mode', 'safety', ['--max-turns'], 'number'),
      value('add-dir', 'Additional directories', 'Additional directories in workspace context', 'context', ['--add-dir'], 'path-list', { argvStyle: 'repeat' }),
      value('mod', 'Mods', 'Mod files or directories loaded for this session', 'tools', ['--mod'], 'path-list', { argvStyle: 'repeat' }),
      value('mod-option', 'Mod options', 'Mod-declared name=value settings', 'tools', ['--mod-option'], 'string-list', { argvStyle: 'repeat' }),
      value('skill', 'Skill paths', 'Additional skill directories', 'tools', ['--skill'], 'path-list', { argvStyle: 'repeat' }),
      flag('plan', 'Plan mode', 'Start in read-only planning mode', 'mode', ['--plan']),
      flag('local-only', 'Local-only inference', 'Use BYOK providers without Command Code traffic', 'safety', ['--local-only']),
      flag('trust', 'Trust project', 'Skip the initial workspace trust prompt', 'permissions', ['--trust'], { dangerous: true }),
      flag('tools-all', 'Enable all tools', 'Enable tools normally withheld in headless mode', 'tools', ['--tools-all'], { dangerous: true }),
      flag('no-skills', 'Disable skills', 'Skip automatic skill discovery', 'tools', ['--no-skills']),
      flag('worktree', 'Managed worktree', 'Run in an isolated managed worktree', 'session', ['--worktree'], { requiresNewSession: true }),
      flag('ephemeral', 'Ephemeral session', 'Do not persist the native session', 'session', ['--no-session'], { requiresNewSession: true }),
    ],
    managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] }, skills: { label: 'Skills', manageArgv: ['skills'] }, plugins: { label: 'Mods', manageArgv: ['mods'] } },
    features: ['skills', 'mods', 'taste learning', 'MCP', 'managed worktrees', 'plan mode'],
  },
};

/** Provider-native switches owned by the normalized permission selector, plus
 * ids retired from an adapter. Both are declared ON the entry
 * (`normalizedPermissionOptionIds`, `retiredOptionIds`) so there is no second
 * per-vendor table to drift. Hiding the live aliases prevents a stored raw
 * option from contradicting Ask, Bypass, or Auto; ignoring both kinds in
 * appendDeclaredHarnessOptions keeps an upgraded session's next turn working. */
function ignoredStoredOptionIds(harness: AiLocalHarnessDefinition): ReadonlySet<string> {
  return new Set([...(harness.normalizedPermissionOptionIds ?? []), ...(harness.retiredOptionIds ?? [])]);
}

export function localHarnessCapabilityManifest(harness: AiLocalHarnessDefinition): AiHarnessCapabilityManifest {
  const declared = AI_LOCAL_HARNESS_CAPABILITIES[harness.command] ?? { options: [] };
  const normalizedPermissionIds = new Set(harness.normalizedPermissionOptionIds ?? []);
  const normalized: AiHarnessOptionDefinition[] = [];
  if (harness.modelArgvPrefix) normalized.push(value('model', 'Model', 'Provider model id or alias', 'model', harness.modelArgvPrefix));
  if (harness.workspaceArgvPrefix) normalized.push(value('workspace', 'Workspace', 'Working directory for the native agent', 'context', harness.workspaceArgvPrefix, 'path', { requiresNewSession: true }));
  if (harness.effortArgvPrefix) normalized.push(value('effort', 'Reasoning effort', 'Provider-native reasoning level', 'reasoning', harness.effortArgvPrefix, 'enum', { values: harness.effortValues ?? [] }));
  if (harness.permissionModes?.length) normalized.push({ id: 'permissions', label: 'Permissions', description: 'Normalized ClikCode approval behavior', category: 'permissions', kind: 'enum', values: harness.permissionModes });
  return { ...declared, options: [...normalized, ...declared.options.filter((option) => !normalizedPermissionIds.has(option.id))] };
}

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
  /** Provider-native values validated against the selected capability manifest. */
  options?: Readonly<Record<string, unknown>>;
}

function appendDeclaredHarnessOptions(
  argv: string[], harness: AiLocalHarnessDefinition, values: Readonly<Record<string, unknown>> | undefined, resumed: boolean,
): void {
  if (!values) return;
  const options = new Map(localHarnessCapabilityManifest(harness).options.map((option) => [option.id, option]));
  const normalizedPermissionIds = ignoredStoredOptionIds(harness);
  for (const [id, raw] of Object.entries(values)) {
    const option = options.get(id);
    if (!option && normalizedPermissionIds.has(id)) continue;
    if (!option) throw new Error(`${harness.displayName} does not declare option "${id}"`);
    if (!option.argv || id === 'model' || id === 'workspace' || id === 'effort' || id === 'permissions') continue;
    if (option.appliesTo === 'start' && resumed) continue;
    if (option.appliesTo === 'resume' && !resumed) continue;
    const append = (...parts: string[]): void => {
      if (option.argvPlacement === 'root') argv.unshift(...parts);
      else argv.push(...parts);
    };
    if (option.kind === 'boolean') {
      if (raw === true) append(...option.argv);
      else if (raw !== false && raw !== undefined) throw new Error(`${option.label} must be true or false`);
      continue;
    }
    const items = Array.isArray(raw) ? raw : [raw];
    const renderedItems = items.map((item) => String(item).trim()).filter(Boolean);
    for (const rendered of renderedItems) {
      if (option.values?.length && !option.values.includes(rendered)) throw new Error(`${option.label} must be one of ${option.values.join(', ')}`);
    }
    if (option.argvStyle === 'csv') {
      if (renderedItems.length) append(...option.argv, renderedItems.join(','));
      continue;
    }
    for (const rendered of renderedItems) {
      if (option.argvStyle === 'config') append(...option.argv, `${option.configKey}=${JSON.stringify(rendered)}`);
      else append(...option.argv, rendered);
    }
  }
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
    const mapping = harness.permissionArgv?.[input.permissionMode];
    if (!mapping) throw new Error(`${harness.displayName} has no argv mapping for ${input.permissionMode} permissions`);
    if (mapping.placement === 'root') argv.unshift(...mapping.argv);
    else argv.push(...mapping.argv);
  }
  appendDeclaredHarnessOptions(argv, harness, input.options, resumed);
  if (harness.imageArgvPrefix) for (const image of input.images ?? []) {
    if (harness.imageArgvStyle === 'concatenated') {
      const prefix = harness.imageArgvPrefix.join('');
      argv.push(`${prefix}${image}`);
    } else argv.push(...harness.imageArgvPrefix, image);
  }
  if (harness.turn.promptInput === 'stdin') {
    const placeholder = harness.turn.stdinArgv ?? ['-'];
    if (placeholder.length && harness.turn.promptArgvPrefix) argv.push(...harness.turn.promptArgvPrefix);
    argv.push(...placeholder);
    return argv;
  }
  if (harness.turn.promptArgvPrefix) argv.push(...harness.turn.promptArgvPrefix);
  argv.push(...guardedPromptArgv(harness.turn, input.prompt));
  return argv;
}

/** Keep a prompt that begins with `-` from being parsed as a vendor flag.
 * `--` is only correct for a positional prompt (after a flag such as `-p` it
 * would BECOME the flag's value), and only where the entry declares the vendor
 * parser honors it; everywhere else one leading space is a value to every
 * argv parser. The prompt is never otherwise altered. */
export function guardedPromptArgv(turn: Pick<AiHarnessTurnDefinition, 'promptGuard' | 'promptArgvPrefix'>, prompt: string): string[] {
  if (!prompt.startsWith('-')) return [prompt];
  if (turn.promptGuard === 'double-dash' && !turn.promptArgvPrefix?.length) return ['--', prompt];
  return [` ${prompt}`];
}

/** True when this prompt cannot safely travel in argv for this harness. */
export function promptExceedsArgvLimit(harness: AiLocalHarnessDefinition, prompt: string): boolean {
  if (harness.turn?.promptInput === 'stdin') return false;
  return new TextEncoder().encode(prompt).length > maxPromptArgvBytes;
}

export interface AiHarnessAcpLaunchInput {
  model?: string | null;
  effort?: string | null;
  permissionMode?: AiHarnessPermissionMode;
}

/** Spawn contract for the shared ACP client, built only from declarations.
 * `ask` adds nothing: the protocol's own permission requests implement it. */
export interface AiHarnessAcpLaunch {
  binary: string;
  /** Complete spawn argv: `modeArgv` and `optionArgv` in the declared order. */
  argv: string[];
  /** The declared ACP mode argv alone. */
  modeArgv: string[];
  /** Model / effort / permission flags alone, for a client that places them itself. */
  optionArgv: string[];
  optionPlacement: 'before' | 'after';
  experimental: boolean;
}

export function harnessAcpLaunch(harness: AiLocalHarnessDefinition, input: AiHarnessAcpLaunchInput = {}): AiHarnessAcpLaunch | undefined {
  const acp = harness.acp;
  if (!acp) return undefined;
  const options: string[] = [];
  if (input.model && harness.modelArgvPrefix) options.push(...harness.modelArgvPrefix, input.model);
  const effortPrefix = acp.effortArgvPrefix ?? harness.effortArgvPrefix;
  if (input.effort && effortPrefix) options.push(...effortPrefix, harness.effortConfigKey && !acp.effortArgvPrefix ? `${harness.effortConfigKey}="${input.effort}"` : input.effort);
  if (input.permissionMode === 'bypass' || input.permissionMode === 'auto') {
    options.push(...(acp.permissionArgv?.[input.permissionMode]
      ?? (harness.permissionModes?.includes(input.permissionMode) ? harness.permissionArgv?.[input.permissionMode]?.argv : undefined) ?? []));
  }
  const optionPlacement = acp.optionPlacement ?? 'before';
  return {
    binary: acp.binary ?? harness.binary,
    argv: optionPlacement === 'after' ? [...acp.argv, ...options] : [...options, ...acp.argv],
    modeArgv: [...acp.argv], optionArgv: options, optionPlacement, experimental: acp.experimental === true,
  };
}

/** The transport to use for THIS turn. An experimental ACP declaration never
 * wins over a proven one-shot contract, and ACP carries no image attachments,
 * so both fall back to the `turn` contract when one exists. */
export function harnessTurnTransport(harness: AiLocalHarnessDefinition, input: { hasImages?: boolean; allowExperimentalAcp?: boolean } = {}): AiHarnessTransport {
  if (harness.transport === 'codex-app-server') return 'codex-app-server';
  const cli: AiHarnessTransport = harness.turn?.output === 'text' ? 'text-cli' : 'structured-cli';
  if (!harness.acp) return harness.turn ? cli : harness.transport;
  if (!harness.turn) return 'acp';
  const preferred = harness.transport === 'acp' || input.allowExperimentalAcp === true;
  const usable = !harness.acp.experimental || input.allowExperimentalAcp === true;
  return preferred && usable && !input.hasImages ? 'acp' : cli;
}

/** A harness can serve a ClikCode conversation through either contract. */
export function harnessCanRunTurns(harness: AiLocalHarnessDefinition): boolean {
  return harness.surface === 'terminal' && Boolean(harness.turn || harness.acp);
}

const TIER_ORDER: Readonly<Record<AiHarnessTier, number>> = { primary: 0, more: 1, experimental: 2 };
/** Picker order: tier first, catalog order within a tier. */
export function harnessTierRank(harness: AiLocalHarnessDefinition): number {
  return TIER_ORDER[harness.tier] ?? TIER_ORDER.experimental;
}

export interface AiCustomAcpHarnessInput {
  command: string;
  binary: string;
  argv: readonly string[];
  displayName?: string;
  provider?: string;
  memoryFile?: AiHarnessMemoryFile;
}

/** Broker ANY Agent Client Protocol agent with zero vendor code: a Zed
 * registry agent, `claude-code-acp`, `codex-acp`, an in-house agent. The result
 * is an ordinary definition, so every catalog-driven code path applies. It has
 * no one-shot `turn`, no login argv and no permission flags: the protocol
 * carries prompts, sessions and approvals itself. */
export function customAcpHarness(definition: AiCustomAcpHarnessInput): AiLocalHarnessDefinition {
  const command = definition.command.trim().replace(/^\//, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(command)) throw new Error(`Custom ACP harness command "${definition.command}" must be a simple lowercase name`);
  if (!definition.binary.trim()) throw new Error(`Custom ACP harness "${command}" needs a binary`);
  return {
    command,
    provider: definition.provider?.trim().toLowerCase() || `acp:${command}`,
    displayName: definition.displayName?.trim() || command,
    surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'text',
    memoryFile: definition.memoryFile ?? 'AGENTS.md', nativeSlashPassthrough: false,
    localAuth: ['vendor-cli'], binary: definition.binary.trim(),
    acp: { argv: [...definition.argv] },
  };
}

let customHarnesses: readonly AiLocalHarnessDefinition[] = [];

/** Replace the user-configured harness list consulted after the catalog. A
 * custom definition can never shadow a built-in command or provider, and every
 * one must be able to run a turn. Returns the definitions actually registered. */
export function registerCustomHarnesses(definitions: readonly AiLocalHarnessDefinition[]): readonly AiLocalHarnessDefinition[] {
  const accepted: AiLocalHarnessDefinition[] = [];
  for (const definition of definitions) {
    const shadowsBuiltIn = AI_LOCAL_HARNESSES.some((item) => item.command === definition.command || item.provider === definition.provider);
    const duplicate = accepted.some((item) => item.command === definition.command || item.provider === definition.provider);
    if (shadowsBuiltIn || duplicate || !harnessCanRunTurns(definition)) continue;
    accepted.push(definition);
  }
  customHarnesses = accepted;
  return customHarnesses;
}

/** Built-in catalog followed by registered custom harnesses. */
export function allLocalHarnesses(): readonly AiLocalHarnessDefinition[] {
  return customHarnesses.length ? [...AI_LOCAL_HARNESSES, ...customHarnesses] : AI_LOCAL_HARNESSES;
}

export function localHarnessForCommand(command: string): AiLocalHarnessDefinition | undefined {
  const normalized = command.trim().replace(/^\//, '').toLowerCase();
  return allLocalHarnesses().find((item) => item.command === normalized);
}

export function localHarnessForProvider(provider: string): AiLocalHarnessDefinition | undefined {
  const normalized = provider.trim().toLowerCase();
  return allLocalHarnesses().find((item) => item.provider === normalized);
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
  /** Optional per-agent capability names (e.g. ['jev']) used to control dynamic routing. */
  agentCapabilities?: string[];
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

/** Async variant that may consult an external decision maker when configured.
 *  Returns the same shape as `selectLocalHarnessRoute`. */
export async function selectLocalHarnessRouteAsync(
  accounts: readonly AiHarnessAccount[],
  candidates: readonly (AiRouterCandidate & { accountId: string })[],
  request: AiHarnessRouteRequest,
): Promise<AiHarnessRouteSelection> {
  if (request.route === 'gateway') {
    return { route: 'gateway', reason: 'gateway route explicitly selected' };
  }

  const ready = new Set(
    accounts
      .filter((account) => account.status === 'ready' && (!request.accountId || account.id === request.accountId))
      .map((account) => account.id),
  );
  const eligible = candidates.filter((candidate) => ready.has(candidate.accountId));
  // use dynamic, pluggable selector; pass agent capabilities (if any) so the
  // router can honor per-agent toggles like `jev` before consulting external
  // decision-makers.
  const selected = await selectRouterCandidateDynamic(
    eligible,
    request.strategy,
    request.preferredModel,
    request.estimatedPromptTokens,
    request.agentCapabilities,
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
