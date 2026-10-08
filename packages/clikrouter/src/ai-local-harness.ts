// ============================================
// LOCAL AI HARNESS CONTRACT
// ============================================
// The gateway and a user's computer speak this small, provider-neutral
// vocabulary. Provider adapters remain in the router; credentials deliberately
// do not appear here. A BYO account is a local credential *reference*, never a
// token that can be uploaded to or read by the gateway.

export type AiHarnessRoute = 'local' | 'gateway';
export type AiHarnessAuthKind = 'oauth' | 'api-key' | 'vendor-cli';
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
  | 'generic-json' | 'text' | 'aider';
/** Project instruction file the vendor loads on its own; /init and /memory target it. */
export type AiHarnessMemoryFile = 'CLAUDE.md' | 'AGENTS.md' | 'GEMINI.md' | 'QWEN.md' | 'CONVENTIONS.md';

/** Agent Client Protocol launch contract. Everything the shared ACP client
 * needs to spawn a vendor comes from here; it holds no vendor table itself. */
export interface AiHarnessAcpDefinition {
  /** Argv that puts the vendor binary into ACP-over-stdio mode. */
  argv: readonly string[];
  /** Dedicated ACP executable when it is not `binary` (Mistral `vibe-acp`). */
  binary?: string;
  /** Package providing a separate ACP executable, installed with the CLI. */
  npmPackage?: string;
  /** Where model/effort/permission flags go relative to `argv`. `after` is for
   * vendors whose flags belong to the ACP subcommand (Droid `exec`). */
  optionPlacement?: 'before' | 'after';
  /** False when CLI flags do not belong to the ACP command. Model and mode
   * are then selected over the protocol. */
  inheritCliOptions?: boolean;
  /** ACP and the one-shot CLI read and write one session store: either
   * continues a thread the other started (verified live for Grok Build in
   * both directions). Such a thread is never pinned to the transport that
   * created it -- it runs over ACP, and a turn ACP cannot take (an image, a
   * model its list leaves out) uses the CLI for that turn only. Verified live
   * (a thread started by each, continued by the other, remembering a word)
   * for Claude Code, Grok Build, OpenCode, Kilo, GitHub Copilot and Goose
   * (which resumes by its own id: `session.idByName`); the rest
   * keep each thread on the transport that made it until checked the same
   * way (scripts/verify-shared-sessions.mjs). */
  sharedSessions?: boolean;
  /** ACP config option that selects the reasoning effort. */
  effortConfigId?: string;
  /** ACP config option used by agents that select a model provider first. */
  providerConfigId?: string;
  /** ACP mode IDs for ClikCode's permission modes, when the agent exposes
   * permission control through session/set_mode. */
  permissionModeIds?: Readonly<Partial<Record<AiHarnessPermissionMode, string>>>;
  /** Only when the ACP mode accepts an effort flag the one-shot mode lacks. */
  effortArgvPrefix?: readonly string[];
  /** Only when ACP needs a different mapping than `permissionArgv`. `ask` is
   * never sent: ACP's own permission requests implement it. */
  permissionArgv?: Readonly<Partial<Record<'bypass' | 'auto', readonly string[]>>>;
  /** Whether model discovery may open a disposable ACP session. Set false
   * when session/new leaves an unwanted conversation in vendor history. */
  listsModels?: boolean;
  /** Appended when ClikCode starts this agent only to ask it something
   * (its model list), never to run a turn: the vendor's own switch that keeps
   * the user's MCP servers from starting, since a question uses none of them
   * and each is a process. Only where the vendor has such a switch. */
  probeArgv?: readonly string[];
  /** For a vendor with no such switch but a per-server one: this prefix is
   *  repeated once for every server in its MCP config (Copilot's
   *  `--disable-mcp-server <name>`). A model-list probe that starts the
   *  user's servers is a session that starts their OAuth -- Copilot opens the
   *  browser for a server that needs a sign-in as its session starts. */
  probeDisableMcpPrefix?: readonly string[];
  /** The usage this agent reports -- its prompt response's `usage` -- is the
   * SESSION's running total, not the turn's (ACP says per turn; Hermes sends
   * `agent.session_*`, Vibe `session_prompt_tokens`). A turn's share is what
   * the total grew by. Read from each vendor's installed source. */
  usageTotals?: 'session';
  /** Each `agent_message_chunk` carrying a `messageId` is that message so far,
   * not a fragment: a chunk that extends the last is appended, one that
   * rewrites it replaces it (Mistral Vibe). */
  cumulativeChunks?: boolean;
  /** Where the agent keeps its session's running usage when its ACP stream
   * carries none: a JSON file (`{id}` is the ACP session id, `~` and
   * `${VAR:-default}` expand against the profile) and the path to the usage
   * object in it. A turn's usage is what that total grew by across the turn. */
  usageFile?: { path: string; field: readonly string[] };
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
  argvStyle?: 'value' | 'flag' | 'repeat' | 'csv';
  /** Some CLIs only accept a flag before their turn subcommand. */
  argvPlacement?: 'root' | 'turn';
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
  /** How this harness spells "add an MCP server", so one ClikCode-level entry
   * can be installed into every harness that has one.
   *
   * Four shapes exist, each read from a real CLI. Most take the target as a
   * positional -- `mcp add <name> <commandOrUrl> [args...]`, identical across
   * Claude, Gemini, Grok, Antigravity, Qwen and Command Code. Codex demands
   * `--url <url>` for a remote server or `-- <command> [args...]` for a local
   * one. Copilot, Amp and Cline take a URL positionally but need `--` before a
   * local command. Hermes and Auggie name every part with a flag -- the URL,
   * the command, and its arguments each have their own -- and take nothing
   * positionally but the server name. */
  add?: {
    argv: readonly string[];
    shape: 'positional' | 'url-or-doubledash' | 'doubledash-local' | 'named-flags';
    /** Flag carrying stdio|sse|http where the harness wants one stated. */
    transportPrefix?: readonly string[];
    /** named-flags only: where the URL, the command, and its arguments go. */
    urlPrefix?: readonly string[];
    /** named-flags only. Kiro takes even the NAME as a flag, so nothing about
     *  its add is positional. Absent means the name leads, positionally. */
    namePrefix?: readonly string[];
    commandPrefix?: readonly string[];
    argsPrefix?: readonly string[];
    /** named-flags only. Hermes takes `--args a b c`; Auggie takes one
     *  pre-joined string. Getting this backwards hands the server a single
     *  argument that merely contains spaces, which fails at connect time
     *  rather than at add time. */
    /** How a local server's arguments are spelled. `list` passes them bare,
     *  `joined` pre-joins them into one string, and `repeat-equals` repeats
     *  the flag as `--arg=VALUE` -- which Vibe needs, because plain
     *  `--arg -y` makes its parser read -y as a flag of its own and fail. */
    argsStyle?: 'list' | 'joined' | 'repeat-equals' | 'json-array';
    /** The harness can only be handed a REMOTE server without a prompt.
     *  opencode and Kilo take `mcp add <name> --url <url>` happily but have
     *  no flag at all for a local command -- extra positionals are refused
     *  and they fall back to their interactive picker, which a headless
     *  install cannot answer. A local entry is therefore declined with a
     *  reason rather than half-written. */
    remoteOnly?: true;
    /** Transport value to state for a LOCAL server. Absent means the harness
     *  only wants the flag for a remote one (or infers it). OpenHands makes
     *  --transport mandatory, so omitting it for stdio fails outright. */
    localTransport?: string;
    /** Extra argv only a REMOTE add takes. Vibe's --no-login belongs here: it
     *  stops a headless install blocking on an OAuth round trip, and Vibe
     *  refuses the flag outright alongside --transport stdio. */
    remoteExtraArgv?: readonly string[];
    /** Text to answer a confirmation prompt on stdin. Hermes connects to the
     *  server before saving and asks "Save config anyway? [y/N]" when that
     *  fails; with stdin ignored the prompt read EOF and took No, which is
     *  how `mcp add` exited 0 having written nothing. A reachable server
     *  connects and never asks, so this only ever decides the unreachable
     *  case -- and saving it, which Hermes then marks disabled and offers to
     *  test, is what the user asked for. */
    confirmStdin?: string;
    /** doubledash-local only. Flags that carry a remote server's headers
     *  (`Name: value`, after the URL) and a local server's environment
     *  (`KEY=value`, before `--`). Both are variadic in Claude, so where they
     *  sit is what keeps them from swallowing the name or the URL. Absent:
     *  the harness is given the server without them. */
    headerPrefix?: readonly string[];
    envPrefix?: readonly string[];
  };
  /** How this harness spells "remove an MCP server" from the same scope `add`
   *  writes to: `<argv> <name>`. Read off each CLI's own `mcp remove --help`
   *  (2026-10-05). opencode and Kilo have none -- their `mcp logout` drops
   *  only the OAuth token. */
  remove?: { argv: readonly string[] };
  /** Where this vendor keeps its MCP servers: each file it reads them from,
   *  in the order to read them. The one record of it: ClikCode's first-run
   *  import reads every vendor's (agent/mcp/import.ts), provisioning reads a
   *  harness's to see what it already has, and `writesServerFile` writes the
   *  first. Paths are the ones each vendor's `mcp add` writes, or its config
   *  file where it has no add. */
  serverFiles?: readonly AiHarnessMcpServerFile[];
  /** ClikCode adds a server by writing `serverFiles[0]` itself, for a
   *  harness that has no usable `mcp add`.
   *
   *  Writing a vendor's config is a second-best route and is used only where
   *  the first is absent: Cursor has every mcp subcommand except add, and
   *  Kimi has no mcp subcommand at all, yet both read a plain JSON file whose
   *  shape is the `mcpServers` convention. Verified by writing one by hand and
   *  asking the vendor to list it back -- Cursor found all three servers,
   *  including one already in the file.
   *
   *  JSON is written as JSON; YAML (Goose) through a document parse so the
   *  user's comments and formatting survive -- a vendor config is their
   *  file. A Goose server is spelled its own way, verified by writing it and
   *  reading it back with `goose info -v`: { name, type: stdio|streamable_http,
   *  cmd + args | uri, enabled }. */
  writesServerFile?: true;
}

/** One file a vendor reads its MCP servers from. */
export interface AiHarnessMcpServerFile {
  /** Under the user's home (or an isolated profile that is a whole HOME). */
  homeRelative: readonly string[];
  /** Under the vendor's own directory variable (CLAUDE_CONFIG_DIR,
   *  CODEX_HOME), which is what an isolated account profile points at. */
  rootRelative?: readonly string[];
  /** That variable, where ClikCode writes the file and the vendor honours one. */
  rootEnv?: string;
  format: 'json' | 'jsonc' | 'toml' | 'yaml';
  /** Path of the name -> server table inside the file. */
  key: readonly string[];
  /** How one server is spelled there. */
  dialect: 'mcp-servers' | 'gemini' | 'opencode' | 'goose' | 'codex';
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
  /** Used instead of `resumeIdPrefix` when the stored id is a session key
   * (`agent:main:main`) rather than the turn's session id. OpenClaw publishes
   * both, and they are not interchangeable. */
  resumeKeyPrefix?: readonly string[];
  resumeIdSuffix?: readonly string[];
  createIdPrefix?: readonly string[];
  promptArgvPrefix?: readonly string[];
  promptInput?: 'argv' | 'stdin';
  /** A piped prompt is a stream-json user message, and stdin stays open after
   * it while the vendor reports background work, so a task that finishes
   * after the turn's `result` still gets its follow-up turn. Claude Code only:
   * its `-p` mode kills background tasks the moment stdin closes. */
  stdinFormat?: 'stream-json';
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
  /** A route that keeps no history between one-shot turns: when the turn
   * result's value at `path` is one of `values`, the session it names cannot
   * be resumed with context, so ClikCode carries its own transcript next turn
   * instead. OpenClaw's CLI back ends (`claude-cli`) refuse to reseed history
   * in `agent --local`. */
  statelessRoute?: { path: readonly string[]; values: readonly string[] };
  /** Model providers (the provider half of a model id) whose route keeps no
   * history between turns, known from the id before the turn runs. Goose's
   * `claude-code` provider runs Claude Code fresh each turn: Goose stores
   * the messages but never hands them back to it (checked on Goose 1.51;
   * its `cursor-agent` provider does remember). */
  statelessProviders?: readonly string[];
  /** Flags for a turn in a folder that is not a git repository. Aider
   * creates one there otherwise -- it made the user's whole ~/projects a
   * repository with nothing in it. */
  outsideRepoArgv?: readonly string[];
  /** Literal phrases this vendor writes into its OWN result text when an
   *  account is out of usage, while still reporting the turn as a success.
   *  Matched literally and declared per harness, never inferred -- see
   *  AiLocalHarnessDefinition in the app's definition.ts for why that
   *  distinction matters. */
  quotaSignals?: readonly string[];
  resumeSupportsWorkspaceSelector?: boolean;
  /** Argv flag that takes inline MCP configuration or a path to an MCP config JSON. Amp takes `['--mcp-config']`. */
  mcpConfigArgv?: readonly string[];
  /** Argv flag that takes an extension file or plugin file. Pi takes `['-e']`. */
  extensionArgv?: readonly string[];
}

/** One way a vendor's own installer runs on one family of operating systems.
 *
 * `script`: the vendor's published install script. ClikCode fetches it from
 * `url` -- https only, and only a URL written here, never one derived from
 * input -- and runs it with no terminal attached (bash or sh on Linux and
 * macOS, PowerShell on Windows), so a script that would stop to ask reads
 * end-of-input and takes its non-interactive path. `args` and `env` are the
 * vendor's own documented switches for that (Goose's CONFIGURE=false).
 *
 * `uv-tool`: `uv tool install <package>`, where the vendor documents that as
 * its install and ships no script for this OS.
 *
 * `binDirs`: where it puts the executable. Searched after PATH, because these
 * installers add their directory to a shell profile that an already-running
 * ClikCode never reads. `~` is the home directory; `${NAME}` an environment
 * variable (LOCALAPPDATA, ProgramFiles). */
export type AiHarnessInstallStep =
  | { kind: 'script'; url: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; binDirs: readonly string[] }
  | { kind: 'uv-tool'; package: string; python?: string; with?: readonly string[]; binDirs: readonly string[] };

/** How to install a vendor CLI that is not an npm package. */
export interface AiHarnessInstaller {
  posix?: AiHarnessInstallStep;
  windows?: AiHarnessInstallStep;
  /** The vendor page the installer was taken from. */
  docs: string;
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
  /** The vendor's official installer, for a CLI with no npm package. Every
   * terminal harness declares one of the two (a test holds it), so choosing
   * any harness installs it. */
  installer?: AiHarnessInstaller;
  /** Native argv that begins the vendor-owned interactive login flow. */
  loginArgv?: readonly string[];
  /** Screens of the vendor's login that ClikCode's readers do not know
   * (clack/enquirer menus, `(Y)es/(N)o`, `…:` inputs and links are read on
   * their own): when its text shows `when`, send `send` ({enter} {down} {up}
   * {right} {left} {tab} {esc} {space}) or ask the user and send the answer. In order.
   * Every sign-in runs on ClikCode's screen (src/gateway/login/
   * vendor-sign-in.ts); confirmed per vendor against its real login. */
  loginSteps?: readonly { when: string; send?: string; ask?: { prompt: string; secret?: boolean } }[];
  /** loginArgv where no browser is local (SSH from a phone): the vendor's
   * device-code login, because its default returns to a localhost callback a
   * phone cannot reach. */
  loginRemoteArgv?: readonly string[];
  /** A sign-in that is only a key, stored by the vendor's own commands with
   * no screen at all (Deep Agents: `dcode auth list`, `dcode auth set
   * <provider>` reading the key from stdin). ClikCode lists the providers
   * from `providersArgv` (the first word of each line), asks which and the
   * key on its own screen, and pipes the key to `setArgv` ({provider}). With
   * loginKeyRoutes the key is asked first and its route's one label is the
   * provider; Enter alone is the list. */
  loginKeyCommand?: { providersArgv: readonly string[]; setArgv: readonly string[] };
  /** A key-first sign-in through the vendor's own menus: ClikCode asks for
   * the key alone, finds the first route whose endpoint accepts it, and
   * answers the vendor's menus with that route's `choose` labels, in order
   * (an option is the label, or starts with it and then a mark: `OpenAI •
   * unconfigured`, `OpenAI ▸ (...)`; one not on screen is typed into the
   * list's search; `?label`, a menu the vendor may not show, is passed over
   * when it does not), and its key field with the key. A route's endpoint is
   * `url`, a chat-completions endpoint of the vendor's own (a request with
   * no messages: refused for the key, 401/403, or for being empty), or
   * `provider`, one of KEY_PROVIDERS. No model runs. Once the key is in, the
   * vendor's defaults are taken (its current option, a question's shown
   * default); every other screen is still asked. An empty key skips all of
   * it: the vendor's own menus, for its browser sign-ins. */
  loginKeyRoutes?: readonly AiHarnessKeyRoute[];
  /** Labels answering the vendor's sign-in menus (as a route's `choose`
   * does) so its link shows at once, the key field open beside it: its own
   * account with loginKeyRoutes (Cline, Kilo, Nous Portal; Enter in the field
   * for its other sign-ins), its browser login otherwise (Aider's OpenRouter,
   * Devin's). */
  loginAccountChoose?: readonly string[];
  /** Where a key pasted at sign-in is stored by the vendor itself, read
   * from stdin (Codex's `login --with-api-key`); without it, a vendor that
   * takes keys only from its variable gets one saved in the account's
   * profile (src/harness/accounts/profile-key.ts). */
  loginKeyStdinArgv?: readonly string[];
  /** Where a new chat's title comes from: `vendor` writes one into its own
   * session file and ClikCode reads it (Claude Code); `none` asks for none,
   * because the harness's own prompt outweighs the request (Aider answers
   * with a bare title line that cannot be told from the answer). Absent: the
   * first turn asks the model for one. */
  titleSource?: 'vendor' | 'none';
  /** The model a new chat and an unset session start on, when the harness
   * offers it, instead of the first one its discovery lists (Claude Code:
   * `opus`). */
  defaultModel?: string;
  /** Where the vendor says which models its free plan runs, for the model
   * picker's "free plan" label (free-plan.ts). Never the models themselves:
   * `suffix` -- ids ending in it run free (OpenRouter's `:free`, which Cline,
   * Kilo and Nous share; not Command Code, which refuses its `:free` ids at
   * zero credits); `listed` -- the vendor lists only what the account's own
   * plan runs, so on a free plan (account.plan) every listed model is free. */
  freePlan?: { listed?: true; suffix?: ':free' };
  /** Environment a new account profile carries beyond its root, on every
   * spawn under it; `{profile}/...` is a path inside that profile. Antigravity
   * checks the OS keyring (tied to the D-Bus login session, not $HOME) before
   * its own sign-in, so without these every profile resolved to one shared
   * identity; making the keyring unreachable for that one child process makes
   * it fall through to its native browser sign-in (see commands/account.ts). */
  profileExtraEnv?: Readonly<Record<string, string>>;
  /** Settings an API-key account needs written into the vendor's own
   * settings file (`~/`-relative), merged into whatever is there: Antigravity
   * ignores GEMINI_API_KEY unless `modelProvider` is `gemini`. */
  apiKeySettings?: { path: string; set: Readonly<Record<string, string>> };
  /** Serves TurboFit local models through its own provider plugin
   * (src/harness/accounts/hermes-discovery.ts): the model picker offers them,
   * and a turn on one starts its runtime first. */
  turboFit?: boolean;
  statusArgv?: readonly string[];
  logoutArgv?: readonly string[];
  /** Which of the harness's own options is its read-only planning mode, and
   * the value that turns it on. One "Plan mode" setting drives it on every
   * harness that has one, however the vendor spells it (`--plan`,
   * `--mode plan`, `--use-spec`, Auggie's `--ask`). */
  planMode?: { option: string; value: true | string };
  /** Where the vendor keeps its sign-in, for vendors with no status or logout
   * command (see AiHarnessAuthFile). Signed in when any entry is present.
   * Logout removes the entries without `contains` (whole files that hold
   * nothing but the credential) and the `removeLine` lines. */
  authFiles?: readonly AiHarnessAuthFile[];
  /** Environment variables that sign the vendor in by themselves
   * (GEMINI_API_KEY). Any one set counts as signed in. */
  authEnv?: readonly string[];
  /** The vendor runs turns with no sign-in at all (OpenCode's free models,
   * `opencode/big-pickle`, in a fresh home). Choosing it never signs in
   * first; a turn the vendor refuses for want of one signs in then. */
  signInOptional?: true;
  /** Side-effect-free version probe; defaults to --version. */
  versionArgv?: readonly string[];
  /** Source-backed selectors ClikCode may safely append at launch. */
  modelArgvPrefix?: readonly string[];
  /** Sign-in for one provider inside a multi-provider harness; `{provider}`
   * is replaced with the provider half of a `provider:model` id. */
  providerLoginArgv?: readonly string[];
  /** What separates provider from model in this harness's ids. Default `:`
   * (Hermes); OpenClaw writes `provider/model`. */
  modelProviderSeparator?: ':' | '/';
  /** Replies that are really a failed call (see AiHarnessReplyErrorPattern). */
  replyErrorPatterns?: readonly AiHarnessReplyErrorPattern[];
  /** For a harness whose model ids carry their provider (`provider:model`,
   * Hermes): the flag that takes the provider half. The model flag then gets
   * the bare model, since the CLI does not parse the combined form. */
  modelProviderArgvPrefix?: readonly string[];
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
  /** Exact vendor ENVIRONMENT for each normalized permission choice, for a
   * vendor that carries its tool-approval policy that way instead of in argv.
   *
   * Goose is the case this exists for: it has no per-run mode flag at all --
   * only `goose configure`, an in-session `/mode`, and GOOSE_MODE. Leaving it
   * unset is not neutral: its own issue tracker records that a missing
   * GOOSE_MODE auto-approves every tool call, so a harness ClikCode drove
   * without this ran in bypass no matter which mode the user had chosen. */
  permissionEnv?: Readonly<Partial<Record<AiHarnessPermissionMode, Readonly<Record<string, string>>>>>;
  /** Environment every TURN of this harness runs with, whatever the permission
   * mode: a vendor feature that is off unless asked for. Claude Code offers its
   * task-list tools in print mode only with CLAUDE_CODE_ENABLE_TODO_TOOLS set
   * (verified on 2.1.281), and without them it cannot keep a checklist. */
  turnEnv?: Readonly<Record<string, string>>;
  /** Argv that precedes each image path on a turn, e.g. `['--image']`. Absent
   * means this vendor CLI has no attach-an-image flag ClikCode knows about. */
  imageArgvPrefix?: readonly string[];
  imageArgvStyle?: 'separate' | 'concatenated';
  /** Vendor-supported configuration root used for isolated local accounts. */
  profileEnv?: string;
  turn?: AiHarnessTurnDefinition;
  /** Proven contract to retry with when `turn` is rejected outright, before
   * any output, by an older vendor build; remembered for that build
   * (turn/vendor-process.ts). Applies wherever it is declared, whatever the
   * tier or `experimental`. */
  fallbackTurn?: AiHarnessTurnDefinition;
  /**
   * Source-backed native session invocation.  Omitted means ClikCode may
   * launch the harness but must not claim it can centrally resume its chats.
   */
  session?: {
    resumeIdPrefix?: readonly string[];
    /** See `AiHarnessTurnDefinition.resumeKeyPrefix`. */
    resumeKeyPrefix?: readonly string[];
    /** Let ClikCode allocate the UUID before the vendor process starts. */
    createIdPrefix?: readonly string[];
    /** Ask the vendor CLI to allocate an empty session and print its id. */
    createSessionArgv?: readonly string[];
    /** Aider-style exact history file owned by the ClikCode session. */
    idKind?: 'uuid' | 'history-file';
    /** The `uuid` ClikCode mints is the session's NAME (`createIdPrefix` is
     *  `--name`), and the vendor resumes by an id of its own that neither
     *  its stream nor its exit reports (Goose: `20261005_1`). ClikCode looks
     *  the id up by that name in `discoverArgv`'s listing and keeps the id,
     *  which its ACP agent loads too; a chat stored by name earlier is
     *  looked up the same way. */
    idByName?: true;
    /** Machine-readable (or stable UUID-bearing) vendor session listing. */
    discoverArgv?: readonly string[];
    discoverFormat?: 'json' | 'json-lines' | 'text';
    /** `discoverArgv` lists the vendor's sessions from every folder, not the
     * one it runs in, so one listing serves every folder ClikCode opens in.
     * Nothing in the argv or the rows says so (Hermes' table carries no
     * folder at all); each vendor's own `--help` does: a folder filter that
     * the listing leaves out (Hermes `--workspace`, Goose `--working_dir`), or
     * no folder concept (OpenClaw lists per agent). */
    discoverAllFolders?: true;
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
  // npx keeps every MCP server it runs here; one per profile was 2.5 GB.
  NPM_CONFIG_CACHE: '~/.npm',
  // pnpm's own cache and store, the same duplication for pnpm installs.
  NPM_CONFIG_CACHE_DIR: '~/.cache/pnpm',
  NPM_CONFIG_STORE_DIR: '~/.local/share/pnpm/store',
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
 * ACP is the primary transport; the structured CLI remains available for
 * turns whose capabilities the agent does not advertise. */
const OPENCODE_FAMILY = {
  surface: 'terminal', transport: 'acp', integration: 'structured', parser: 'opencode-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false,
  customCommandDirs: ['.opencode/command', '~/.config/opencode/command'],
  acp: { argv: ['acp'], inheritCliOptions: false, sharedSessions: true },
  localAuth: ['api-key', 'oauth', 'vendor-cli'], loginArgv: ['auth', 'login'], providerLoginArgv: ['auth', 'login', '--provider', '{provider}'],
  // Kilo's list (a fork) names them the same; both checked signed out.
  loginKeyRoutes: providerKeyRoutes([], {
    anthropic: 'Anthropic', openrouter: 'OpenRouter', openai: ['OpenAI', 'Manually enter API Key'], google: 'Google', xai: ['xAI', 'Manually enter API Key'],
    groq: 'Groq', cerebras: 'Cerebras', huggingface: 'Hugging Face', fireworks: 'Fireworks AI', mistral: 'Mistral', deepseek: 'DeepSeek',
    moonshot: 'Moonshot AI', 'moonshot-cn': 'Moonshot AI (China)', zai: 'Z.AI', minimax: 'MiniMax (minimax.io)', together: 'Together AI',
  }),
  authFiles: [{ path: '${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json', contains: '"type"' }], modelProviderSeparator: '/', modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models', '--verbose'], workspaceArgvPrefix: ['--dir'],
  effortArgvPrefix: ['--variant'], effortValues: ['minimal', 'low', 'medium', 'high', 'max'],
  permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--auto'] } }, normalizedPermissionOptionIds: ['auto-approve'],
  imageArgvPrefix: ['--file'],
  turn: { promptGuard: 'double-dash', startArgv: ['run', '--format', 'json'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'] },
  session: { resumeIdPrefix: ['--session'], discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json' },
} as const satisfies Partial<AiLocalHarnessDefinition>;
// OpenCode-only declarations a fork must not inherit by accident.
const { customCommandDirs: _openCodeCommandDirs, normalizedPermissionOptionIds: _openCodePermissionAliases, ...OPENCODE_FORK_BASE } = OPENCODE_FAMILY;

/** Hermes ends a failed call as an ordinary turn whose whole reply is the
 * error -- over ACP too, with stop reason `end_turn` -- so the words are the
 * only signal. Read from agent/conversation_loop.py and hermes_cli/auth.py. */
const HERMES_REPLY_ERRORS: readonly AiHarnessReplyErrorPattern[] = [
  { pattern: '^(?:API call failed after \\d+ retries: )?HTTP (\\d{3})\\b' },
  { pattern: '^No access token found for .+ login', status: 401 },
];

/** Copilot reports a failed model call over ACP as an ordinary reply ending
 * the turn normally: `Error: <reason> (Request ID: 4755:2BCAD5:…)`. Captured
 * twice from Copilot 1.0.88 (a monthly-quota refusal); the request id is what
 * no answer of the model's would carry. */
const COPILOT_REPLY_ERRORS: readonly AiHarnessReplyErrorPattern[] = [
  { pattern: '^Error: .+ \\(Request ID: [0-9A-Fa-f:]+\\)$' },
];

/** Goose writes a provider failure into the chat as its own message, framed
 * by two fixed sentences (both present in the goose 1.51 binary). */
const GOOSE_REPLY_ERRORS: readonly AiHarnessReplyErrorPattern[] = [
  { pattern: '^Ran into this error: [\\s\\S]*Please retry if you think this is a transient or recoverable error\\.$' },
];

/** Auggie emits a quota refusal as assistant prose over ACP, with a warning
 * emoji and bold text, then ends the prompt normally. */
const AUGGIE_REPLY_ERRORS: readonly AiHarnessReplyErrorPattern[] = [
  { pattern: '^\\s*(?:⚠️\\s*)?\\*{0,2}You have run out of usage for\\b', status: 402 },
];

/** Cursor's ActionRequiredError is written into the chat as an ordinary
 * agent_message_chunk, then the turn ends successfully. Confirmed in
 * cursor-agent 2026.09.26: action `upgrade` → "Upgrade your plan to continue",
 * `payment` → "Add a payment method to continue", `login` → "Please sign in
 * to continue". Without these, ClikCode treated the notice as the answer and
 * never switched accounts. The trailing form is deliberate: Cursor appends
 * the notice after any real progress already streamed. */
const CURSOR_REPLY_ERRORS: readonly AiHarnessReplyErrorPattern[] = [
  { pattern: '(?:^|\\n\\n)Upgrade your (?:plan|account) to continue\\.?\\s*$', status: 402 },
  { pattern: '(?:^|\\n\\n)Add a payment method to continue\\.?\\s*$', status: 402 },
  { pattern: '(?:^|\\n\\n)Please sign in to continue\\.?\\s*$', status: 401 },
];

export type AiHarnessKeyRoute = { choose: readonly string[] } & ({ url: string } | { provider: AiKeyProviderId });

/** API-key providers the multi-provider harnesses list, and how to ask one
 * whether it takes a key without running a model: `probe` answers 2xx to
 * a key it takes (a GET of its model list, or its key's own info where the
 * list is public), sent as `header` (default: Authorization: Bearer) with
 * `headers`.
 * `prefixes`: how the provider's keys begin. A key with one of them is
 * sent only to the providers that issue it; a key with none, only to those
 * with no prefixes or with `unprefixed` (OpenAI's older `sk-` keys). A key
 * never goes to a provider that could not have issued it. */
export interface AiKeyProvider {
  probe: string; header?: 'x-api-key' | 'x-goog-api-key'; headers?: Readonly<Record<string, string>>;
  prefixes?: readonly string[]; unprefixed?: true;
}
/** Hermes is signed in by a portal or provider login (auth.json) or a
 * provider key (.env). Not `hermes status`: it exits 0 with neither -- "Model:
 * (not set)", every key "not set" (2026-10-06) -- and two empty profiles read
 * as signed in. */
const HERMES_AUTH_FILES = [
  { path: '${HERMES_HOME:-~/.hermes}/auth.json', contains: '"access_token"' },
  { path: '${HERMES_HOME:-~/.hermes}/.env', contains: '_API_KEY=' },
] as const;

export const KEY_PROVIDERS = {
  anthropic: { probe: 'https://api.anthropic.com/v1/models', header: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' }, prefixes: ['sk-ant-'] },
  openrouter: { probe: 'https://openrouter.ai/api/v1/key', prefixes: ['sk-or-'] },
  openai: { probe: 'https://api.openai.com/v1/models', prefixes: ['sk-proj-', 'sk-svcacct-', 'sk-admin-'], unprefixed: true },
  google: { probe: 'https://generativelanguage.googleapis.com/v1beta/models', header: 'x-goog-api-key', prefixes: ['AIza'] },
  xai: { probe: 'https://api.x.ai/v1/models', prefixes: ['xai-'] },
  groq: { probe: 'https://api.groq.com/openai/v1/models', prefixes: ['gsk_'] },
  cerebras: { probe: 'https://api.cerebras.ai/v1/models', prefixes: ['csk-'] },
  huggingface: { probe: 'https://huggingface.co/api/whoami-v2', prefixes: ['hf_'] },
  fireworks: { probe: 'https://api.fireworks.ai/inference/v1/models', prefixes: ['fw_'], unprefixed: true },
  mistral: { probe: 'https://api.mistral.ai/v1/models' },
  deepseek: { probe: 'https://api.deepseek.com/models' },
  moonshot: { probe: 'https://api.moonshot.ai/v1/models' },
  'moonshot-cn': { probe: 'https://api.moonshot.cn/v1/models' },
  zai: { probe: 'https://api.z.ai/api/paas/v4/models' },
  minimax: { probe: 'https://api.minimax.io/v1/models' },
  together: { probe: 'https://api.together.xyz/v1/models' },
} as const satisfies Record<string, AiKeyProvider>;
export type AiKeyProviderId = keyof typeof KEY_PROVIDERS;

/** A multi-provider harness's key routes: per provider, its option in the
 * vendor's provider list and any menu after it, behind `first` (the
 * vendor's own way into its API-key providers). */
function providerKeyRoutes(first: readonly string[], labels: Partial<Record<AiKeyProviderId, string | readonly string[]>>): AiHarnessKeyRoute[] {
  return (Object.entries(labels) as [AiKeyProviderId, string | readonly string[]][])
    .map(([provider, label]) => ({ provider, choose: [...first, ...(typeof label === 'string' ? [label] : label)] }));
}

/** Vendor installers for the CLIs that are not npm packages. Each URL was
 * fetched and read before it was written here (and each one's Windows
 * counterpart is the one the vendor's own install page gives), and each
 * `binDirs` is where that script really writes the binary. */
const LOCAL_BIN = '~/.local/bin';
const HARNESS_INSTALLERS = {
  // Symlinks `cursor-agent` (and `agent`) into ~/.local/bin; on Windows it
  // copies cursor-agent.cmd into %LOCALAPPDATA%\cursor-agent.
  cursor: {
    posix: { kind: 'script', url: 'https://cursor.com/install', binDirs: [LOCAL_BIN] },
    windows: { kind: 'script', url: 'https://cursor.com/install?win32=true', binDirs: ['${LOCALAPPDATA}/cursor-agent'] },
    docs: 'https://cursor.com/docs/cli/installation',
  },
  // aider.chat's scripts install uv, then `uv tool install aider-chat`.
  aider: {
    posix: { kind: 'script', url: 'https://aider.chat/install.sh', binDirs: [LOCAL_BIN] },
    windows: { kind: 'script', url: 'https://aider.chat/install.ps1', binDirs: [LOCAL_BIN] },
    docs: 'https://aider.chat/docs/install.html',
  },
  // block/goose now redirects to aaif-goose/goose: the project moved, it was
  // not forked (same repository, homepage goose-docs.ai). CONFIGURE=false is
  // the scripts' documented switch for not starting `goose configure`.
  goose: {
    posix: { kind: 'script', url: 'https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh', env: { CONFIGURE: 'false' }, binDirs: [LOCAL_BIN] },
    windows: { kind: 'script', url: 'https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1', env: { CONFIGURE: 'false' }, binDirs: [LOCAL_BIN] },
    docs: 'https://goose-docs.ai/docs/getting-started/installation',
  },
  // A single binary: /usr/local/bin when writable (already on every PATH, so
  // not listed), else ~/.local/bin. There is no Windows script; the
  // documented install there is uv's.
  openhands: {
    posix: { kind: 'script', url: 'https://install.openhands.dev/install.sh', binDirs: [LOCAL_BIN] },
    windows: { kind: 'uv-tool', package: 'openhands', python: '3.12', binDirs: [LOCAL_BIN] },
    docs: 'https://docs.openhands.dev/openhands/usage/cli/installation',
  },
  // Installs uv if needed, then mistral-vibe (which ships `vibe` and `vibe-acp`).
  vibe: {
    posix: { kind: 'script', url: 'https://mistral.ai/vibe/install.sh', binDirs: [LOCAL_BIN] },
    windows: { kind: 'uv-tool', package: 'mistral-vibe', binDirs: [LOCAL_BIN] },
    docs: 'https://docs.mistral.ai/vibe/code/cli/install-setup',
  },
  // --non-interactive / -NonInteractive: the scripts' own switch for skipping
  // the stages that ask (API keys, settings) -- ClikCode signs in separately.
  hermes: {
    posix: { kind: 'script', url: 'https://hermes-agent.nousresearch.com/install.sh', args: ['--non-interactive'], binDirs: [LOCAL_BIN] },
    windows: { kind: 'script', url: 'https://hermes-agent.nousresearch.com/install.ps1', args: ['-NonInteractive'], binDirs: ['${LOCALAPPDATA}/hermes/bin'] },
    docs: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
  },
  // `kiro-cli` into ~/.local/bin on Linux. On macOS the script installs the
  // Kiro CLI app into /Applications, whose bundle carries the binary; on
  // Windows an MSI into Program Files.
  kiro: {
    posix: { kind: 'script', url: 'https://cli.kiro.dev/install', binDirs: [LOCAL_BIN, '/Applications/Kiro CLI.app/Contents/MacOS'] },
    windows: { kind: 'script', url: 'https://cli.kiro.dev/install.ps1', binDirs: ['${ProgramFiles}/Kiro-Cli', '${ProgramFiles}/Kiro-Cli/bin'] },
    docs: 'https://kiro.dev/docs/cli/installation/',
  },
  // A native Go binary -- no Node, no npm -- at ~/.local/bin/agy.
  antigravity: {
    posix: { kind: 'script', url: 'https://antigravity.google/cli/install.sh', binDirs: [LOCAL_BIN] },
    windows: { kind: 'script', url: 'https://antigravity.google/cli/install.ps1', binDirs: ['${LOCALAPPDATA}/agy/bin'] },
    docs: 'https://antigravity.google/docs/cli/install/',
  },
  // The ACP adapter is a separate Python extra, so installing only
  // deepagents-code would leave `dcode --acp` unusable.
  dcode: {
    posix: { kind: 'uv-tool', package: 'deepagents-code', with: ['deepagents-acp'], binDirs: [LOCAL_BIN] },
    windows: { kind: 'uv-tool', package: 'deepagents-code', with: ['deepagents-acp'], binDirs: [LOCAL_BIN] },
    docs: 'https://github.com/langchain-ai/deepagents/blob/main/libs/acp/README.md',
  },
  devin: {
    posix: { kind: 'script', url: 'https://cli.devin.ai/install.sh', binDirs: [LOCAL_BIN] },
    windows: { kind: 'script', url: 'https://static.devin.ai/cli/setup.ps1', binDirs: ['${LOCALAPPDATA}/devin/cli/bin'] },
    docs: 'https://docs.devin.ai/cli',
  },
  junie: {
    posix: { kind: 'script', url: 'https://junie.jetbrains.com/install.sh', binDirs: [LOCAL_BIN] },
    windows: { kind: 'script', url: 'https://junie.jetbrains.com/install.ps1', binDirs: [LOCAL_BIN] },
    docs: 'https://junie.jetbrains.com/docs/junie-cli.html',
  },
  mcode: {
    posix: { kind: 'script', url: 'https://filecdn.minimax.chat/public/install.sh', binDirs: ['~/.minimax-code/bin'] },
    windows: { kind: 'script', url: 'https://filecdn.minimax.chat/public/install.ps1', binDirs: ['~/.minimax-code'] },
    docs: 'https://github.com/MiniMax-AI/minimax-code',
  },
} as const satisfies Readonly<Record<string, AiHarnessInstaller>>;

const CATALOG_HARNESSES: readonly AiLocalHarnessDefinition[] = [
  { command: 'claude', provider: 'anthropic', displayName: 'Claude Code', titleSource: 'vendor', defaultModel: 'opus', surface: 'terminal', tier: 'primary', transport: 'acp', acp: { binary: 'claude-agent-acp', npmPackage: '@agentclientprotocol/claude-agent-acp@0.84.0', argv: [], inheritCliOptions: false, listsModels: false, effortConfigId: 'effort', permissionModeIds: { ask: 'default', auto: 'auto', bypass: 'bypassPermissions' }, sharedSessions: true }, integration: 'structured', parser: 'claude-stream-json', memoryFile: 'CLAUDE.md', nativeSlashPassthrough: true, customCommandDirs: ['.claude/commands', '~/.claude/commands'], effortValues: ['low', 'medium', 'high', 'xhigh', 'max'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'claude', authFiles: [{ path: '${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json' }], authEnv: ['ANTHROPIC_API_KEY'], npmPackage: '@anthropic-ai/claude-code', loginArgv: ['auth', 'login'], statusArgv: ['auth', 'status'], logoutArgv: ['auth', 'logout'], modelArgvPrefix: ['--model'], effortArgvPrefix: ['--effort'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--permission-mode', 'manual', '--permission-prompts', 'none'] }, bypass: { argv: ['--permission-mode', 'bypassPermissions', '--permission-prompts', 'none', '--allow-dangerously-skip-permissions'] }, auto: { argv: ['--permission-mode', 'auto', '--permission-prompts', 'none'] } }, turnEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, profileEnv: 'CLAUDE_CONFIG_DIR', turn: { startArgv: ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], promptInput: 'stdin', stdinFormat: 'stream-json', stdinArgv: [], output: 'json-lines', responseFields: ['result'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'] } },
  // Grok Build speaks Claude Code's stream-json shape exactly -- verified live
  // against `grok -p --output-format streaming-messages-json`, whose first
  // line is {"type":"system","subtype":"init","session_id":…} and whose last
  // is {"type":"result",…,"usage":{…}} -- so it reuses that parser rather
  // than getting a near-identical one of its own. Its ACP server publishes
  // session-wide token usage, which ClikCode turns into a per-turn reading.
  // It publishes no quota window (errors are balance-based: HTTP 402).
  { command: 'grok', freePlan: { listed: true }, provider: 'xai', displayName: 'Grok Build', surface: 'terminal', tier: 'primary', transport: 'acp', acp: { argv: ['agent', 'stdio'], inheritCliOptions: false, effortConfigId: 'reasoning_effort', sharedSessions: true }, integration: 'structured', parser: 'claude-stream-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, effortValues: ['low', 'medium', 'high'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'grok', npmPackage: '@xai-official/grok', authFiles: [{ path: '~/.grok/auth.json' }], authEnv: ['XAI_API_KEY'], loginArgv: ['login'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--reasoning-effort'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--permission-mode', 'default'] }, bypass: { argv: ['--permission-mode', 'bypassPermissions'] }, auto: { argv: ['--permission-mode', 'auto'] } }, turn: { startArgv: ['--output-format', 'streaming-messages-json', '--include-partial-messages'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['-p'], output: 'json-lines', responseFields: ['result'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'] } },
  // Restored and re-checked against gemini 0.60.0 on a real install, not the
  // entry this replaces. What changed: --acp is the flag now (the old
  // --experimental-acp is deprecated), -r/--resume takes "latest" or an index
  // rather than an id, --session-id starts a NEW session with a given uuid,
  // and -o/--output-format offers text|json|stream-json (confirmed by the
  // rejection of anything else). Its approval modes are default / auto_edit /
  // yolo / plan.
  //
  // No loginArgv: Gemini's auth lives behind /auth inside its own interactive
  // session, with nothing scriptable. An empty argv is still meaningful --
  // ClikCode's login flow gates on the field being present at all, and
  // without it a fresh install never gets handed a real terminal to sign in.
  // Sign-in (2026-10-03, real gemini 0.62 signed out): --skip-trust skips the
  // folder-trust dialog; its method menu, Google link + authorization code and
  // key box are read on ClikCode's screen. Signed in, it restarts into its chat,
  // which the step quits.
  // CLI turns (0.62.0, 2026-10-04): `--resume <id>` continues a thread by id
  // (without turn.resumeIdPrefix every resumed CLI turn silently started a
  // new thread); headless, a folder not yet trusted exits 55 unless
  // `--skip-trust`. ACP `session/load` reopens only threads ACP started: a
  // CLI-born or written thread loads as "No previous sessions found for this
  // project" AND is reset to its first message on disk -- which is why
  // those stay on the CLI (session nativeTransport) and the thread writer pins
  // its threads there.
  { command: 'gemini', loginAccountChoose: ['Sign in with Google', 'Yes'], provider: 'google', displayName: 'Gemini CLI', surface: 'terminal', tier: 'primary', transport: 'acp', integration: 'structured', parser: 'claude-stream-json', memoryFile: 'GEMINI.md', nativeSlashPassthrough: false, customCommandDirs: ['.gemini/commands', '~/.gemini/commands'], acp: { argv: ['--acp'], listsModels: true }, normalizedPermissionOptionIds: ['approval-mode'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'gemini', npmPackage: '@google/gemini-cli', authFiles: [{ path: '${GEMINI_CLI_HOME:-~}/.gemini/oauth_creds.json' }], authEnv: ['GEMINI_API_KEY'], loginArgv: ['--skip-trust'], loginSteps: [{ when: 'Type your message', send: '/quit{enter}' }], loginKeyRoutes: providerKeyRoutes([], { google: 'Use Gemini API Key' }), modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--include-directories'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--approval-mode', 'default'] }, bypass: { argv: ['--approval-mode', 'yolo'] }, auto: { argv: ['--approval-mode', 'auto_edit'] } }, profileEnv: 'GEMINI_CLI_HOME', turn: { startArgv: ['--skip-trust', '--output-format', 'stream-json'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['--prompt'], output: 'json-lines', responseFields: ['response', 'result', 'text', 'content'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'] } },
  { command: 'codex', freePlan: { listed: true }, loginKeyStdinArgv: ['login', '--with-api-key'], provider: 'openai', displayName: 'Codex', surface: 'terminal', tier: 'primary', transport: 'codex-app-server', integration: 'native', parser: 'codex-items', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, customCommandDirs: ['~/.codex/prompts'], effortValues: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'codex', authFiles: [{ path: '${CODEX_HOME:-~/.codex}/auth.json' }], authEnv: ['OPENAI_API_KEY'], npmPackage: '@openai/codex', loginRemoteArgv: ['login', '--device-auth'], loginArgv: ['login'], statusArgv: ['login', 'status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cd'], effortArgvPrefix: ['--config'], effortConfigKey: 'model_reasoning_effort', permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'], placement: 'root' }, bypass: { argv: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'], placement: 'root' }, auto: { argv: ['--approve-for-me'], placement: 'root' } }, imageArgvPrefix: ['--image'], profileEnv: 'CODEX_HOME', turn: { startArgv: ['exec', '--json', '--skip-git-repo-check'], resumeArgv: ['exec', 'resume'], resumeIdSuffix: ['--json', '--skip-git-repo-check'], promptInput: 'stdin', output: 'json-lines', responseFields: ['text'], resumeSupportsWorkspaceSelector: false }, session: { resumeIdPrefix: ['resume'] } },
  { ...OPENCODE_FAMILY, command: 'opencode', provider: 'opencode', displayName: 'OpenCode', tier: 'primary', binary: 'opencode', npmPackage: 'opencode-ai', signInOptional: true },
  // No logoutArgv: Copilot signs out only with /logout inside its own chat
  // (1.0.91: `copilot logout` exits 1, "Invalid command format"), and its
  // token is in the system credential store, so ClikCode can remove the
  // account but cannot sign it out.
  // Effort goes over ACP only (`--effort`); the levels are read from
  // `copilot --help` (effort-choices.ts), effortValues is the fallback.
  // Shared sessions (1.0.91, 2026-10-05): a `-p --session-id` thread loads
  // over ACP with its history, and `--session-id` on an ACP thread continues
  // it; each recalled a word the other was told.
  { command: 'copilot', freePlan: { listed: true }, provider: 'github-copilot', displayName: 'GitHub Copilot', planMode: { option: 'plan', value: true }, surface: 'terminal', tier: 'primary', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['--acp', '--stdio'], effortArgvPrefix: ['--effort'], sharedSessions: true, probeDisableMcpPrefix: ['--disable-mcp-server'] }, effortValues: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], retiredOptionIds: ['allow-all'], replyErrorPatterns: COPILOT_REPLY_ERRORS, localAuth: ['oauth', 'vendor-cli'], binary: 'copilot', npmPackage: '@github/copilot', loginRemoteArgv: ['login', '--device-code'], loginArgv: ['login'], authFiles: [{ path: '${COPILOT_HOME:-~/.copilot}/config.json', contains: '"loggedInUsers": [\n' }], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['-C'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--allow-all'] } }, imageArgvPrefix: ['--attachment'], profileEnv: 'COPILOT_HOME', turn: { startArgv: ['-s'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session-id'], promptArgvPrefix: ['-p'], output: 'text' }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session-id'] } },
  { command: 'aider', freePlan: { suffix: ':free' }, loginAccountChoose: ['Yes'], provider: 'aider', displayName: 'Aider', titleSource: 'none', surface: 'terminal', tier: 'more', transport: 'text-cli', integration: 'compatibility', parser: 'aider', memoryFile: 'CONVENTIONS.md', nativeSlashPassthrough: false, localAuth: ['api-key', 'vendor-cli'], binary: 'aider', installer: HARNESS_INSTALLERS.aider, loginArgv: ['--no-git', '--exit'], authFiles: [{ path: '~/.aider/oauth-keys.env' }], authEnv: ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'VERTEXAI_PROJECT'], modelArgvPrefix: ['--model'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--yes-always'] } }, imageArgvPrefix: ['--file'], turn: { startArgv: ['--no-show-model-warnings', '--no-check-update', '--no-show-release-notes', '--no-analytics', '--no-pretty', '--no-fancy-input', '--no-detect-urls'], createIdPrefix: ['--chat-history-file'], resumeIdPrefix: ['--chat-history-file'], resumeIdSuffix: ['--restore-chat-history'], promptArgvPrefix: ['--message'], output: 'text', outsideRepoArgv: ['--no-git'] }, session: { idKind: 'history-file', createIdPrefix: ['--chat-history-file'], resumeIdPrefix: ['--chat-history-file'] } },
  // Goose effort is the ACP session option `thinking_effort`; its values are
  // read from the session (effort-choices.ts). effortValues, the fallback, are
  // the levels its own `goose configure` prompt offers (off/low/medium/high/max).
  { command: 'goose', freePlan: { suffix: ':free' }, provider: 'goose', displayName: 'Goose', replyErrorPatterns: GOOSE_REPLY_ERRORS, surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'goose', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['acp'], inheritCliOptions: false, providerConfigId: 'provider', effortConfigId: 'thinking_effort', permissionModeIds: { ask: 'approve', auto: 'smart_approve', bypass: 'auto' }, sharedSessions: true }, effortValues: ['off', 'low', 'medium', 'high', 'max'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'goose', installer: HARNESS_INSTALLERS.goose, loginArgv: ['configure'], loginSteps: [{ when: 'Share anonymous usage data', send: '{right}{enter}' }],
    loginKeyRoutes: providerKeyRoutes(['Manual Configuration'], {
      anthropic: 'Anthropic', openrouter: 'OpenRouter', openai: ['OpenAI', 'Yes'], google: 'Google Gemini (API Key)', xai: 'xAI', groq: 'Groq', cerebras: 'Cerebras', huggingface: 'Hugging Face',
      fireworks: 'Fireworks AI', mistral: 'Mistral AI', deepseek: 'DeepSeek', moonshot: 'Moonshot', zai: 'Z.AI', minimax: 'MiniMax', together: 'Together AI',
    }), providerLoginArgv: ['configure'], modelProviderSeparator: '/', modelProviderArgvPrefix: ['--provider'], modelArgvPrefix: ['--model'], permissionModes: ['ask', 'bypass', 'auto'], permissionEnv: { ask: { GOOSE_MODE: 'approve' }, bypass: { GOOSE_MODE: 'auto' }, auto: { GOOSE_MODE: 'smart_approve' } }, turn: { startArgv: ['run', '--output-format', 'stream-json'], createIdPrefix: ['--name'], resumeIdPrefix: ['--resume', '--session-id'], promptArgvPrefix: ['--text'], output: 'json-lines', responseFields: ['text', 'content', 'response'], statelessProviders: ['claude-code'] }, session: { idKind: 'uuid', idByName: true, createIdPrefix: ['--name'], resumeIdPrefix: ['session', '--resume', '--session-id'], discoverArgv: ['session', 'list', '--format', 'json'], discoverFormat: 'json', discoverAllFolders: true } },
  // Amp's execute mode has a documented `--stream-json` switch that emits
  // Claude Code-compatible stream-json (system/assistant/result envelopes), so
  // it borrows the claude-stream-json parser family. UNVERIFIED LIVE: amp is
  // not installed where this was written, hence `experimental`; `fallbackTurn`
  // is the previously shipped plain-text contract, unchanged.
  { command: 'amp', provider: 'amp', displayName: 'Amp', surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'claude-stream-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, experimental: true, localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'amp', npmPackage: '@ampcode/cli', authFiles: [{ path: '${XDG_DATA_HOME:-~/.local/share}/amp/secrets.json', contains: 'apiKey@' }], authEnv: ['AMP_API_KEY'], loginArgv: ['login'], versionArgv: ['version'], turn: { startArgv: ['--stream-json'], resumeArgv: ['threads', 'continue'], resumeIdSuffix: ['--stream-json'], promptArgvPrefix: ['-x'], output: 'json-lines', responseFields: ['result'], mcpConfigArgv: ['--mcp-config'] }, fallbackTurn: { startArgv: [], resumeArgv: ['threads', 'continue'], promptArgvPrefix: ['-x'], output: 'text' }, session: { resumeIdPrefix: ['threads', 'continue'] } },
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
  // Effort is NOT an independent dimension here, which is why this entry
  // declares no effortValues and no effortArgvPrefix even though `agy --help`
  // lists --effort. Antigravity encodes effort in the MODEL ID -- its own
  // `agy models` prints gemini-3.8-flash-high / -medium / -low,
  // gemini-3.1-pro-high / -low, gpt-oss-120b-medium -- and the CLI rejects any
  // combination that is not consistent with that. Verified live against agy
  // 1.2.7 on a real authenticated account:
  //   --model claude-opus-4-6-thinking --effort medium
  //     -> "--effort is not supported for model claude-opus-4-6-thinking"
  //   --model gpt-oss-120b-medium --effort high
  //     -> "--model gpt-oss-120b-medium conflicts with --effort=high"
  //   --model claude-opus-4-6-thinking (no --effort)
  //     -> SUCCESS
  // Declaring the flag made ClikCode send it on every turn, so EVERY
  // antigravity turn failed on every account -- and because the failure
  // looked like the account's fault, failover then walked the whole account
  // list failing identically. Choosing effort means choosing the model.
  // tree (~/.gemini/antigravity-cli/, credentials included) from $HOME, the
  // same way it would with a real home directory, so redirecting HOME per
  // account is a real isolation mechanism here, not a guess -- verified
  // `agy models` runs cleanly under a freshly isolated HOME. This is what
  // makes "add a new/different account" actually work: a fresh, empty HOME
  // (keyring cut off by profileExtraEnv) has no credential to reuse.
  // Sign-in is bare `agy` (1.2.17): its "Select login method" screen, then a
  // Google link and a code field. `agy -p /help` used to be the login, but a
  // turn now runs signed out ("You are not logged into Antigravity", answered
  // anyway), so it signed nothing in. The token file it writes ends the
  // sign-in; the first-run screens are answered (data sharing unticked).
  { command: 'antigravity', freePlan: { listed: true }, provider: 'antigravity', displayName: 'Antigravity CLI', planMode: { option: 'mode', value: 'plan' }, surface: 'terminal', tier: 'primary', transport: 'structured-cli', integration: 'structured', parser: 'antigravity', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, profileEnvPassthrough: HOME_REDIRECT_ENV_PASSTHROUGH, profileExtraEnv: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent', XDG_RUNTIME_DIR: '{profile}/runtime' }, apiKeySettings: { path: '~/.gemini/antigravity-cli/settings.json', set: { modelProvider: 'gemini' } }, localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'agy', installer: HARNESS_INSTALLERS.antigravity, loginArgv: [], loginSteps: [{ when: 'Choose your color scheme', send: '{enter}' }, { when: 'Terms of Service & Data Use', send: '{enter}{down}{right}{enter}' }, { when: 'Do you trust the contents of this project', send: '{enter}' }, { when: 'Select login method', send: '{enter}' }, { when: 'paste the authorization code below', ask: { prompt: 'Paste the code from the Google page' } }], authFiles: [{ path: '~/.gemini/antigravity-cli/antigravity-oauth-token' }], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['models'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--dangerously-skip-permissions'] } }, profileEnv: 'HOME', turn: { startArgv: ['--output-format', 'stream-json'], promptArgvPrefix: ['-p'], resumeIdPrefix: ['--conversation'], output: 'json-lines', responseFields: ['text', 'result', 'response'] }, session: { resumeIdPrefix: ['--conversation'] } },
  // Pi signs in only inside its own session (`/login`); `pi auth` just prints
  // or checks credentials. The steps type /login, its method/provider menus
  // and key field are read on ClikCode's screen, and Ctrl+D leaves once it
  // says the credentials are saved (verified 2026-10-03, pi 0.87 signed out).
  { command: 'pi', freePlan: { suffix: ':free' }, provider: 'pi', displayName: 'Pi Coding Agent', surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'pi-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, effortValues: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], localAuth: ['api-key', 'oauth', 'vendor-cli'], loginArgv: [], binary: 'pi', npmPackage: '@earendil-works/pi-coding-agent', loginSteps: [{ when: '/login to log into a provider', send: '/login{enter}' }, { when: 'Credentials saved to', send: '{ctrl-d}' }], loginKeyRoutes: providerKeyRoutes(['Sign in with an API key'], {
    anthropic: 'Anthropic', openrouter: 'OpenRouter', openai: 'OpenAI', google: 'Google', xai: 'xAI', groq: 'Groq', cerebras: 'Cerebras', huggingface: 'Hugging Face',
    fireworks: 'Fireworks', mistral: 'Mistral', deepseek: 'DeepSeek', moonshot: 'Moonshot AI', 'moonshot-cn': 'Moonshot AI CN', zai: 'Z.AI', minimax: 'MiniMax', together: 'Together',
  }), authFiles: [{ path: '${PI_CODING_AGENT_DIR:-~/.pi/agent}/auth.json', contains: '"type"' }], modelDiscoveryArgv: ['--list-models'], modelProviderSeparator: '/', modelArgvPrefix: ['--model'], effortArgvPrefix: ['--thinking'], imageArgvPrefix: ['@'], imageArgvStyle: 'concatenated', profileEnv: 'PI_CODING_AGENT_DIR', turn: { startArgv: ['-p', '--mode', 'json'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session'], output: 'json-lines', responseFields: ['text', 'content'], extensionArgv: ['-e'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session'] } },
  // Checked against droid 0.223.0: `droid exec` takes -m/--model,
  // -r/--reasoning-effort, --cwd, -s/--session-id, --auto low|medium|high and
  // --skip-permissions-unsafe, all as declared here. Two things were missing:
  // it ships on npm as plain `droid` (so ClikCode can install it), and its
  // --output-format accepts stream-json, which `zzz` does not -- the reject
  // is how the accepted set was confirmed, since --help swallows the flag
  // before it is validated.
  { command: 'droid', provider: 'factory', displayName: 'Factory Droid', planMode: { option: 'spec-mode', value: true }, surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['exec', '--output-format', 'acp'], optionPlacement: 'after', listsModels: true }, effortValues: ['low', 'medium', 'high', 'xhigh'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'droid', npmPackage: 'droid', loginArgv: [], loginSteps: [{ when: 'Please login with your Factory account', send: '{enter}' }], authFiles: [{ path: '${FACTORY_HOME_OVERRIDE:-~/.factory}/auth.v2.file' }, { path: '${FACTORY_HOME_OVERRIDE:-~/.factory}/auth.v2.key' }, { path: '${FACTORY_HOME_OVERRIDE:-~/.factory}/auth.v2.keyring' }, { path: '${FACTORY_HOME_OVERRIDE:-~/.factory}/auth.encrypted' }], authEnv: ['FACTORY_API_KEY'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--reasoning-effort'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--skip-permissions-unsafe'] }, auto: { argv: ['--auto', 'low'] } }, turn: { startArgv: ['exec', '--output-format', 'stream-json'], resumeIdPrefix: ['--session-id'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { resumeIdPrefix: ['--session-id'] } },
  // Checked against a real install (`curl -fsSL https://cli.kiro.dev/install`):
  // chat takes --model, --effort, -r/--resume, --resume-id, -a/--trust-all-tools
  // and --output-format stream-json ("JSON Lines on stdout", which implies
  // --no-interactive). Everything here was already right except --model,
  // which the CLI has and this entry did not.
  { command: 'kiro', freePlan: { listed: true }, provider: 'kiro', displayName: 'Kiro CLI', surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['acp'], optionPlacement: 'after' }, effortValues: ['low', 'medium', 'high', 'xhigh', 'max'], localAuth: ['api-key', 'oauth', 'vendor-cli'], loginRemoteArgv: ['login', '--license', 'free', '--use-device-flow'], loginArgv: ['login'], logoutArgv: ['logout'], statusArgv: ['whoami'], binary: 'kiro-cli', installer: HARNESS_INSTALLERS.kiro, modelArgvPrefix: ['--model'], effortArgvPrefix: ['--effort'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--trust-all-tools'] } }, turn: { promptGuard: 'double-dash', startArgv: ['chat', '--no-interactive', '--agent-engine', 'v3', '--output-format', 'stream-json'], resumeIdPrefix: ['--resume-id'], output: 'json-lines', responseFields: ['text', 'content', 'result'] }, session: { resumeIdPrefix: ['chat', '--resume-id'], discoverArgv: ['chat', '--list-sessions', '--format', 'json'], discoverFormat: 'json' } },
  // Sign-in (2026-10-03, real qwen 0.24 signed out): its provider menus and
  // key/model boxes are read on ClikCode's screen; once configured it sits in
  // its chat, which the step quits.
  // Qwen signs in only through its own /auth screen (0.25: Qwen OAuth is
  // discontinued, `qwen auth` removed). /auth asks plan, region -- US
  // (Virginia) included -- key and models, and saves them in settings.json
  // with security.auth.selectedType, so that is the one sign-in file. A bare
  // DASHSCOPE_API_KEY is not a sign-in to Qwen: it needs the region and
  // method from settings too, so there is no ClikCode API-key path here.
  // Its menus are answered from the key: every endpoint /auth offers, in its
  // own words, and the first that accepts the key picks plan and region. A
  // QwenCloud key (sk-ws-, home.qwencloud.com) lands on Singapore; US
  // (Virginia) refuses it, which is how a hand-picked region failed.
  // /auth's last step, Model IDs, is answered here, never asked: Enter applies
  // the models it pre-checks -- the plan's own list, which Coding Plan and
  // Token Plan read from the endpoint -- and the session lists what it saved.
  { command: 'qwen', provider: 'qwen', displayName: 'Qwen Code', surface: 'terminal', tier: 'more', npmPackage: '@qwen-code/qwen-code', transport: 'acp', integration: 'structured', parser: 'claude-stream-json', memoryFile: 'QWEN.md', nativeSlashPassthrough: false, customCommandDirs: ['.qwen/commands', '~/.qwen/commands'], acp: { argv: ['--acp'], probeArgv: ['--allowed-mcp-server-names', 'clikcode-probe-none'] }, normalizedPermissionOptionIds: ['approval-mode'], localAuth: ['vendor-cli'], binary: 'qwen', loginArgv: [], loginKeyRoutes: [{ url: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions', choose: ['Alibaba ModelStudio', 'Standard API Key', 'US (Virginia)'] }, { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', choose: ['Alibaba ModelStudio', 'Standard API Key', 'Singapore'] }, { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', choose: ['Alibaba ModelStudio', 'Standard API Key', 'China (Beijing)'] }, { url: 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', choose: ['Alibaba ModelStudio', 'Standard API Key', 'China (Hong Kong)'] }, { url: 'https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions', choose: ['Alibaba ModelStudio', 'Coding Plan', 'Singapore'] }, { url: 'https://coding.dashscope.aliyuncs.com/v1/chat/completions', choose: ['Alibaba ModelStudio', 'Coding Plan', 'China (Beijing)'] }, { url: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions', choose: ['Alibaba ModelStudio', 'Token Plan', 'Singapore'] }, { url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', choose: ['Alibaba ModelStudio', 'Token Plan', 'China (Beijing)'] }], loginSteps: [{ when: 'Enter model IDs directly', send: '{enter}' }, { when: 'Type your message', send: '/quit{enter}' }], authFiles: [{ path: '${QWEN_HOME:-~/.qwen}/settings.json', contains: '"selectedType"' }], modelArgvPrefix: ['--model'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--approval-mode', 'default'] }, bypass: { argv: ['--approval-mode', 'yolo'] }, auto: { argv: ['--approval-mode', 'auto'] } }, profileEnv: 'QWEN_HOME', turn: { startArgv: ['-p', '--output-format', 'stream-json', '--include-partial-messages'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--resume'], discoverArgv: ['sessions', 'list', '--json'], discoverFormat: 'json-lines' } },
  // CLINE_SESSION_BACKEND_MODE=local runs the session inside the ACP child.
  // Left on `auto`, the first prompt starts a `--cline-hub-daemon` (~200 MB,
  // its own process group) that outlives the chat, and ClikCode's sandboxed
  // runs too. Measured on 3.0.68: same session files, session/load resumes,
  // and no daemon.
  { command: 'cline', freePlan: { suffix: ':free' }, provider: 'cline', displayName: 'Cline CLI', planMode: { option: 'plan', value: true }, surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'cline-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['--acp'], listsModels: true, usageFile: { path: '~/.cline/data/sessions/{id}/{id}.json', field: ['metadata', 'usage'] } }, effortValues: ['none', 'low', 'medium', 'high', 'xhigh'], normalizedPermissionOptionIds: ['auto-approve'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'cline', npmPackage: 'cline', authFiles: [{ path: '~/.cline/data/settings/providers.json', contains: '"auth"' }, { path: '~/.cline/data/settings/providers.json', contains: '"apiKey"' }], loginArgv: ['auth'], loginAccountChoose: ['Sign in with Cline'], loginKeyRoutes: providerKeyRoutes(['Bring your own provider'], {
    anthropic: 'Anthropic', openrouter: 'OpenRouter', openai: 'OpenAI', google: 'Google Gemini', xai: 'xAI', groq: 'Groq', cerebras: 'Cerebras', huggingface: 'Hugging Face',
    fireworks: 'Fireworks AI', mistral: 'Mistral', deepseek: 'DeepSeek', moonshot: 'Moonshot AI', 'moonshot-cn': 'Moonshot AI (China)', zai: 'Z.AI', minimax: 'MiniMax (minimax.io)', together: 'Together AI',
  }), modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--cwd'], effortArgvPrefix: ['--thinking'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: ['--auto-approve', 'false'] }, bypass: { argv: ['--auto-approve', 'true'] } }, turn: { startArgv: ['--json'], resumeIdPrefix: ['--id'], output: 'json-lines', responseFields: ['text', 'content', 'result'] }, turnEnv: { CLINE_SESSION_BACKEND_MODE: 'local' }, session: { resumeIdPrefix: ['--id'] } },
  { ...OPENCODE_FORK_BASE, command: 'kilo', freePlan: { suffix: ':free' }, loginAccountChoose: ['Kilo Gateway'], provider: 'kilo', displayName: 'Kilo Code CLI', tier: 'more', binary: 'kilo', authFiles: [{ path: '${XDG_DATA_HOME:-~/.local/share}/kilo/auth.json', contains: '"type"' }], npmPackage: '@kilocode/cli', permissionModes: ['ask', 'auto'], permissionArgv: { ask: { argv: [] }, auto: { argv: ['--auto'] } } },
  { command: 'cursor', provider: 'cursor', displayName: 'Cursor Agent', planMode: { option: 'mode', value: 'plan' }, surface: 'terminal', tier: 'primary', transport: 'acp', acp: { argv: ['acp'], inheritCliOptions: false, listsModels: true }, integration: 'structured', parser: 'cursor-stream-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, customCommandDirs: ['.cursor/commands', '~/.cursor/commands'], normalizedPermissionOptionIds: ['auto-review', 'force'], replyErrorPatterns: CURSOR_REPLY_ERRORS, localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'cursor-agent', installer: HARNESS_INSTALLERS.cursor, loginArgv: ['login'], statusArgv: ['status', '--format', 'json'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--workspace'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--force'] }, auto: { argv: ['--auto-review'] } }, turn: { promptGuard: 'double-dash', startArgv: ['-p', '--output-format', 'stream-json', '--stream-partial-output'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { createSessionArgv: ['create-chat'], resumeIdPrefix: ['--resume'] } },
  // Checked against the installed CLI. `hermes model` is an interactive picker
  // and there is no `models list`; the configured model is `hermes config get
  // model --json` (`default`). ACP (`hermes acp`) is the turn that streams
  // tool calls. `chat --quiet` is only the text fallback.
  // Hermes is one ClikCode account over many inference providers. A model id
  // is `provider:model`, so choosing a model chooses the provider, and the old
  // separate provider option is retired. `hermes login` was removed upstream
  // (it prints a notice and exits 0), so signing in is `hermes model`, and a
  // single provider is `hermes auth add <provider>`, which picks OAuth or an
  // API key for that provider itself.
  { command: 'hermes', freePlan: { suffix: ':free' }, loginAccountChoose: ['Nous Portal'], provider: 'nous', displayName: 'Hermes', turboFit: true, surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['acp'], listsModels: false, usageTotals: 'session' }, effortValues: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], normalizedPermissionOptionIds: ['yolo'], localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'hermes', installer: HARNESS_INSTALLERS.hermes, loginArgv: ['model'], loginKeyRoutes: providerKeyRoutes([], {
    anthropic: ['Anthropic', 'Anthropic API key'], openrouter: 'OpenRouter', openai: ['OpenAI', 'OpenAI API'], google: 'Google AI Studio', xai: ['xAI Grok', 'xAI'],
    huggingface: 'Hugging Face Inference Providers', fireworks: 'Fireworks AI', deepseek: 'DeepSeek', moonshot: ['Kimi / Moonshot', 'Kimi / Kimi Coding Plan'],
    'moonshot-cn': ['Kimi / Moonshot', 'Kimi / Moonshot (China)'], zai: ['Z.AI / GLM', 'Global (https://api.z.ai/api/paas/v4)'], minimax: ['MiniMax', 'MiniMax'],
  }), providerLoginArgv: ['auth', 'add', '{provider}'], authFiles: HERMES_AUTH_FILES, logoutArgv: ['logout'], retiredOptionIds: ['provider'], replyErrorPatterns: HERMES_REPLY_ERRORS, modelArgvPrefix: ['--model'], modelProviderArgvPrefix: ['--provider'], workspaceArgvPrefix: ['--in'], effortArgvPrefix: ['--reasoning'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: [] }, bypass: { argv: ['--yolo'] } }, imageArgvPrefix: ['--image'], profileEnv: 'HERMES_HOME', turn: { startArgv: ['chat', '--quiet'], resumeIdPrefix: ['--resume'], promptArgvPrefix: ['--query'], output: 'text' }, session: { resumeIdPrefix: ['--resume'], discoverArgv: ['sessions', 'list', '--limit', '50'], discoverFormat: 'text', discoverAllFolders: true } },
  // Same kind of product as Hermes, not a fork; checked against a real
  // install (OpenClaw 2026.9.6). The one-shot turn is `agent --local --json`,
  // whose answer is `meta.finalAssistantVisibleText` -- the generic fields
  // also match `meta.executionTrace…result: "success"`, which used to become
  // the reply. Without --session-id every turn joins the shared
  // `agent:main:main` session, so each chat gets its own. A model is
  // `provider/model` and --model takes it whole; one provider signs in with
  // `models auth login --provider <id>`, the whole setup is `onboard`. The
  // CLI back ends (a Claude Code login) keep no history between --local
  // turns, so those turns carry ClikCode's transcript instead.
  { command: 'openclaw', provider: 'openclaw', displayName: 'OpenClaw', surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, npmPackage: 'openclaw', localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'openclaw', loginArgv: ['onboard'], loginSteps: [{ when: 'How would you like to start?', send: '{enter}' }, { when: 'What would you like to create?', send: '{enter}' }],
    // After the key OpenClaw saves it and comes back to its provider list
    // (its route check fails even for a key that works): Skip for now ends
    // the onboarding. A provider's plugin is installed the first time only.
    loginKeyRoutes: providerKeyRoutes([], {
      openai: ['OpenAI', 'OpenAI API Key'], openrouter: ['OpenRouter', 'OpenRouter API key'], xai: ['xAI (Grok)', 'xAI API key'], google: 'Google', anthropic: ['Anthropic', 'Anthropic API key'],
      cerebras: ['More…', 'Cerebras'], deepseek: ['More…', 'DeepSeek'], fireworks: ['More…', 'Fireworks'], groq: ['More…', 'Groq'], huggingface: ['More…', 'Hugging Face'],
      minimax: ['More…', 'MiniMax', 'MiniMax API key (Global)'], mistral: ['More…', 'Mistral AI'], moonshot: ['More…', 'Moonshot AI', 'Moonshot API key (.ai)'],
      'moonshot-cn': ['More…', 'Moonshot AI', 'Moonshot API key (.cn)'], together: ['More…', 'Together AI'], zai: ['More…', 'Z.AI', 'Global'],
    }).map((route) => ({ ...route, choose: [...route.choose, '?Download from npm', 'Skip for now'] })), providerLoginArgv: ['models', 'auth', 'login', '--provider', '{provider}'], modelProviderSeparator: '/', statusArgv: ['models', 'status'], modelArgvPrefix: ['--model'], effortArgvPrefix: ['--thinking'], effortValues: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra'], profileEnv: 'OPENCLAW_STATE_DIR', turn: { startArgv: ['agent', '--local', '--json', '--agent', 'main'], resumeArgv: ['agent', '--local', '--json', '--agent', 'main'], createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session-id'], resumeKeyPrefix: ['--session-key'], promptArgvPrefix: ['--message'], output: 'json', responseFields: ['finalAssistantVisibleText'], statelessRoute: { path: ['meta', 'systemPromptReport', 'provider'], values: ['claude-cli', 'google-gemini-cli'] } }, session: { idKind: 'uuid', createIdPrefix: ['--session-id'], resumeIdPrefix: ['--session-id'], resumeKeyPrefix: ['--session-key'], discoverArgv: ['sessions', '--json', '--limit', '50'], discoverFormat: 'json', discoverAllFolders: true } },
  // Stays on its one-shot CLI, not `cmdc acp` (checked on 1.74.1, sandbox):
  // the ACP agent initializes, opens, loads (a written thread replays) and
  // shares the CLI's session files, but offers and accepts only Command
  // Code's gateway models -- a BYOK model (`mock/mock-model` from
  // providers.json) is "Unknown model" over ACP, while the CLI runs it.
  { command: 'command', provider: 'command-code', displayName: 'Command Code', planMode: { option: 'plan', value: true }, surface: 'terminal', tier: 'more', transport: 'structured-cli', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, effortValues: ['low', 'medium', 'high'], profileEnvPassthrough: HOME_REDIRECT_ENV_PASSTHROUGH, localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'cmdc', npmPackage: 'command-code', loginArgv: ['login'], statusArgv: ['status'], logoutArgv: ['logout'], modelArgvPrefix: ['--model'], modelDiscoveryArgv: ['--list-models'], effortArgvPrefix: ['--effort'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--permission-mode', 'standard'] }, bypass: { argv: ['--yolo'] }, auto: { argv: ['--permission-mode', 'auto-accept'] } }, profileEnv: 'HOME', turn: { startArgv: ['--print', '--output-format', 'json', '--skip-onboarding', '--no-auto-update'], resumeIdPrefix: ['--resume'], output: 'json-lines', responseFields: ['result', 'response', 'text'] }, session: { resumeIdPrefix: ['--resume'] } },
  // ---- Added from vendor documentation; none of these binaries was available
  // to run live, so every one-shot contract below is `experimental` and only
  // flags the vendor documents are declared. No session selectors are claimed:
  // an absent `session` means ClikCode launches but never pretends to resume.
  // Kimi CLI (MoonshotAI): `kimi --acp` is the documented ACP entry point and
  // the preferred transport. `--print` is its non-interactive mode and
  // `--command` carries the prompt; stream-json output is left undeclared.
  // Rewritten against the real CLI (Kimi Code 2.0.2, `@moonshot-ai/kimi-code`
  // on npm -- pypi's `kimi-cli` is the wound-down Python predecessor and npm's
  // bare `kimi-cli` is an unrelated front-end generator). The previous entry
  // could not have run a turn: it passed --print and --command, and this CLI
  // has neither; the flags are -p/--prompt and --output-format stream-json.
  // ACP is a subcommand here, not a --acp flag.
  //
  // The permission names invert: -y/--yolo is "Ask When Needed" (routine edits
  // run, risky ones still ask) and --auto is "Never Ask". So yolo maps to
  // ClikCode's `auto` and --auto maps to `bypass`, which is the opposite of
  // what the spellings suggest.
  //
  // Its sign-in is two files: `login` writes the provider (and where its OAuth
  // token lives) into config.toml, and the token into credentials/. Either
  // alone is not a sign-in -- "no provider configured" without the first.
  { command: 'kimi', provider: 'kimi', displayName: 'Kimi CLI', surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['acp'] }, experimental: true, localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'kimi', npmPackage: '@moonshot-ai/kimi-code', authFiles: [{ path: '${KIMI_CODE_HOME:-~/.kimi-code}/credentials/' }, { path: '${KIMI_CODE_HOME:-~/.kimi-code}/config.toml', contains: '[providers.' }], authEnv: ['KIMI_API_KEY'], loginArgv: ['login', '--region', 'global'], modelArgvPrefix: ['--model'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--plan'] }, bypass: { argv: ['--auto'] }, auto: { argv: ['--yolo'] } }, turn: { startArgv: ['--output-format', 'stream-json'], promptArgvPrefix: ['--prompt'], output: 'json-lines', responseFields: ['text', 'content', 'response', 'result'] }, session: { resumeIdPrefix: ['--session'] } },
  // Augment Auggie: `--print` with `--output-format json` returns one JSON
  // document; `--acp` is documented. The JSON field holding the answer is not
  // confirmed, so responseFields is the usual best-effort list.
  // Read from `auggie --help` on a real install: -w/--workspace-root,
  // -c/--continue, -r/--resume [sessionId], --reasoning-effort <effort>.
  // No effortValues: the flag is real but the levels it accepts are
  // undocumented, and a picker offering invented ones is worse than a picker
  // offering none. -a/--ask is deliberately NOT mapped to the `ask`
  // permission mode -- it means "retrieval and non-editing tools only", which
  // is read-only, not approval-prompting, so mapping it would quietly make
  // the harness unable to edit whenever someone chose Ask.
  // turn.resumeIdPrefix, live against auggie 0.36.0 (2026-10-05,
  // vendor-sandbox): `--print --output-format json --resume <id>` reported the
  // same session_id and appended its request to that `<id>.json` as the
  // second exchange (one file, chatHistory 1 -> 2) -- the file is the history
  // auggie sends. The account was out of usage, so the model's recall is unproved.
  { command: 'auggie', provider: 'augment', displayName: 'Augment Auggie', replyErrorPatterns: AUGGIE_REPLY_ERRORS, planMode: { option: 'ask', value: true }, surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, customCommandDirs: ['.augment/commands', '~/.augment/commands'], acp: { argv: ['--acp'] }, experimental: true, localAuth: ['oauth', 'vendor-cli'], binary: 'auggie', npmPackage: '@augmentcode/auggie', statusArgv: ['account', 'status'], loginArgv: ['login', '--headless'], logoutArgv: ['logout'], modelDiscoveryArgv: ['model', 'list'], modelArgvPrefix: ['--model'], workspaceArgvPrefix: ['--workspace-root'], effortValues: ['low', 'medium', 'high'], effortArgvPrefix: ['--reasoning-effort'], imageArgvPrefix: ['--image'], turn: { startArgv: ['--print', '--output-format', 'json'], resumeIdPrefix: ['--resume'], output: 'json', responseFields: ['result', 'response', 'text'], quotaSignals: ['You have run out of usage for', 'run out of usage'] }, session: { resumeIdPrefix: ['--resume'] } },
  // Mistral Vibe ships ACP as a SEPARATE executable, `vibe-acp`, with no argv.
  // `vibe --prompt` is its documented programmatic mode (plain text).
  // Read from mistral-vibe on a real install (pip/uv, not npm, so there is no
  // npmPackage to declare). ACP stays the primary path -- `vibe-acp` is a
  // binary it really ships -- and the CLI fallback below is no longer a
  // text-only stub: --output streaming is documented as "newline-delimited
  // JSON per message", and its agents (ask / smart-approve / auto-approve)
  // map onto the three permission modes without inventing anything.
  // Sign-in (2026-10-03, real vibe signed out): the steps pass its animated
  // welcome and theme screens; its method cards, provider choice, browser link
  // and titled key field are read on ClikCode's screen.
  { command: 'vibe', loginAccountChoose: ['Launch browser'], provider: 'mistral-vibe', displayName: 'Mistral Vibe', surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { binary: 'vibe-acp', argv: [], listsModels: true, usageTotals: 'session', cumulativeChunks: true }, experimental: true, localAuth: ['api-key', 'vendor-cli'], binary: 'vibe', installer: HARNESS_INSTALLERS.vibe, loginArgv: ['--setup'], loginKeyRoutes: providerKeyRoutes([], { mistral: 'Use an API key' }), loginSteps: [{ when: 'Where do you sign in?', send: '{enter}' }, { when: 'Welcome to Mistral Vibe - Let', send: '{enter}' }, { when: 'Select your preferred theme', send: '{enter}' }], authFiles: [{ path: '${VIBE_HOME:-~/.vibe}/.env', contains: 'MISTRAL_API_KEY=', removeLine: true }], authEnv: ['MISTRAL_API_KEY'], profileEnv: 'VIBE_HOME', modelArgvPrefix: [], workspaceArgvPrefix: ['--workdir'], permissionModes: ['ask', 'bypass', 'auto'], permissionArgv: { ask: { argv: ['--agent', 'ask'] }, bypass: { argv: ['--auto-approve'] }, auto: { argv: ['--smart-approve'] } }, turn: { startArgv: ['--output', 'streaming'], promptArgvPrefix: ['--prompt'], output: 'json-lines', responseFields: ['text', 'content', 'response', 'result'] }, session: { resumeIdPrefix: ['--resume'] } },
  // OpenHands CLI: `openhands acp` is documented; headless is `--headless`
  // with the task in `-t`. Its JSON event mode is left undeclared.
  // Checked against the real CLI (OpenHands SDK v1.21.0, `uv tool install
  // openhands`): --headless and the `acp` subcommand both exist, as declared.
  // Worth recording why that needed checking twice: PyPI's `openhands-ai` is
  // the OLD distribution, pinned below 1.0 on this machine's Python, and it
  // has neither -- the package moved to plain `openhands`, and reading the
  // stale one made a correct entry look broken.
  //
  // --json is documented as "Streams JSONL event outputs", so the turn reads
  // as lines rather than text. Only bypass and auto are offered: --headless
  // auto-approves by definition ("no UI output, auto-approve actions"), so an
  // `ask` mode on this path would be a promise the CLI cannot keep. The ACP
  // path above is the one that can actually prompt.
  { command: 'openhands', provider: 'openhands', displayName: 'OpenHands CLI', surface: 'terminal', tier: 'more', transport: 'acp', integration: 'structured', parser: 'generic-json', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, acp: { argv: ['acp'] }, experimental: true, localAuth: ['api-key', 'vendor-cli'], binary: 'openhands', installer: HARNESS_INSTALLERS.openhands, authFiles: [{ path: '${OPENHANDS_PERSISTENCE_DIR:-~/.openhands}/cloud/api_key.txt' }, { path: '${OPENHANDS_PERSISTENCE_DIR:-~/.openhands}/agent_settings.json', contains: 'api_key' }], authEnv: ['LLM_API_KEY'], loginArgv: ['login'], logoutArgv: ['logout'], permissionModes: ['bypass', 'auto'], permissionArgv: { bypass: { argv: ['--always-approve'] }, auto: { argv: ['--llm-approve'] } }, turn: { startArgv: ['--headless', '--json'], promptArgvPrefix: ['-t'], output: 'json-lines', responseFields: ['text', 'content', 'response', 'result'] }, session: { resumeIdPrefix: ['--resume'] } },
  // Continue CLI: `cn -p` is the documented headless mode and prints the final
  // answer as text. No ACP mode is declared because none is documented.
  // Flags read from `cn --help` on a real install: -p/--print for headless,
  // --model <slug>, and a permission surface of --readonly (plan, read-only
  // tools) / --auto (all tools allowed) / --allow / --exclude. `--format json`
  // exists too but is left unwired: the flag is documented, the shape its
  // output takes is not, and a parser declared against an unverified shape
  // fails at the one moment it matters.
  { command: 'cn', provider: 'continue', displayName: 'Continue', surface: 'terminal', tier: 'more', transport: 'text-cli', integration: 'compatibility', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, experimental: true, localAuth: ['api-key', 'oauth', 'vendor-cli'], binary: 'cn', npmPackage: '@continuedev/cli', loginArgv: [], authFiles: [{ path: '${CONTINUE_GLOBAL_DIR:-~/.continue}/config.yaml', contains: 'apiKey:' }], authEnv: ['ANTHROPIC_API_KEY'], modelArgvPrefix: ['--model'], permissionModes: ['ask', 'bypass'], permissionArgv: { ask: { argv: ['--readonly'] }, bypass: { argv: ['--auto'] } }, turn: { startArgv: [], promptArgvPrefix: ['-p'], output: 'text' } },
  // ACP entrypoints checked against each vendor's own source. Devin CLI and
  // MiniMax Code also have session stores and native-thread writers, and
  // their failover carry was verified live on 2026-10-05: Devin with signed-in
  // ACP turns, MiniMax Code only against a local stub model (its sign-ins had
  // expired). Deep Agents Code and Junie have run no turn. All four stay in
  // the experimental picker tier until each has run signed-in turns on its
  // own models through ClikCode's normal path.
  { command: 'dcode', provider: 'deepagents-code', displayName: 'Deep Agents Code', surface: 'terminal', tier: 'experimental', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, experimental: true, acp: { argv: ['--acp'], optionPlacement: 'after' }, localAuth: ['api-key', 'vendor-cli'], binary: 'dcode', installer: HARNESS_INSTALLERS.dcode, loginArgv: [], loginKeyCommand: { providersArgv: ['auth', 'list'], setArgv: ['auth', 'set', '{provider}'] },
    // Its provider names (`dcode auth list`), for the key's provider.
    loginKeyRoutes: providerKeyRoutes([], { anthropic: 'anthropic', openai: 'openai', google: 'google_genai' }), authEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'], modelArgvPrefix: ['--model'] },
  { command: 'devin', freePlan: { listed: true }, loginAccountChoose: ['Log in with browser'], provider: 'devin', displayName: 'Devin CLI', surface: 'terminal', tier: 'experimental', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, experimental: true, acp: { argv: ['acp'], optionPlacement: 'after' }, localAuth: ['oauth', 'api-key', 'vendor-cli'], binary: 'devin', installer: HARNESS_INSTALLERS.devin, loginArgv: ['auth', 'login'], statusArgv: ['auth', 'status'], logoutArgv: ['auth', 'logout'], authEnv: ['WINDSURF_API_KEY'], modelArgvPrefix: ['--model'] },
  { command: 'junie', provider: 'junie', displayName: 'Junie CLI', surface: 'terminal', tier: 'experimental', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, experimental: true, acp: { argv: ['--acp', 'true'] }, localAuth: ['oauth', 'api-key', 'vendor-cli'], binary: 'junie', installer: HARNESS_INSTALLERS.junie, loginArgv: [], authEnv: ['JUNIE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], modelArgvPrefix: ['--model'], effortArgvPrefix: ['--effort'], effortValues: ['low', 'medium', 'high'] },
  // Sign-in evidence: the OAuth record `mcode login` writes under
  // ~/.minimax/auth/prod/<region>/<client>/auth.json (vendor-identity.ts
  // reads the same record for the account's email).
  { command: 'mcode', provider: 'minimax-code', displayName: 'MiniMax Code', surface: 'terminal', tier: 'experimental', transport: 'acp', integration: 'structured', parser: 'text', memoryFile: 'AGENTS.md', nativeSlashPassthrough: false, experimental: true, acp: { argv: ['acp'] }, localAuth: ['oauth', 'api-key', 'vendor-cli'], binary: 'mcode', installer: HARNESS_INSTALLERS.mcode, loginArgv: ['login', '--region', 'global'], logoutArgv: ['logout'], authFiles: [{ path: '~/.minimax/auth/prod/*/*/auth.json', contains: '"accessToken"' }], authEnv: ['MCODE_PROVIDER_API_KEY'] },
];

/** Every native-login account gets its own vendor configuration root by
 * default. Harnesses with a documented root declare it; the remaining CLIs
 * use an isolated HOME. */
export const AI_LOCAL_HARNESSES: readonly AiLocalHarnessDefinition[] = CATALOG_HARNESSES.map((harness) => {
  if (harness.profileEnv) return harness;
  return { ...harness, profileEnv: 'HOME', profileEnvPassthrough: HOME_REDIRECT_ENV_PASSTHROUGH };
});

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
      // User scope: Claude's default is the current folder only. `--` keeps a
      // local server's own dash arguments from being read as Claude's options.
      mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.claude.json'], rootRelative: ['.claude.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'], remove: { argv: ['mcp', 'remove', '--scope', 'user'] }, add: { argv: ['mcp', 'add', '--scope', 'user'], shape: 'doubledash-local', transportPrefix: ['--transport'], headerPrefix: ['--header'], envPrefix: ['--env'] } },
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
      mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.codex', 'config.toml'], rootRelative: ['config.toml'], format: 'toml', key: ['mcp_servers'], dialect: 'codex' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'] , remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add'], shape: 'url-or-doubledash' }},
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
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.config', 'opencode', 'opencode.json'], format: 'jsonc', key: ['mcp'], dialect: 'opencode' }, { homeRelative: ['.config', 'opencode', 'opencode.jsonc'], format: 'jsonc', key: ['mcp'], dialect: 'opencode' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'], add: { argv: ['mcp', 'add'], shape: 'named-flags', urlPrefix: ['--url'], remoteOnly: true } }, agents: { label: 'Agents', manageArgv: ['agent'] } },
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
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.copilot', 'mcp-config.json'], rootRelative: ['mcp-config.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' }], listArgv: ['mcp', 'list', '--json'], manageArgv: ['mcp'] , remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add'], shape: 'doubledash-local', transportPrefix: ['--transport'] }}, plugins: { label: 'Plugins', manageArgv: ['plugin'] }, skills: { label: 'Skills', manageArgv: ['skill'] }, agents: { label: 'Instructions and agents', manageArgv: ['instruction'] } },
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
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.config', 'goose', 'config.yaml'], format: 'yaml', key: ['extensions'], dialect: 'goose' }], writesServerFile: true, manageArgv: ['configure'] }, skills: { label: 'Skills', listArgv: ['skills', 'list'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] } },
    features: ['extensions', 'recipes', 'ACP', 'scheduled recipes', 'session export'],
  },
  // MCP surfaces read from each CLI's own --help on a real install. These
  // three support MCP and had no capability entry at all, so ClikCode offered
  // them no /mcp even though the harness has one.
  //
  // Options read from `grok --help`: --allow/--deny are permission RULES (the
  // --allowedTools/--disallowedTools aliases sit beside them), while
  // --disallowed-tools removes built-in tools outright. --always-approve is
  // deliberately absent: it is a bypass-permission spelling the permission
  // selector already owns, and a raw row beside it would disagree with Ask.
  grok: {
    options: [
      value('agent', 'Agent', 'Agent name or definition file used for the session', 'mode', ['--agent']),
      value('allow', 'Allowed tools', 'Permission allow rules for tools', 'permissions', ['--allow'], 'string-list', { argvStyle: 'repeat' }),
      value('deny', 'Denied tools', 'Permission deny rules for tools', 'permissions', ['--deny'], 'string-list', { argvStyle: 'repeat' }),
      value('disallowed-tools', 'Removed built-in tools', 'Built-in tools to remove, comma-separated', 'tools', ['--disallowed-tools'], 'string-list', { argvStyle: 'csv' }),
      flag('disable-web-search', 'Disable web search', 'Disable web search and web fetch tools', 'tools', ['--disable-web-search']),
      flag('no-subagents', 'Disable subagents', 'Disable subagent spawning', 'mode', ['--no-subagents']),
      flag('no-plan', 'Disable plan mode', 'Skip the plan phase before execution', 'mode', ['--no-plan']),
      value('rules', 'Rules', 'Extra rules appended to the system prompt', 'context', ['--rules'], 'path'),
      value('sandbox', 'Sandbox', 'Sandbox profile for filesystem and network access', 'safety', ['--sandbox']),
      value('system-prompt', 'System prompt', 'Override the agent system prompt', 'context', ['--system-prompt-override']),
      value('tools', 'Built-in tools', 'Built-in tools to allow, comma-separated', 'tools', ['--tools'], 'string-list', { argvStyle: 'csv' }),
      flag('verbatim', 'Verbatim prompt', 'Send the prompt exactly as given', 'output', ['--verbatim']),
      value('json-schema', 'Output schema', 'JSON schema constraining the final response', 'output', ['--json-schema']),
      value('max-turns', 'Maximum turns', 'Maximum number of agent turns', 'safety', ['--max-turns'], 'number'),
      flag('worktree', 'Managed worktree', 'Start the session in a new Git worktree', 'session', ['--worktree'], { requiresNewSession: true }),
      flag('fork-session', 'Fork on resume', 'Create a new session id when resuming', 'session', ['--fork-session'], { appliesTo: 'resume', requiresNewSession: true }),
    ],
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.grok', 'config.toml'], format: 'toml', key: ['mcp_servers'], dialect: 'codex' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'] , remove: { argv: ['mcp', 'remove', '--scope', 'user'] }, add: { argv: ['mcp', 'add'], shape: 'positional' }}, plugins: { label: 'Plugins', manageArgv: ['plugin'] } },
    features: ['skills', 'plugins', 'subagents', 'plan mode', 'memory'],
  },
  kimi: {
    options: [
      value('agent', 'Agent', 'Agent profile starting the new session', 'mode', ['--agent'], 'string', { appliesTo: 'start', requiresNewSession: true }),
      value('agent-file', 'Agent definition file', 'Markdown agent definition loaded for the session', 'mode', ['--agent-file'], 'path', { appliesTo: 'start', requiresNewSession: true }),
      value('skills-dir', 'Skills directory', 'Load skills from this directory instead of auto-discovery', 'tools', ['--skills-dir'], 'path-list', { argvStyle: 'repeat' }),
      value('add-dir', 'Additional directories', 'Additional workspace directories for the session', 'context', ['--add-dir'], 'path-list', { argvStyle: 'repeat' }),
      // No `plan` row here, and not because the flag is missing: Kimi's own
      // `--help` maps read-only planning to `--plan`, which is already the argv
      // ClikCode sends for Ask permissions. A second `--plan` row would race
      // the permission selector for the same flag on the same turn.
    ],
    // No MCP here: `kimi --help` lists export/fork/provider/session/acp/web/
    // server/rc/login/doctor/vis/install-desktop and mentions mcp nowhere.
    // An earlier entry claimed one on a misreading of that list.
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.kimi-code', 'mcp.json'], rootRelative: ['mcp.json'], rootEnv: 'KIMI_CODE_HOME', format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' }], writesServerFile: true, manageArgv: ['mcp'] },},
    features: ['skills', 'agents', 'ACP'],
  },
  openhands: {
    options: [
      value('file', 'Seed file', 'File whose contents seed the initial conversation', 'context', ['--file'], 'path'),
      flag('exit-without-confirmation', 'Exit without confirmation', 'Exit even when an action would require confirmation', 'safety', ['--exit-without-confirmation']),
      flag('override-with-envs', 'Override env vars', 'Read LLM_API_KEY, LLM_BASE_URL and LLM_MODEL from the environment', 'advanced', ['--override-with-envs']),
    ],
    managers: { mcp: { label: 'MCP servers', listArgv: ['mcp', 'list'], manageArgv: ['mcp'], remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add'], shape: 'positional', transportPrefix: ['--transport'], localTransport: 'stdio' } } },
    features: ['ACP', 'web UI'],
  },
  // Amp is the only harness of the 25 that reports a CREDIT BALANCE rather
  // than spend: `amp usage` is documented as "Show your current Amp usage and
  // credit balance", with --details for a credit/token/thread breakdown.
  //
  // Not wired, and deliberately so: it needs an Amp login to return anything
  // ("Invalid or missing API key"), so its output shape is unverified here. A
  // parser written against a guessed shape would put an invented money figure
  // on screen, which is worse than showing nothing. Wire it from a real
  // response, not from this comment.
  amp: {
    options: [
      value('mcp-config', 'MCP configuration', 'Per-turn MCP server configuration', 'tools', ['--mcp-config']),
      flag('fast', 'Fast mode', 'Use Amp Fast mode for this invocation', 'mode', ['--fast']),
      value('plugin-ready-timeout', 'Plugin startup timeout', 'Wait this many seconds for plugins before starting', 'tools', ['--plugin-ready-timeout'], 'number'),
    ],
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.config', 'amp', 'settings.json'], format: 'json', key: ['amp.mcpServers'], dialect: 'mcp-servers' }], manageArgv: ['mcp'] , remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add'], shape: 'doubledash-local' }} },
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
      mcp: { label: 'MCP servers', listArgv: ['mcp', 'list'], manageArgv: ['mcp'] , remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add'], shape: 'positional', transportPrefix: ['--type'] }},
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
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.factory', 'mcp.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' }], manageArgv: ['mcp'] , remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add'], shape: 'positional', transportPrefix: ['--type'] }}, plugins: { label: 'Plugins', manageArgv: ['plugin'] } },
    features: ['skills', 'custom droids', 'hooks', 'missions', 'auto/spec modes', 'JSON-RPC permission transport'],
  },
  kiro: {
    options: [
      value('agent-engine', 'Agent engine', 'Headless engine version', 'advanced', ['--agent-engine'], 'enum', { values: ['v1', 'v2', 'v3'], requiresNewSession: true }),
      value('trusted-tools', 'Trusted tools', 'Tool categories approved in advance', 'permissions', ['--trust-tools'], 'string-list', { argvStyle: 'csv' }),
      flag('require-mcp-startup', 'Require MCP startup', 'Fail the run if any MCP server cannot start', 'tools', ['--require-mcp-startup']),
    ],
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.kiro', 'settings', 'mcp.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'], remove: { argv: ['mcp', 'remove', '--scope', 'global', '--name'] }, add: { argv: ['mcp', 'add', '--scope', 'global', '--force'], shape: 'named-flags', namePrefix: ['--name'], urlPrefix: ['--url'], commandPrefix: ['--command'], argsPrefix: ['--args'], argsStyle: 'json-array' } } },
    features: ['skills', 'custom agents', 'hooks', 'steering', 'powers', 'plan mode'],
  },
  // Every flag here read from `gemini --help` on a real install. --safe-mode
  // was in the entry this replaces and no longer exists in 0.60.0; --policy
  // and --extensions are new and did not. --allowed-tools is documented as
  // deprecated in favour of the policy engine but still accepted, so it stays
  // until it actually stops working.
  gemini: {
    options: [
      value('approval-mode', 'Approval mode', 'Tool-call approval policy', 'permissions', ['--approval-mode'], 'enum', { values: ['default', 'auto_edit', 'yolo', 'plan'] }),
      value('allowed-tools', 'Allowed tools', 'Tools that bypass confirmation', 'permissions', ['--allowed-tools'], 'string-list'),
      value('policy', 'Policy files', 'Additional policy files or directories to load', 'permissions', ['--policy'], 'path-list'),
      value('allowed-mcp-servers', 'Allowed MCP servers', 'MCP servers enabled for this session', 'tools', ['--allowed-mcp-server-names'], 'string-list'),
      value('include-directories', 'Additional directories', 'Additional directories included in context', 'context', ['--include-directories'], 'path-list'),
      value('extensions', 'Extensions', 'Extensions to load; all are used when unset', 'tools', ['--extensions'], 'string-list'),
    ],
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.gemini', 'settings.json'], format: 'json', key: ['mcpServers'], dialect: 'gemini' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'] , remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add'], shape: 'positional', transportPrefix: ['--transport'] }}, plugins: { label: 'Extensions', listArgv: ['extensions', 'list'], manageArgv: ['extensions'] } },
    features: ['skills', 'agents', 'extensions', 'custom commands', 'memory'],
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
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.qwen', 'settings.json'], format: 'json', key: ['mcpServers'], dialect: 'gemini' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'], remove: { argv: ['mcp', 'remove', '--scope', 'user'] }, add: { argv: ['mcp', 'add'], shape: 'positional', transportPrefix: ['-t'] } }, skills: { label: 'Skills', manageArgv: ['skills'] } },
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
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.cline', 'data', 'settings', 'cline_mcp_settings.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' }], manageArgv: ['mcp'] , remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add', '--yes'], shape: 'doubledash-local', transportPrefix: ['--transport'] }}, plugins: { label: 'Plugins', manageArgv: ['plugin'] }, skills: { label: 'Skills', manageArgv: ['skill'] }, hooks: { label: 'Hooks', manageArgv: ['hook'] } },
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
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.config', 'kilo', 'kilo.json'], format: 'jsonc', key: ['mcp'], dialect: 'opencode' }, { homeRelative: ['.config', 'kilo', 'kilo.jsonc'], format: 'jsonc', key: ['mcp'], dialect: 'opencode' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'], add: { argv: ['mcp', 'add'], shape: 'named-flags', urlPrefix: ['--url'], remoteOnly: true } }, plugins: { label: 'Plugins', manageArgv: ['plugin'] } },
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
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.cursor', 'mcp.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' }], writesServerFile: true, listArgv: ['mcp', 'list'], manageArgv: ['mcp'] }, plugins: { label: 'Plugins', manageArgv: ['plugin'] } },
    features: ['plugins', 'rules', 'worktrees', 'plan/ask modes'],
  },
  // Hermes is deliberately absent from the `mcp add` grammars even though it
  // has one: `hermes mcp add --url ...` opens an interactive prompt ("Does
  // this server require authentication?") and waits on stdin, so driving it
  // headlessly hangs the fan-out rather than failing it. Checked live.
  auggie: {
    // Options read from `auggie --help`. `-a/--ask` stays a raw row, not a
    // permission mode: it means "retrieval and non-editing tools only" (the
    // read-only mode), which is orthogonal to ClikCode's ask/bypass/auto
    // approval modes. --add-workspace folds into the /add-dir control.
    options: [
      value('persona', 'Persona', 'Agent persona used for the session', 'mode', ['--persona']),
      value('add-dir', 'Additional workspaces', 'Additional workspace directories to index', 'context', ['--add-workspace'], 'path-list', { argvStyle: 'repeat' }),
      value('rules', 'Additional rules', 'Additional rules file loaded for the session', 'context', ['--rules'], 'path-list', { argvStyle: 'repeat' }),
      flag('ask', 'Read-only ask mode', 'Retrieval and non-editing tools only', 'mode', ['--ask']),
      value('max-turns', 'Maximum turns', 'Limit the number of agentic turns', 'safety', ['--max-turns'], 'number'),
      value('mcp-config', 'MCP configuration', 'MCP server configuration', 'tools', ['--mcp-config'], 'string-list', { argvStyle: 'repeat' }),
      value('plugin-dir', 'Plugin directories', 'Local plugin marketplace directories', 'tools', ['--plugin-dir'], 'path-list', { argvStyle: 'repeat' }),
      value('permission', 'Tool permissions', 'Tool permission rules in tool-name:policy form', 'permissions', ['--permission'], 'string-list', { argvStyle: 'repeat' }),
      value('remove-tool', 'Removed tools', 'Remove a tool by name', 'tools', ['--remove-tool'], 'string-list', { argvStyle: 'repeat' }),
      value('shell', 'Shell', 'Shell used for commands', 'advanced', ['--shell'], 'enum', { values: ['bash', 'zsh', 'fish', 'sh', 'powershell'] }),
      value('retry-timeout', 'Retry timeout', 'Timeout for rate-limit retries, in seconds', 'safety', ['--retry-timeout'], 'number'),
      value('startup-script', 'Startup script', 'Inline startup script run before each command', 'session', ['--startup-script']),
      value('startup-script-file', 'Startup script file', 'Load the startup script from a file', 'session', ['--startup-script-file'], 'path'),
      flag('enhance-prompt', 'Enhance prompt', 'Enhance the prompt before sending', 'advanced', ['--enhance-prompt']),
      flag('show-cost', 'Show cost', 'Show the billing cost summary at the end of the run', 'output', ['--show-cost']),
      flag('allow-indexing', 'Allow indexing', 'Skip the indexing confirmation screen', 'context', ['--allow-indexing']),
      flag('wait-for-indexing', 'Wait for indexing', 'Wait for workspace indexing before inference', 'context', ['--wait-for-indexing']),
      flag('ephemeral', 'Do not save session', 'Do not save conversation history', 'session', ['--dont-save-session'], { requiresNewSession: true }),
      value('augment-cache-dir', 'Cache directory', 'Cache directory, defaults to ~/.augment', 'advanced', ['--augment-cache-dir'], 'path'),
    ],
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.augment', 'settings.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'], remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add'], shape: 'named-flags', transportPrefix: ['-t'], urlPrefix: ['-u'], commandPrefix: ['-c'], argsPrefix: ['--args'], argsStyle: 'joined' } } },
  },
  vibe: {
    // Options read from `vibe --help`. --smart-approve and --auto-approve are
    // deliberately absent: they are the permission selector's own spellings,
    // and a raw row beside Ask/Bypass/Auto would disagree with the selector.
    options: [
      value('max-turns', 'Maximum turns', 'Maximum number of assistant turns', 'safety', ['--max-turns'], 'number'),
      value('max-price', 'Maximum price', 'Maximum cost in dollars for the session', 'safety', ['--max-price'], 'number'),
      value('max-tokens', 'Maximum tokens', 'Maximum total prompt plus completion tokens', 'safety', ['--max-tokens'], 'number'),
      value('enabled-tools', 'Enabled tools', 'Enable specific tools; disables all others', 'tools', ['--enabled-tools'], 'string-list', { argvStyle: 'repeat' }),
      value('disabled-tools', 'Disabled tools', 'Disable tools after enabled-tools filtering', 'tools', ['--disabled-tools'], 'string-list', { argvStyle: 'repeat' }),
      value('agent', 'Agent', 'Agent used for the session', 'mode', ['--agent']),
      flag('trust', 'Trust workspace', 'Trust the working directory for this invocation only', 'permissions', ['--trust'], { dangerous: true }),
      value('add-dir', 'Additional directories', 'Additional working directories for file access', 'context', ['--add-dir'], 'path-list', { argvStyle: 'repeat' }),
      flag('worktree', 'Managed worktree', 'Run inside a Git worktree under $VIBE_HOME/worktrees', 'session', ['--worktree'], { requiresNewSession: true }),
    ],
    managers: { mcp: { label: 'MCP servers', manageArgv: ['mcp'], remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add'], shape: 'named-flags', transportPrefix: ['--transport'], localTransport: 'stdio', urlPrefix: ['--url'], commandPrefix: ['--command'], argsPrefix: ['--arg'], argsStyle: 'repeat-equals', remoteExtraArgv: ['--no-login'] } } },
  },
  // `openclaw agent` (2026.9.6). --agent, --session-id/--session-key,
  // --model, --thinking and --message are the turn itself; delivery flags
  // (--channel, --deliver, --reply-*) send the reply to a chat app, which is
  // not a coding turn.
  openclaw: {
    options: [
      value('timeout', 'Turn timeout (seconds)', 'Override the agent command timeout', 'safety', ['--timeout'], 'number'),
      value('verbose', 'Verbose', 'Persist the agent verbose level for the session', 'output', ['--verbose'], 'enum', { values: ['on', 'off'] }),
    ],
    managers: {
      mcp: {
        label: 'MCP servers',
        listArgv: ['mcp', 'list'],
        manageArgv: ['mcp'],
        remove: { argv: ['mcp', 'unset'] },
        add: {
          argv: ['mcp', 'add', '--no-probe'],
          shape: 'named-flags',
          commandPrefix: ['--command'],
          argsPrefix: ['--arg'],
          argsStyle: 'repeat-equals',
          urlPrefix: ['--url'],
        },
      },
      plugins: { label: 'Plugins', manageArgv: ['plugins'] },
      skills: { label: 'Skills', manageArgv: ['skills'] },
      hooks: { label: 'Hooks', manageArgv: ['hooks'] },
    },
    features: ['plugins', 'skills', 'hooks', 'memory', 'chat channels', 'model fallbacks'],
  },
  hermes: {
    options: [
      value('toolsets', 'Toolsets', 'Toolsets enabled for the turn, from hermes tools list', 'tools', ['--toolsets'], 'string-list', { argvStyle: 'csv' }),
      value('skills', 'Preloaded skills', 'Skills loaded for this session', 'tools', ['--skills'], 'string-list', { argvStyle: 'csv' }),
      value('max-turns', 'Maximum turns', 'Maximum tool-calling iterations in one turn', 'safety', ['--max-turns'], 'number'),
      value('run-budget', 'Run budget (seconds)', 'Wall-clock budget for one run', 'safety', ['--run-budget'], 'number'),
      flag('worktree', 'Isolated worktree', 'Run in an isolated Git worktree', 'session', ['--worktree'], { requiresNewSession: true }),
      flag('checkpoints', 'Checkpoints', 'Snapshot files before destructive edits', 'safety', ['--checkpoints']),
      flag('accept-hooks', 'Accept hooks', 'Auto-approve unseen shell hooks', 'safety', ['--accept-hooks']),
      flag('pass-session-id', 'Pass session id', 'Include the session id in the system prompt', 'session', ['--pass-session-id']),
      flag('verbose', 'Verbose', 'Verbose output', 'output', ['--verbose']),
      flag('safe-mode', 'Safe mode', 'Disable user config, rules, plugins, and MCP', 'safety', ['--safe-mode']),
      flag('ignore-user-config', 'Ignore user config', 'Use built-in defaults while retaining credentials', 'safety', ['--ignore-user-config']),
      flag('ignore-rules', 'Ignore rules', 'Skip AGENTS.md, memory, and preloaded skills', 'safety', ['--ignore-rules']),
      flag('yolo', 'Bypass approvals', 'Bypass dangerous-command approvals', 'permissions', ['--yolo'], { dangerous: true }),
    ],
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.hermes', 'config.yaml'], format: 'yaml', key: ['mcp_servers'], dialect: 'mcp-servers' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'], remove: { argv: ['mcp', 'remove'] }, add: { argv: ['mcp', 'add'], shape: 'named-flags', urlPrefix: ['--url'], commandPrefix: ['--command'], argsPrefix: ['--args'], argsStyle: 'list', confirmStdin: 'y\n' } }, skills: { label: 'Skills', manageArgv: ['skills'] }, plugins: { label: 'Plugins', manageArgv: ['plugins'] }, tools: { label: 'Tools', manageArgv: ['tools'] }, hooks: { label: 'Hooks', manageArgv: ['hooks'] } },
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
    managers: { mcp: { label: 'MCP servers', serverFiles: [{ homeRelative: ['.commandcode', 'mcp.json'], format: 'json', key: ['mcpServers'], dialect: 'mcp-servers' }], listArgv: ['mcp', 'list'], manageArgv: ['mcp'], remove: { argv: ['mcp', 'remove', '--scope', 'user'] }, add: { argv: ['mcp', 'add', '-s', 'user'], shape: 'positional', transportPrefix: ['-t'] } }, skills: { label: 'Skills', manageArgv: ['skills'] }, plugins: { label: 'Mods', manageArgv: ['mods'] } },
    features: ['skills', 'mods', 'taste learning', 'MCP', 'managed worktrees', 'plan mode'],
  },
  // Continue: these are the raw vendor rows for the flags `cn --help` really
  // lists. --model stays the model selector's own flag (the help's --model
  // hub-slug spelling is the same flag name) and --prompt is the turn's own
  // prompt, so neither becomes a row beside its owner. The permission surface
  // (--readonly / --auto / --allow / --ask / --exclude) overlaps the selector:
  // only the two tool-list spellings --allow and --ask sit here as rows, and
  // they are the pieces of that surface the selector does not drive.
  cn: {
    options: [
      value('agent', 'Agent', 'Agent file loaded from the hub', 'mode', ['--agent']),
      value('config', 'Config', 'Configuration file path or hub slug', 'advanced', ['--config']),
      value('org', 'Organization', 'Organization slug used in headless mode', 'advanced', ['--org']),
      flag('verbose', 'Verbose', 'Verbose logging', 'output', ['--verbose']),
      flag('beta-status-tool', 'Beta status tool', 'Enable the beta status tool', 'tools', ['--beta-status-tool']),
      flag('beta-subagent-tool', 'Beta subagent tool', 'Enable the beta subagent tool', 'tools', ['--beta-subagent-tool']),
      value('rules', 'Rules', 'Rules added for the session', 'context', ['--rule'], 'string-list', { argvStyle: 'repeat' }),
      value('mcp', 'MCP servers', 'MCP servers loaded from the hub as owner/package slugs', 'tools', ['--mcp'], 'string-list', { argvStyle: 'repeat' }),
      value('allow', 'Allowed tools', 'Tools allowed, overriding default policies', 'permissions', ['--allow'], 'string-list', { argvStyle: 'repeat' }),
      value('ask', 'Ask about tools', 'Tools that ask for permission before use', 'permissions', ['--ask'], 'string-list', { argvStyle: 'repeat' }),
      value('exclude', 'Excluded tools', 'Tools excluded from use', 'tools', ['--exclude'], 'string-list', { argvStyle: 'repeat' }),
    ],
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
  if (harnessSupportsEffort(harness)) {
    const effortArgv = harness.effortArgvPrefix ?? harness.acp?.effortArgvPrefix;
    const values = harness.effortValues ?? [];
    normalized.push(effortArgv
      ? value('effort', 'Reasoning effort', 'Provider-native reasoning level', 'reasoning', effortArgv, 'enum', { values })
      : { id: 'effort', label: 'Reasoning effort', description: 'Provider-native reasoning level', category: 'reasoning', kind: 'enum', values });
  }
  if (harness.permissionModes?.length) normalized.push({ id: 'permissions', label: 'Permissions', description: 'Normalized ClikCode approval behavior', category: 'permissions', kind: 'enum', values: harness.permissionModes });
  return { ...declared, options: [...normalized, ...declared.options.filter((option) => !normalizedPermissionIds.has(option.id))] };
}

/** A session key (`agent:main:main`) is not a session id. Only a harness that
 * declares both prefixes gets the key form, and only when the stored value
 * contains a colon — OpenClaw's ids do not. */
function sessionSelector(
  id: string, idPrefix?: readonly string[], keyPrefix?: readonly string[],
): readonly string[] | undefined {
  if (keyPrefix && id.includes(':')) return keyPrefix;
  return idPrefix;
}

/** `provider:model` split the way Hermes splits it: a `custom:<name>`
 * provider keeps its own colon, and a left side with `/` or `.` is part of a
 * model name (`anthropic/claude-3.5-sonnet:beta`), not a provider. */
export function splitProviderModel(model: string): { provider: string; model: string } | undefined {
  const match = /^(custom:[^:/]+|[a-z][a-z0-9_-]*):(.+)$/i.exec(model.trim());
  return match ? { provider: match[1]!, model: match[2]! } : undefined;
}

/** A model id split at the harness's own separator: `provider:model`
 * (Hermes) or, for a harness that writes `provider/model` (Goose), at the
 * first slash, so `openrouter/anthropic/claude` keeps its model whole. */
export function splitHarnessModel(harness: AiLocalHarnessDefinition, model: string): { provider: string; model: string } | undefined {
  if (harness.modelProviderSeparator === '/') {
    const slash = model.indexOf('/');
    return slash > 0 && slash < model.length - 1 ? { provider: model.slice(0, slash), model: model.slice(slash + 1) } : undefined;
  }
  return splitProviderModel(model);
}

/** Whether a harness's model ids name the provider they run on: the
 * harnesses that drive other providers (Hermes, OpenClaw, Goose, OpenCode,
 * Kilo, Pi). */
export function harnessCarriesProvider(harness: AiLocalHarnessDefinition): boolean {
  return Boolean(harness.modelProviderSeparator || harness.modelProviderArgvPrefix);
}

/** One way to show a multi-provider model: `provider:model`. Hermes writes
 * that already; the rest write `provider/model`, which put
 * `openrouter/anthropic/claude` beside `nous:z-ai/glm-5.2` in the same kind
 * of list. Display only -- the vendor still gets its own id. */
export function modelDisplayId(harness: AiLocalHarnessDefinition, model: string): string {
  if (!harnessCarriesProvider(harness)) return model;
  const split = splitHarnessModel(harness, model);
  return split ? `${split.provider}:${split.model}` : model;
}

/** The harness's own id for one typed as it is shown (`claude-code:sonnet`
 * for Goose's `claude-code/sonnet`). An id already in the harness's form
 * (a `/` before any `:`) is kept, so `ollama/qwen3:8b` stays itself. */
export function modelIdFromDisplay(harness: AiLocalHarnessDefinition, typed: string): string {
  const model = typed.trim();
  if (harness.modelProviderSeparator !== '/') return model;
  const colon = model.indexOf(':');
  const slash = model.indexOf('/');
  return colon > 0 && (slash < 0 || colon < slash) ? `${model.slice(0, colon)}/${model.slice(colon + 1)}` : model;
}

/** The provider half of a model id, in the harness's own spelling. */
export function modelProvider(harness: AiLocalHarnessDefinition, model: string): string | undefined {
  if (harness.modelProviderSeparator === '/') {
    const slash = model.indexOf('/');
    return slash > 0 ? model.slice(0, slash) : undefined;
  }
  return splitProviderModel(model)?.provider;
}

/** The model flag, plus the provider flag when the harness takes the provider
 * separately and the id names one. */
export function modelSelectorArgv(harness: AiLocalHarnessDefinition, model: string): string[] {
  if (!harness.modelArgvPrefix?.length) return [];
  const split = harness.modelProviderArgvPrefix ? splitHarnessModel(harness, model) : undefined;
  return split
    ? [...harness.modelProviderArgvPrefix!, split.provider, ...harness.modelArgvPrefix, split.model]
    : [...harness.modelArgvPrefix, model];
}

/** One place a vendor stores its sign-in. `path` expands `~` to the home
 * directory and `${VAR:-default}` to the profile's environment, so an isolated
 * account (GEMINI_CLI_HOME) is checked in its own directory. A path ending in
 * `/` is a directory that counts when it holds any file. `contains` requires
 * the text in the file, for a credential kept inside a shared config
 * (Continue's config.yaml, Vibe's .env); `removeLine` lets logout delete just
 * the lines holding it, for a one-key-per-line file like `.env`. */
export interface AiHarnessAuthFile { path: string; contains?: string; removeLine?: boolean }

/** A reply that is a failed call. `pattern` is matched against the whole
 * trimmed reply; the status is the first capture group, else `status`. */
export interface AiHarnessReplyErrorPattern { pattern: string; status?: number }

export function harnessReplyError(harness: AiLocalHarnessDefinition, text: string): { notice: string; statusCode?: number; withoutNotice?: string } | undefined {
  const reply = text.trim();
  for (const entry of harness.replyErrorPatterns ?? []) {
    const match = new RegExp(entry.pattern).exec(reply);
    if (!match) continue;
    const captured = match[1] ? Number(match[1]) : undefined;
    const statusCode = captured !== undefined && Number.isFinite(captured) ? captured : entry.status;
    // Everything before the matched notice is real progress. Cursor appends
    // its upgrade banner after the answer; keeping that banner in the
    // checkpoint made failover look like the model had only written the
    // refusal. Only set when there is something to keep.
    const withoutNotice = match.index > 0 ? reply.slice(0, match.index).trimEnd() : undefined;
    // The notice alone is the vendor's error; the progress before it is the
    // model's, and is never read as a failure reason.
    return {
      notice: reply.slice(match.index).trim(),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(withoutNotice !== undefined ? { withoutNotice } : {}),
    };
  }
  return undefined;
}

/** The sign-in to run for a model: its own provider's when the harness has
 * one and the id names a provider, else the harness's whole sign-in. */
export function harnessLoginArgvForModel(harness: AiLocalHarnessDefinition, model: string | null | undefined): readonly string[] | undefined {
  const provider = model && harness.providerLoginArgv ? modelProvider(harness, model) : undefined;
  return provider ? harness.providerLoginArgv!.map((part) => part === '{provider}' ? provider : part) : harness.loginArgv;
}

export interface AiNativeHarnessTurnInput {
  nativeSessionId?: string;
  createdHere?: boolean;
  model?: string | null;
  workspace?: string | null;
  effort?: string | null;
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
    for (const rendered of renderedItems) append(...option.argv, rendered);
  }
}

/** Build a single non-interactive turn while keeping terminal ownership in ClikCode. */
export function nativeHarnessTurnArgv(harness: AiLocalHarnessDefinition, input: AiNativeHarnessTurnInput): string[] {
  if (!harness.turn) throw new Error(`${harness.displayName} has no centralized turn adapter`);
  const resumed = Boolean(input.nativeSessionId && !input.createdHere);
  let argv = [...(resumed && harness.turn.resumeArgv ? harness.turn.resumeArgv : harness.turn.startArgv)];
  if (input.nativeSessionId) {
    const prefix = input.createdHere
      ? harness.turn.createIdPrefix
      : sessionSelector(input.nativeSessionId, harness.turn.resumeIdPrefix, harness.turn.resumeKeyPrefix);
    if (prefix) argv.push(...prefix, input.nativeSessionId, ...(input.createdHere ? [] : harness.turn.resumeIdSuffix ?? []));
    else if (resumed && harness.turn.resumeArgv) argv.push(input.nativeSessionId, ...(harness.turn.resumeIdSuffix ?? []));
  }
  if (input.model) argv.push(...modelSelectorArgv(harness, input.model));
  if (input.workspace && harness.workspaceArgvPrefix && (!resumed || harness.turn.resumeSupportsWorkspaceSelector !== false)) argv.push(...harness.workspaceArgvPrefix, input.workspace);
  if (input.effort && harness.effortArgvPrefix) argv.push(...harness.effortArgvPrefix, harness.effortConfigKey ? `${harness.effortConfigKey}="${input.effort}"` : input.effort);
  if (input.permissionMode && harness.permissionModes?.includes(input.permissionMode)) {
    const mapping = harness.permissionArgv?.[input.permissionMode];
    // Goose carries its mode in GOOSE_MODE (turnEnvironment), not in argv.
    if (!mapping && !harness.permissionEnv?.[input.permissionMode]) throw new Error(`${harness.displayName} has no argv mapping for ${input.permissionMode} permissions`);
    if (mapping?.placement === 'root') argv.unshift(...mapping.argv);
    else if (mapping) argv.push(...mapping.argv);
  }
  // A model that names its provider already chose it; a separately stored
  // provider option would come later on the line and win.
  const carriesProvider = Boolean(input.model && harness.modelProviderArgvPrefix && splitHarnessModel(harness, input.model));
  const { provider: _provider, ...withoutProvider } = input.options ?? {};
  appendDeclaredHarnessOptions(argv, harness, carriesProvider ? withoutProvider : input.options, resumed);
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
}

export function harnessAcpLaunch(harness: AiLocalHarnessDefinition, input: AiHarnessAcpLaunchInput = {}): AiHarnessAcpLaunch | undefined {
  const acp = harness.acp;
  if (!acp) return undefined;
  const options: string[] = [];
  // The CLI's own flags describe the CLI. A separate ACP program (Vibe's
  // `vibe-acp`) takes only what `acp` declares for it: handed `--auto-approve`
  // it refused to start, and every Vibe turn fell back to the CLI. It needs no
  // more -- the model is chosen over the protocol, and approvals are answered
  // by ClikCode on the permission requests the agent sends.
  const sameProgram = (!acp.binary || acp.binary === harness.binary) && acp.inheritCliOptions !== false;
  if (input.model && sameProgram) options.push(...modelSelectorArgv(harness, input.model));
  const effortPrefix = acp.effortArgvPrefix ?? (sameProgram ? harness.effortArgvPrefix : undefined);
  if (input.effort && effortPrefix) options.push(...effortPrefix, harness.effortConfigKey && !acp.effortArgvPrefix ? `${harness.effortConfigKey}="${input.effort}"` : input.effort);
  if (input.permissionMode === 'bypass' || input.permissionMode === 'auto') {
    options.push(...(acp.permissionArgv?.[input.permissionMode]
      ?? (sameProgram && harness.permissionModes?.includes(input.permissionMode) ? harness.permissionArgv?.[input.permissionMode]?.argv : undefined) ?? []));
  }
  const optionPlacement = acp.optionPlacement ?? 'before';
  return {
    binary: acp.binary ?? harness.binary,
    argv: optionPlacement === 'after' ? [...acp.argv, ...options] : [...options, ...acp.argv],
    modeArgv: [...acp.argv], optionArgv: options, optionPlacement,
  };
}

/** The transport to use for this turn. An ACP declaration is primary. */
export function harnessTurnTransport(harness: AiLocalHarnessDefinition): AiHarnessTransport {
  if (harness.transport === 'codex-app-server') return 'codex-app-server';
  const cli: AiHarnessTransport = harness.turn?.output === 'text' ? 'text-cli' : 'structured-cli';
  if (!harness.acp) return harness.turn ? cli : harness.transport;
  return 'acp';
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
  // An ACP agent may carry effort only over ACP: a flag its ACP mode alone
  // accepts (Copilot `--effort`) or a session config option (Goose
  // `thinking_effort`). Either is as real a control as a one-shot flag.
  return Boolean(harness.effortArgvPrefix || harness.acp?.effortArgvPrefix || harness.acp?.effortConfigId);
}

/** Whether a model can be chosen for this harness: a model flag, or an ACP
 * agent whose session lists its models. `acp.listsModels` unset counts as
 * listing, exactly as model discovery reads it (OpenHands, MiniMax Code);
 * only an explicit `false` says the session must not be asked. */
export function harnessSupportsModelSelection(harness: AiLocalHarnessDefinition): boolean {
  return harness.modelArgvPrefix !== undefined || Boolean(harness.acp && harness.acp.listsModels !== false);
}

export function harnessSupportsPermissionMode(harness: AiLocalHarnessDefinition, mode: AiHarnessPermissionMode): boolean {
  if (!harness.permissionModes?.includes(mode)) return false;
  // Declaring the mode is not enough: something has to actually carry it to
  // the vendor, or selecting it would silently do nothing -- which is the one
  // outcome a permission control must never have.
  return Boolean(harness.permissionArgv?.[mode] ?? harness.permissionEnv?.[mode]);
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
