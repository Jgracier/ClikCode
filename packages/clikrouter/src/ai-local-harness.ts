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

export const AI_LOCAL_HARNESS_ADAPTER_VERSION = 3;

export const AI_LOCAL_HARNESSES: readonly AiLocalHarnessDefinition[] = [
  { command: 'claude', provider: 'anthropic', displayName: 'Claude Code', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'claude', npmPackage: '@anthropic-ai/claude-code', loginArgv: ['auth', 'login'], statusArgv: ['auth', 'status'], logoutArgv: ['auth', 'logout'], modelArgvPrefix: ['--model'], effortArgvPrefix: ['--effort'], permissionModes: ['read-only', 'workspace-write', 'auto'], profileEnv: 'CLAUDE_CONFIG_DIR', turn: { startArgv: ['-p', '--verbose', '--output-format', 'stream-json'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
  { command: 'codex', provider: 'openai', displayName: 'Codex', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'codex', npmPackage: '@openai/codex', loginArgv: ['login'], statusArgv: ['login', 'status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cd'], effortArgvPrefix: ['--config'], effortConfigKey: 'model_reasoning_effort', permissionModes: ['read-only', 'workspace-write', 'auto'], imageArgvPrefix: ['--image'], profileEnv: 'CODEX_HOME', turn: { startArgv: ['exec', '--json', '--skip-git-repo-check'], resumeArgv: ['exec', 'resume'], resumeIdSuffix: ['--json', '--skip-git-repo-check'], promptInput: 'stdin', output: 'json-lines', responseFields: ['text'], resumeSupportsWorkspaceSelector: false }, session: { resumeIdPrefix: ['resume'], continueArgv: ['resume', '--last'] } },
  { command: 'gemini', provider: 'google', displayName: 'Gemini CLI', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'gemini', npmPackage: '@google/gemini-cli', modelArgvPrefix: ['--model'], turn: { startArgv: ['--output-format', 'json'], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['-p'], output: 'json', responseFields: ['response', 'result', 'text'] }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--resume', 'latest'], discoverArgv: ['--list-sessions'], discoverFormat: 'numbered-list' } },
  { command: 'opencode', provider: 'opencode', displayName: 'OpenCode', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'opencode', loginArgv: ['auth', 'login'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], workspaceArgvPrefix: ['--dir'], effortArgvPrefix: ['--variant'], turn: { startArgv: ['run', '--format', 'json'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] }, session: { resumeIdPrefix: ['--session'], continueArgv: ['--continue'], discoverArgv: ['session', 'list'], discoverFormat: 'text' } },
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
  { command: 'kilo', provider: 'kilo', displayName: 'Kilo Code CLI', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'kilo', npmPackage: '@kilocode/cli', loginArgv: ['auth', 'login'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], turn: { startArgv: ['run', '--format', 'json'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] }, session: { resumeIdPrefix: ['--session'], continueArgv: ['--continue'], discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json' } },
  { command: 'cursor', provider: 'cursor', displayName: 'Cursor Agent', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'cursor-agent', loginArgv: ['login'], statusArgv: ['status', '--format', 'json'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], workspaceArgvPrefix: ['--workspace'], turn: { startArgv: ['-p', '--output-format', 'json'], resumeIdPrefix: ['--resume'], output: 'json', responseFields: ['result', 'response', 'text'] }, session: { createSessionArgv: ['create-chat'], resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
  { command: 'windsurf', provider: 'windsurf', displayName: 'Windsurf Cascade', surface: 'editor-extension', localAuth: ['oauth', 'vendor-cli'], binary: 'windsurf' },
  { command: 'crush', provider: 'crush', displayName: 'Crush', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'crush', npmPackage: '@charmland/crush', turn: { startArgv: ['run'], resumeIdPrefix: ['--session'], output: 'text' }, session: { resumeIdPrefix: ['--session'], continueArgv: ['--continue'], discoverArgv: ['session', 'list', '--json'], discoverFormat: 'json' } },
  { command: 'hermes', provider: 'nous', displayName: 'Hermes', surface: 'terminal', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'hermes', loginArgv: ['login'], statusArgv: ['status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--in'], effortArgvPrefix: ['--reasoning'], profileEnv: 'HERMES_HOME', turn: { startArgv: [], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['-z'], output: 'text' }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--continue'], discoverArgv: ['sessions', 'list', '--limit', '50'], discoverFormat: 'text' } },
  { command: 'command', provider: 'command-code', displayName: 'Command Code', surface: 'terminal', localAuth: ['oauth', 'vendor-cli'], binary: 'cmdc', npmPackage: 'command-code', loginArgv: ['login'], statusArgv: ['status', '--json'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], effortArgvPrefix: ['--effort'], profileEnv: 'HOME', turn: { startArgv: ['--print', '--output-format', 'json', '--yolo', '--skip-onboarding', '--no-auto-update'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { resumeIdPrefix: ['--resume'], continueArgv: ['--continue'] } },
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
      flag('auto-approve', 'Auto approve', 'Auto-approve tool use', 'permissions', ['--auto-approve'], { dangerous: true }),
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

const EFFORT_VALUES: Readonly<Record<string, readonly string[]>> = {
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
  const normalized: AiHarnessOptionDefinition[] = [];
  if (harness.modelArgvPrefix) normalized.push(value('model', 'Model', 'Provider model id or alias', 'model', harness.modelArgvPrefix));
  if (harness.workspaceArgvPrefix) normalized.push(value('workspace', 'Workspace', 'Working directory for the native agent', 'context', harness.workspaceArgvPrefix, 'path', { requiresNewSession: true }));
  if (harness.effortArgvPrefix) normalized.push(value('effort', 'Reasoning effort', 'Provider-native reasoning level', 'reasoning', harness.effortArgvPrefix, 'enum', { values: EFFORT_VALUES[harness.command] ?? [] }));
  if (harness.permissionModes?.length) normalized.push({ id: 'permissions', label: 'Filesystem access', description: 'Normalized ClikCode filesystem policy', category: 'permissions', kind: 'enum', values: harness.permissionModes });
  return { ...declared, options: [...normalized, ...declared.options] };
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
  for (const [id, raw] of Object.entries(values)) {
    const option = options.get(id);
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
  const selected = await import('./ai-router-selection').then((m) =>
    m.selectRouterCandidateDynamic(eligible, request.strategy, request.preferredModel, request.estimatedPromptTokens, request.agentCapabilities),
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
