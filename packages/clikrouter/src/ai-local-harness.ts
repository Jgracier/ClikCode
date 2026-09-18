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
  argvStyle?: 'value' | 'flag' | 'repeat' | 'config';
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
    discoverFormat?: 'json' | 'json-lines' | 'text' | 'numbered-list';
  };
}

export const AI_LOCAL_HARNESS_ADAPTER_VERSION = 4;

export const AI_LOCAL_HARNESSES: readonly AiLocalHarnessDefinition[] = [
  { command: 'claude', provider: 'anthropic', displayName: 'Claude Code', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'claude', npmPackage: '@anthropic-ai/claude-code', loginArgv: ['auth', 'login'], statusArgv: ['auth', 'status'], logoutArgv: ['auth', 'logout'], modelArgvPrefix: ['--model'], effortArgvPrefix: ['--effort'], permissionModes: ['ask', 'bypass', 'auto'], profileEnv: 'CLAUDE_CONFIG_DIR', turn: { startArgv: ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
  { command: 'codex', provider: 'openai', displayName: 'Codex', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'codex', npmPackage: '@openai/codex', loginArgv: ['login'], statusArgv: ['login', 'status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cd'], effortArgvPrefix: ['--config'], effortConfigKey: 'model_reasoning_effort', permissionModes: ['ask', 'bypass', 'auto'], imageArgvPrefix: ['--image'], profileEnv: 'CODEX_HOME', turn: { startArgv: ['exec', '--json', '--skip-git-repo-check'], resumeArgv: ['exec', 'resume'], resumeIdSuffix: ['--json', '--skip-git-repo-check'], promptInput: 'stdin', output: 'json-lines', responseFields: ['text'], resumeSupportsWorkspaceSelector: false }, session: { resumeIdPrefix: ['resume'], continueArgv: ['resume', '--last'] } },
  // No loginArgv value actually performs a login non-interactively -- Gemini
  // CLI's real auth commands (/auth, /auth login, /auth logout) are slash
  // commands typed inside its own interactive session, not CLI flags
  // (verified: even the official CLI Reference docs only cover in-TUI
  // commands, nothing for a scriptable `gemini auth login`). An empty argv
  // still matters here, though: ClikCode's login flow gates entirely on
  // `loginArgv` being present at all, and without it the suspend/resume
  // handoff to a real interactive terminal never triggers for this harness.
  // With it, a fresh install (or a future statusArgv-based check) drops the
  // user into gemini's own interactive session where they can type
  // `/auth login` themselves, instead of ClikCode silently assuming
  // "logged in" and only surfacing the problem as a raw turn failure.
  { command: 'gemini', provider: 'google', displayName: 'Gemini CLI', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'gemini', npmPackage: '@google/gemini-cli', loginArgv: [], modelArgvPrefix: ['--model'], permissionModes: ['ask', 'bypass'], turn: { startArgv: ['--output-format', 'stream-json'], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['-p'], output: 'json-lines', responseFields: ['response', 'result', 'text', 'content'] }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--resume', 'latest'], discoverArgv: ['--list-sessions'], discoverFormat: 'numbered-list' } },
  { command: 'opencode', provider: 'opencode', displayName: 'OpenCode', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'opencode', loginArgv: ['auth', 'login'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], workspaceArgvPrefix: ['--dir'], effortArgvPrefix: ['--variant'], permissionModes: ['ask', 'bypass'], turn: { startArgv: ['run', '--format', 'json'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] }, session: { resumeIdPrefix: ['--session'], continueArgv: ['--continue'], discoverArgv: ['session', 'list'], discoverFormat: 'text' } },
  { command: 'copilot', provider: 'github-copilot', displayName: 'GitHub Copilot', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'copilot', npmPackage: '@github/copilot', loginArgv: ['login'], statusArgv: ['status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], permissionModes: ['ask', 'bypass'], profileEnv: 'COPILOT_HOME', turn: { startArgv: ['-s'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session-id'], promptArgvPrefix: ['-p'], output: 'text' }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session-id'], continueArgv: ['--continue'] } },
  { command: 'aider', provider: 'aider', displayName: 'Aider', surface: 'terminal', localAuth: ['api-key', 'vendor-cli'], binary: 'aider', modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['--list-models', ''], permissionModes: ['ask', 'bypass'], turn: { startArgv: [], createIdPrefix: ['--chat-history-file'], resumeIdPrefix: ['--chat-history-file'], resumeIdSuffix: ['--restore-chat-history'], promptArgvPrefix: ['--message'], output: 'text' }, session: { idKind: 'history-file', createIdPrefix: ['--chat-history-file'], resumeIdPrefix: ['--chat-history-file'], resumeIdSuffix: ['--restore-chat-history'] } },
  { command: 'goose', provider: 'goose', displayName: 'Goose', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'goose', turn: { startArgv: ['run'], resumeIdPrefix: ['--resume', '--session-id'], promptArgvPrefix: ['--text'], output: 'text' }, session: { resumeIdPrefix: ['session', '--resume', '--session-id'], discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json' } },
  { command: 'amp', provider: 'amp', displayName: 'Amp', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'amp', npmPackage: '@ampcode/cli', loginArgv: ['login'], versionArgv: ['version'], turn: { startArgv: [], resumeArgv: ['threads', 'continue'], promptArgvPrefix: ['-x'], output: 'text' }, session: { resumeIdPrefix: ['threads', 'continue'] } },
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
  { command: 'antigravity', provider: 'antigravity', displayName: 'Antigravity CLI', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'agy', loginArgv: ['-p', 'hi', '--output-format', 'json'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], effortArgvPrefix: ['--effort'], permissionModes: ['ask', 'bypass'], profileEnv: 'HOME', turn: { startArgv: ['--output-format', 'stream-json'], promptArgvPrefix: ['-p'], resumeIdPrefix: ['--conversation'], output: 'json-lines', responseFields: ['text', 'result', 'response'] }, session: { resumeIdPrefix: ['--conversation'], continueArgv: ['--continue'] } },
  { command: 'pi', provider: 'pi', displayName: 'Pi Coding Agent', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'pi', npmPackage: '@earendil-works/pi-coding-agent', modelArgvPrefix: ['--model'], effortArgvPrefix: ['--thinking'], profileEnv: 'PI_CODING_AGENT_DIR', turn: { startArgv: ['-p', '--mode', 'json'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session'], continueArgv: ['--continue'] } },
  { command: 'droid', provider: 'factory', displayName: 'Factory Droid', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'droid', modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--reasoning-effort'], permissionModes: ['ask', 'bypass', 'auto'], turn: { startArgv: ['exec', '--output-format', 'json'], resumeIdPrefix: ['--resume'], output: 'json', responseFields: ['result', 'response', 'text'] }, session: { resumeIdPrefix: ['--resume'] } },
  { command: 'kiro', provider: 'kiro', displayName: 'Kiro CLI', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'kiro-cli', launchArgv: ['chat'], permissionModes: ['ask', 'bypass'], turn: { startArgv: ['chat', '--no-interactive'], resumeIdPrefix: ['--resume-id'], output: 'text' }, session: { resumeIdPrefix: ['chat', '--resume-id'], continueArgv: ['chat', '--resume'] } },
  { command: 'qwen', provider: 'qwen', displayName: 'Qwen Code', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'qwen', modelArgvPrefix: ['--model'], permissionModes: ['ask', 'bypass', 'auto'], profileEnv: 'QWEN_HOME', turn: { startArgv: ['-p', '--output-format', 'stream-json', '--include-partial-messages'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'], discoverArgv: ['sessions', 'list', '--json'], discoverFormat: 'json-lines' } },
  { command: 'cline', provider: 'cline', displayName: 'Cline CLI', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'cline', npmPackage: 'cline', loginArgv: ['auth'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--thinking'], permissionModes: ['ask', 'bypass'], profileEnv: 'CLINE_DATA_DIR', turn: { startArgv: ['--json'], resumeIdPrefix: ['--id'], output: 'json-lines', responseFields: ['text', 'content', 'result'] }, session: { resumeIdPrefix: ['--id'] } },
  { command: 'roo', provider: 'roo', displayName: 'Roo Code', surface: 'editor-extension', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'roo' },
  { command: 'kilo', provider: 'kilo', displayName: 'Kilo Code CLI', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'kilo', npmPackage: '@kilocode/cli', loginArgv: ['auth', 'login'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], permissionModes: ['ask', 'bypass'], turn: { startArgv: ['run', '--format', 'json'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] }, session: { resumeIdPrefix: ['--session'], continueArgv: ['--continue'], discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json' } },
  { command: 'cursor', provider: 'cursor', displayName: 'Cursor Agent', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'cursor-agent', loginArgv: ['login'], statusArgv: ['status', '--format', 'json'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], workspaceArgvPrefix: ['--workspace'], permissionModes: ['ask', 'bypass', 'auto'], turn: { startArgv: ['-p', '--output-format', 'stream-json', '--stream-partial-output'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { createSessionArgv: ['create-chat'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
  { command: 'windsurf', provider: 'windsurf', displayName: 'Windsurf Cascade', surface: 'editor-extension', localAuth: ['oauth', 'vendor-cli'], binary: 'windsurf' },
  { command: 'crush', provider: 'crush', displayName: 'Crush', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'crush', npmPackage: '@charmland/crush', permissionModes: ['ask', 'bypass'], turn: { startArgv: ['run'], resumeIdPrefix: ['--session'], output: 'text' }, session: { resumeIdPrefix: ['--session'], continueArgv: ['--continue'], discoverArgv: ['session', 'list', '--json'], discoverFormat: 'json' } },
  { command: 'hermes', provider: 'nous', displayName: 'Hermes', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'hermes', loginArgv: ['login'], statusArgv: ['status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--in'], effortArgvPrefix: ['--reasoning'], permissionModes: ['ask', 'bypass'], profileEnv: 'HERMES_HOME', turn: { startArgv: ['chat', '--oneshot', '--quiet'], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['--query'], output: 'text' }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--continue'], discoverArgv: ['sessions', 'list', '--limit', '50'], discoverFormat: 'text' } },
  { command: 'command', provider: 'command-code', displayName: 'Command Code', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'cmdc', npmPackage: 'command-code', loginArgv: ['login'], statusArgv: ['status', '--json'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], effortArgvPrefix: ['--effort'], permissionModes: ['ask', 'bypass'], profileEnv: 'HOME', turn: { startArgv: ['--print', '--output-format', 'json', '--skip-onboarding', '--no-auto-update'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
];

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
      value('tools', 'Built-in tools', 'Choose the built-in tools available to the session', 'tools', ['--tools'], 'string-list'),
      value('allowed-tools', 'Allowed tools', 'Tool patterns allowed without prompting', 'permissions', ['--allowed-tools'], 'string-list'),
      value('disallowed-tools', 'Denied tools', 'Tool patterns that must not run', 'permissions', ['--disallowed-tools'], 'string-list'),
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
  gemini: {
    options: [
      value('approval-mode', 'Approval mode', 'Tool-call approval policy', 'permissions', ['--approval-mode'], 'enum', { values: ['default', 'auto_edit', 'yolo', 'plan'] }),
      value('allowed-tools', 'Allowed tools', 'Tools that bypass confirmation', 'permissions', ['--allowed-tools'], 'string-list'),
      value('allowed-mcp-servers', 'Allowed MCP servers', 'MCP servers enabled for this session', 'tools', ['--allowed-mcp-server-names'], 'string-list'),
      value('include-directories', 'Additional directories', 'Additional directories included in context', 'context', ['--include-directories'], 'path-list'),
      flag('safe-mode', 'Safe mode', 'Disable customizations and external extensions', 'safety', ['--safe-mode']),
    ],
    managers: { mcp: { label: 'MCP servers', listArgv: ['mcp', 'list'], manageArgv: ['mcp'] }, plugins: { label: 'Extensions', listArgv: ['extensions', 'list'], manageArgv: ['extensions'] } },
    features: ['skills', 'agents', 'extensions', 'custom commands', 'memory'],
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
      value('add-dir', 'Additional directories', 'Trusted roots and their skills/agents', 'context', ['--add-dir'], 'path-list', { argvStyle: 'repeat' }),
      value('additional-mcp-config', 'Additional MCP config', 'Per-session MCP JSON or @file', 'tools', ['--additional-mcp-config']),
      value('allow-tool', 'Allowed tools', 'Tool or MCP permission patterns', 'permissions', ['--allow-tool'], 'string-list', { argvStyle: 'repeat' }),
      value('deny-tool', 'Denied tools', 'Tool or MCP denial patterns', 'permissions', ['--deny-tool'], 'string-list', { argvStyle: 'repeat' }),
      flag('allow-all', 'Allow everything', 'Allow all tools, paths, and URLs', 'permissions', ['--allow-all'], { dangerous: true }),
    ],
    managers: { mcp: { label: 'MCP servers', listArgv: ['mcp', 'list', '--json'], manageArgv: ['mcp'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] }, skills: { label: 'Skills', manageArgv: ['skill'] }, agents: { label: 'Instructions and agents', manageArgv: ['instruction'] } },
    features: ['skills', 'custom agents', 'hooks', 'plugins', 'built-in GitHub MCP'],
  },
  aider: { options: [], features: ['architect/ask/code modes', 'lint and test commands', 'repository map', 'voice'] },
  goose: { options: [], managers: { mcp: { label: 'Extensions and MCP', manageArgv: ['configure'] } }, features: ['extensions', 'recipes', 'tool permissions'] },
  amp: { options: [value('mcp-config', 'MCP configuration', 'Per-turn MCP server configuration', 'tools', ['--mcp-config'])], managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] } }, features: ['skills', 'plugins', 'orbs', 'settings layers'] },
  pi: { options: [], features: ['extensions', 'skills', 'prompt templates', 'provider/model registry'] },
  droid: { options: [], managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] } }, features: ['skills', 'custom droids', 'hooks', 'missions', 'auto/spec modes'] },
  kiro: { options: [], managers: { mcp: { label: 'MCP servers', listArgv: ['mcp', 'list'], manageArgv: ['mcp'] } }, features: ['skills', 'custom agents', 'hooks', 'steering', 'powers', 'plan mode'] },
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
    ],
    managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] } },
    features: ['skills', 'rules', 'checkpoints', 'plan/act modes', 'schedules'],
  },
  kilo: { options: [], managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] } }, features: ['skills', 'architect/ask/debug/orchestrator modes', 'custom agents'] },
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
  crush: { options: [], features: ['MCP', 'LSP', 'provider/model configuration'] },
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
  command: { options: [], features: ['commands', 'MCP', 'provider settings'] },
  roo: { options: [], features: ['editor extension only'] },
  windsurf: { options: [], features: ['editor extension only'] },
};

/** Provider-native switches now owned by the normalized permission selector.
 * Hiding these aliases prevents a stored raw option from contradicting Ask,
 * Bypass, or Auto. Stale state is ignored in appendDeclaredHarnessOptions so
 * upgrading an existing ClikCode session does not make its next turn fail. */
const NORMALIZED_PERMISSION_OPTION_IDS: Readonly<Record<string, readonly string[]>> = {
  gemini: ['approval-mode'],
  opencode: ['auto-approve'],
  copilot: ['allow-all'],
  qwen: ['approval-mode'],
  cline: ['auto-approve'],
  cursor: ['auto-review', 'force'],
  hermes: ['yolo'],
};

const EFFORT_VALUES: Readonly<Record<string, readonly string[]>> = {
  // Confirmed directly from `agy --help`'s own text: "Reasoning effort for
  // the current CLI session (low|medium|high)".
  antigravity: ['low', 'medium', 'high'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  opencode: ['minimal', 'low', 'medium', 'high', 'max'],
  pi: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  droid: ['low', 'medium', 'high', 'xhigh'],
  cline: ['low', 'medium', 'high'],
  hermes: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  command: ['low', 'medium', 'high'],
};

export function localHarnessCapabilityManifest(harness: AiLocalHarnessDefinition): AiHarnessCapabilityManifest {
  const declared = AI_LOCAL_HARNESS_CAPABILITIES[harness.command] ?? { options: [] };
  const normalizedPermissionIds = new Set(NORMALIZED_PERMISSION_OPTION_IDS[harness.command] ?? []);
  const normalized: AiHarnessOptionDefinition[] = [];
  if (harness.modelArgvPrefix) normalized.push(value('model', 'Model', 'Provider model id or alias', 'model', harness.modelArgvPrefix));
  if (harness.workspaceArgvPrefix) normalized.push(value('workspace', 'Workspace', 'Working directory for the native agent', 'context', harness.workspaceArgvPrefix, 'path', { requiresNewSession: true }));
  if (harness.effortArgvPrefix) normalized.push(value('effort', 'Reasoning effort', 'Provider-native reasoning level', 'reasoning', harness.effortArgvPrefix, 'enum', { values: EFFORT_VALUES[harness.command] ?? [] }));
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
  const normalizedPermissionIds = new Set(NORMALIZED_PERMISSION_OPTION_IDS[harness.command] ?? []);
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
    for (const item of items) {
      const rendered = String(item).trim();
      if (!rendered) continue;
      if (option.values?.length && !option.values.includes(rendered)) throw new Error(`${option.label} must be one of ${option.values.join(', ')}`);
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
    if (harness.command === 'codex') {
      const permissionArgs = input.permissionMode === 'ask'
        ? ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
        : input.permissionMode === 'bypass'
          ? ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']
          : ['--approve-for-me'];
      // Approval policy is a root Codex option (not an `exec` option), so the
      // whole permission profile must precede `exec`. Keeping sandbox and
      // approval together also gives create and resume identical semantics.
      argv.unshift(...permissionArgs);
    } else if (harness.command === 'claude') {
      const mode = input.permissionMode === 'ask' ? 'manual' : input.permissionMode === 'bypass' ? 'bypassPermissions' : 'auto';
      argv.push('--permission-mode', mode, '--permission-prompts', 'none');
      if (input.permissionMode === 'bypass') argv.push('--allow-dangerously-skip-permissions');
    } else if (harness.command === 'opencode') {
      // OpenCode's unflagged default asks; --auto bypasses prompts that are
      // not explicitly denied. It has no independent auto-reviewer mode.
      if (input.permissionMode === 'bypass') argv.push('--auto');
    } else if (harness.command === 'cursor') {
      // Cursor's unflagged default asks, --force bypasses, and --auto-review
      // delegates approval decisions to Cursor's own reviewer.
      if (input.permissionMode === 'bypass') argv.push('--force');
      else if (input.permissionMode === 'auto') argv.push('--auto-review');
    } else if (harness.command === 'hermes') {
      // Hermes asks by default; --yolo is its explicit bypass mode. It does
      // not publish an automatic reviewer.
      if (input.permissionMode === 'bypass') argv.push('--yolo');
    } else if (harness.command === 'antigravity') {
      // The unflagged default requests review. Headless requests that cannot
      // be answered are denied; accept-edits would silently weaken Ask.
      if (input.permissionMode === 'bypass') argv.push('--dangerously-skip-permissions');
    } else if (harness.command === 'gemini') {
      argv.push('--approval-mode', input.permissionMode === 'bypass' ? 'yolo' : 'default');
    } else if (harness.command === 'qwen') {
      argv.push('--approval-mode', input.permissionMode === 'bypass' ? 'yolo' : input.permissionMode === 'auto' ? 'auto' : 'default');
    } else if (harness.command === 'copilot') {
      if (input.permissionMode === 'bypass') argv.push('--allow-all');
    } else if (harness.command === 'aider') {
      if (input.permissionMode === 'bypass') argv.push('--yes-always');
    } else if (harness.command === 'kiro') {
      if (input.permissionMode === 'bypass') argv.push('--trust-all-tools');
    } else if (harness.command === 'cline') {
      // Cline defaults this option to true, so Ask must explicitly turn it
      // off instead of relying on the unflagged default.
      argv.push('--auto-approve', input.permissionMode === 'bypass' ? 'true' : 'false');
    } else if (harness.command === 'kilo') {
      if (input.permissionMode === 'bypass') argv.push('--dangerously-skip-permissions');
    } else if (harness.command === 'droid') {
      if (input.permissionMode === 'bypass') argv.push('--skip-permissions-unsafe');
      else if (input.permissionMode === 'auto') argv.push('--auto', 'low');
    } else if (harness.command === 'crush') {
      // Crush currently defines --yolo on the root command rather than the
      // run subcommand, so it must precede `run` to be honored headlessly.
      if (input.permissionMode === 'bypass') argv.unshift('--yolo');
    } else if (harness.command === 'command') {
      if (input.permissionMode === 'bypass') argv.push('--yolo');
    }
  }
  appendDeclaredHarnessOptions(argv, harness, input.options, resumed);
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
