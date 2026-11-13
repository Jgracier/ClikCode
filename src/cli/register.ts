/**
 * The public ClikCode command surface.
 *
 * The `gateway` group is the only part that talks to a remote platform.
 */
import { serveThenExit, untilStopped } from './stop-signal.js';
import { registerOperatorCommands } from './register-ops.js';
import { Option, type Command } from 'commander';
import type Conf from 'conf';

/** A command's handler, loaded when the command runs: `clikcode --version`
 * and every other command load only the code they use. */
function later<M, K extends keyof M>(load: () => Promise<M>, name: K): M[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never {
  return ((...args: unknown[]) => load().then((module) => (module[name] as (...a: unknown[]) => unknown)(...args))) as never;
}
const acpCommands = () => import('../commands/acp.js');
const mcpCommands = () => import('../commands/mcp.js');
const accountCommands = () => import('../commands/account.js');
const sessionCommands = () => import('../commands/ai/sessions.js');
const statusCommands = () => import('../commands/ai/status.js');
const interactiveCommands = () => import('../commands/ai/interactive.js');

/** `name=value` pairs from a repeatable flag. */
function pairs(list: string[] | undefined, flag: string): Record<string, string> {
  return Object.fromEntries((list ?? []).map(pair => { const at = pair.indexOf('='); if (at < 1) throw new Error(`${flag} is name=value`); return [pair.slice(0, at), pair.slice(at + 1)]; }));
}

export function registerClikCodeCommands(program: Command, config: Conf): void {
  // Not a user command: the entry point client.ts's spawnSessionWorker spawns
  // as a fresh, detached process (see worker/client.ts). Hidden rather than
  // undocumented-but-listed, since running it by hand does something real
  // (binds a socket, writes a runtime record) that only makes sense as a
  // spawn target.
  program.command('session-worker <id>', { hidden: true }).option('--warm').action((id: string, options: { warm?: boolean }) => later(() => import('../worker/session-worker.js'), 'runSessionWorker')(id, { warm: Boolean(options.warm) }));
  // ClikCode's computer tools over MCP (stdio), started for every harness session: a spawn target, not a command to type.
  program.command('mcp-serve', { hidden: true })
    .action(async () => { const { mcpServe } = await import('../commands/mcp-serve.js'); await serveThenExit(mcpServe); });
  program.command('computer-host <stateDir>', { hidden: true }).action(async (stateDir: string) => (await import('../agent/computer/browser-host.js')).runComputerHost(stateDir));
  // An editor extension's client (ide/bridge.ts), over an IPC channel the
  // extension opens; and the terminal it runs a vendor sign-in in. Hidden for
  // the same reason as session-worker: neither is anything to type.
  // `--stdio`: the same bridge over stdin/stdout, for ClikCode Remote's SSH
  // connection from another machine (ide/bridge-stdio.ts).
  program.command('ide-bridge', { hidden: true }).option('--stdio', 'speak JSON lines on stdin/stdout instead of an IPC channel')
    .action(async (options: { stdio?: boolean }) => (options.stdio
      ? (await import('../ide/bridge-stdio.js')).runStdioBridge()
      : (await import('../ide/bridge.js')).runIdeBridge(config)));
  // What ClikCode Remote reads of an installation it made: version, commit, installation id.
  program.command('remote-info', { hidden: true }).action(async () => (await import('../remote/info.js')).printRemoteInfo());
  // /update from a shell: this machine's ClikCode, the way it was installed.
  // `--entry`: read the install from that entry instead of this one (an
  // editor updating the ClikCode it runs; tests).
  program.command('update [commit]').description('Update this machine\'s ClikCode the way it was installed (a commit: ClikCode Remote installs only)')
    .addOption(new Option('--entry <path>').hideHelp())
    .action(async (commit: string | undefined, options: { entry?: string }) => {
      const { parseCommitArgument, updateThisMachine } = await import('../remote/self-update.js');
      const target = parseCommitArgument(commit ?? '');
      const result = await updateThisMachine({ ...(target ? { commit: target } : {}), ...(options.entry ? { entry: options.entry } : {}), line: (text) => process.stdout.write(`${text}\n`) });
      process.stdout.write(`${result.text}\n`);
    });
  program.command('ide-terminal <spec>', { hidden: true }).action(async (spec: string) => (await import('../ide/terminal.js')).runIdeTerminal(spec));
  // The search /search runs, from a shell: the same engine and ranking.
  program.command('search <words...>').description('Find the conversations that mention something, any provider, most mentions first (--json: each hit and its first mention)')
    .action(async (words: string[]) => {
      const [{ searchConversations }, { searchResultsPayload }, { emitHarnessOutput }] = await Promise.all([
        import('../search/engine.js'), import('../search/navigate.js'), import('../harness/output.js'),
      ]);
      const result = await searchConversations(words.join(' '));
      if (!result) throw new Error('usage: clikcode search <words>');
      emitHarnessOutput(searchResultsPayload(result));
    });
  const doctor = program.command('doctor').description('Inspect installed harness versions and centralized capabilities').action(later(accountCommands, 'aiDoctor'));
  doctor.command('scopes').description('List every ClikCode cgroup (session, memory, tasks, cpu, age, owner), flagging commands past their 2 h lifetime and scopes whose worker ended')
    .option('--reap', 'end only the flagged cgroups, after printing them')
    .action(async (options: { reap?: boolean }) => (await import('../commands/doctor-scopes.js')).aiDoctorScopes(options));
  const computer = program.command('computer').description('Control the local browser and request a private login in any ClikCode chat');
  computer.command('status').description('Show whether computer use is on').action(async () => (await import('../commands/computer.js')).computerStatus());
  computer.command('on').description('Make computer use available for new turns').action(async () => (await import('../commands/computer.js')).computerSetEnabled(true));
  computer.command('off').description('Stop offering computer tools in new turns').action(async () => (await import('../commands/computer.js')).computerSetEnabled(false));
  computer.command('headless [setting]').description('on or off: run the browser with no window (a Linux computer with no display does this by itself; CLIKCODE_BROWSER_HEADLESS=1 forces it)').action(async (setting?: string) => (await import('../commands/computer.js')).computerHeadless(setting));
  computer.command('desk').description('The one address for browser steps that wait on you (a CAPTCHA, a code, a sign-in), and what is waiting there now').action(async () => (await import('../commands/computer.js')).computerDesk());
  computer.command('browser-use [setting]').description('auto: local browser first, a tab moves to Browser Use Cloud when a page blocks it; on: every tab in the cloud; off: local only (default) and stop the cloud session; view: its live-control link, in your own terminal').action(async (setting?: string) => (await import('../commands/computer.js')).computerBrowserUse(setting));
  computer.command('passwords [setting]').description('on or off: let the browser tool make up and keep a strong password for signup forms (default off)').action(async (setting?: string) => (await import('../commands/computer.js')).computerGeneratedPasswords(setting));
  const driver = computer.command('driver').description('Install, update and inspect cua-driver, which computer_use needs to control the desktop');
  driver.command('status').description('Show the installed cua-driver, its releases on disk and the newest release').option('--offline', 'Do not look up the newest release').action(async (options: { offline?: boolean }) => (await import('../commands/computer-driver.js')).computerDriverStatus(options));
  driver.command('install').description('Install cua-driver for this computer from the release downloads (checksum verified; no GitHub API)').option('--version <x.y.z>', 'Install this release instead of the newest').option('--force', 'Reinstall even when it is already installed').action(async (options: { version?: string; force?: boolean }) => (await import('../commands/computer-driver.js')).computerDriverInstall(options));
  driver.command('update').description('Update cua-driver to the newest release, keeping the previous one for rollback').option('--force', 'Reinstall even when it is current').action(async (options: { force?: boolean }) => (await import('../commands/computer-driver.js')).computerDriverInstall(options, 'updated'));
  driver.command('rollback').description('Go back to the release that was active before the last install or update').action(async () => (await import('../commands/computer-driver.js')).computerDriverRollback());
  driver.command('wayland-helper').description('Install Cua\'s optional GNOME Shell helper (GNOME 45-49 only; needs one log-out). Never runs by itself').option('--yes', 'Run the helper installer instead of only explaining it').action(async (options: { yes?: boolean }) => (await import('../commands/computer-driver.js')).computerDriverWaylandHelper(options));
  const email = computer.command('email').description('Connect a mailbox so sign-ups that want an emailed code or link need nobody');
  email.command('connect').description('Open Google consent in the ClikCode browser and add the mailbox (--address: another Google account; it must be signed in there); no further steps').option('--address <email>', 'the Google account to connect (default: the profile email)').action(async (opts: { address?: string }) => (await import('../commands/computer.js')).computerEmail('connect', opts));
  email.command('status').description('Show which mailboxes are connected').action(async () => (await import('../commands/computer.js')).computerEmail('status'));
  email.command('disconnect').description('Forget a connected mailbox (--address when several are connected)').option('--address <email>', 'the mailbox to forget').action(async (opts: { address?: string }) => (await import('../commands/computer.js')).computerEmail('disconnect', opts));
  computer.command('inspect').description('Show visible login field names without their values').action(async () => (await import('../commands/computer.js')).computerInspect());
  computer.command('login [url]').description('Open a login URL if given, then ask privately in the current chat')
    .option('--chat <chat>', 'Chat id, prefix or name when run outside a chat')
    .option('--new', 'Sign in with a different account instead of the saved one')
    .action(async (url: string | undefined, options: { chat?: string; new?: boolean }) => (await import('../commands/computer.js')).computerLogin(options.chat, { ...(url ? { url } : {}), ...(options.new ? { newAccount: true } : {}) }));
  computer.command('tool <name>').description('Run a computer tool (browser_use, account_use, computer_use) in the current chat; prints its scrubbed result')
    .option('--args-json <json>', 'The tool arguments as one JSON object', '{}')
    .option('--chat <chat>', 'Chat to use when run from outside a ClikCode chat')
    .action(async (name: string, options: { argsJson: string; chat?: string }) => {
      let args: unknown;
      try { args = JSON.parse(options.argsJson); } catch { throw new Error('--args-json must be a JSON object'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('--args-json must be a JSON object');
      await (await import('../commands/computer.js')).computerTool(name, args as Record<string, unknown>, options.chat);
    });
  computer.command('capture <secret-name>').description('Get an API key from the open page into Secrets Manager without showing it (name the Create button with --click, as a [ref=…] from the page view or its text)')
    .option('--click <target>', 'The button that makes the site show the key')
    .option('--to <destination>', 'Also send it on, for example clikdeploy-secret')
    .option('--with <slot=value...>', 'A value for a slot of the destination, repeatable', (value: string, all: string[] = []) => [...all, value])
    .option('--value <name=value...>', 'A plain connection value for a clikdeploy-connection destination (name=value or name=secret:<saved name>), repeatable', (value: string, all: string[] = []) => [...all, value])
    .option('--chat <chat>', 'Chat to use when run from outside a ClikCode chat')
    .action(async (secret: string, options: { click?: string; to?: string; with?: string[]; value?: string[]; chat?: string }) => {
      const values = pairs(options.value, '--value');
      const params = Object.fromEntries((options.with ?? []).map(pair => { const at = pair.indexOf('='); if (at < 1) throw new Error('--with is slot=value'); return [pair.slice(0, at), pair.slice(at + 1)]; }));
      await (await import('../commands/computer.js')).computerTool('account_use', { action: 'capture_secret', secret_name: secret,
        ...(options.click ? { target: options.click } : {}), ...(options.to ? { send_to: { to: options.to, ...(Object.keys(params).length ? { with: params } : {}), ...(Object.keys(values).length ? { values } : {}) } } : {}) }, options.chat);
    });
  computer.command('store <secret-name>').description('Send a saved secret on to a destination, for example --to clikdeploy-secret --with key=SALAD_API_KEY')
    .requiredOption('--to <destination>', 'A destination name (see `computer destination list`)')
    .option('--with <slot=value...>', 'A value for a slot of the destination, repeatable', (value: string, all: string[] = []) => [...all, value])
    .option('--value <name=value...>', 'A plain connection value for a clikdeploy-connection destination (name=value or name=secret:<saved name>), repeatable', (value: string, all: string[] = []) => [...all, value])
    .option('--chat <chat>', 'Chat to use when run from outside a ClikCode chat')
    .action(async (secret: string, options: { to: string; with?: string[]; value?: string[]; chat?: string }) => {
      const values = pairs(options.value, '--value');
      const params = Object.fromEntries((options.with ?? []).map(pair => { const at = pair.indexOf('='); if (at < 1) throw new Error('--with is slot=value'); return [pair.slice(0, at), pair.slice(at + 1)]; }));
      await (await import('../commands/computer.js')).computerTool('account_use', { action: 'send_secret', secret, send_to: [{ to: options.to, ...(Object.keys(params).length ? { with: params } : {}), ...(Object.keys(values).length ? { values } : {}) }] }, options.chat);
    });
  computer.command('profile').description('Autofill profiles an agent fills forms from (name, email, phone, address, and custom details): list, --set key=value, --custom key=value, --delete')
    .option('--create', 'Ask for the details and save them as a profile').option('--label <name>', 'Which profile (default Personal)').option('--set <pair...>', 'key=value, for example phone=719-555-0123').option('--custom <pair...>', 'key=value of a detail beyond the standard ones, for example app_name="My App" (details only, never a key)').option('--secret <name>', 'Keep a secret with the profile, typed hidden (password = the password used for sign-ups); never shown to an agent').option('--delete <label>', 'Remove a profile')
    .action(async (options: { label?: string; set?: string[]; custom?: string[]; delete?: string; create?: boolean; secret?: string }) => (await import('../commands/computer.js')).computerProfile(options));
  computer.command('secrets').description('List the names of saved secrets, or delete one (values are never shown)')
    .option('--delete <name>', 'Delete this secret').option('--backfill', 'Record a vendor (and --owner) on secrets saved before records existed').option('--owner <email>', 'With --backfill: the account these belong to')
    .option('--export <file>', 'Write an encrypted backup of every login, secret and profile (passphrase typed hidden)').option('--import <file>', 'Restore a backup written by --export (passphrase typed hidden)').option('--overwrite', 'With --import: replace items that are already here')
    .option('--url <name=https://site>', 'Record the site a saved key is for').option('--audit', 'Show what is untidy: twin names, odd names, keys with no site or owner, incomplete or rejected logins').option('--sync <user@host>', 'Make this computer\'s vault and another one\'s the same, over Tailscale (the newer secret wins, nothing is deleted)').option('--exchange', 'The other end of --sync (reads a vault on standard input)')
    .action(async (options: { delete?: string; backfill?: boolean; owner?: string; export?: string; import?: string; overwrite?: boolean; audit?: boolean; sync?: string; exchange?: boolean; url?: string }) => {
      const computer = await import('../commands/computer.js');
      if (options.exchange) return computer.computerVaultExchange();
      if (options.sync) return computer.computerVaultSync(options.sync);
      if (options.url) return computer.computerSecretUrl(options.url);
      if (options.audit) return computer.computerVaultAudit();
      return computer.computerSecrets(options.delete, options.backfill ? { ...(options.owner ? { owner: options.owner } : {}) } : undefined,
        options.export || options.import ? { ...(options.export ? { export: options.export } : {}), ...(options.import ? { import: options.import } : {}), ...(options.overwrite ? { overwrite: true } : {}) } : undefined);
    });
  const destination = computer.command('destination').description('Where captured keys can be sent: named commands with a {{secret}} slot');
  destination.command('list').description('Show every destination and the values the agent fills in')
    .action(async () => (await import('../commands/computer.js')).computerDestinations());
  destination.command('add <name> [command...]').description('Add one: the command to run, with {{secret}} where the key goes and {{slot}} for anything the agent fills in. Example: add my-vault --stdin "{{secret}}" -- vault kv put secret/{{key}} value=-')
    .option('--stdin <text>', 'Send this on standard input instead of in the command line, e.g. "{{secret}}"')
    .option('--about <text>', 'A short description shown in the list')
    .allowUnknownOption()
    .action(async (name: string, command: string[], options: { stdin?: string; about?: string }) => (await import('../commands/computer.js')).computerDestinationAdd(name, command, options));
  destination.command('remove <name>').description('Remove one you added')
    .action(async (name: string) => (await import('../commands/computer.js')).computerDestinationRemove(name));
  computer.command('logins').description('Review and remove saved logins in the current chat (shown only to you)')
    .option('--chat <chat>', 'Chat id, prefix or name when run outside a chat')
    .option('--remove <site>', 'Remove the saved logins for a site (a host such as wordnik.com) without a prompt; prints only a count')
    .option('--account <label>', 'With --remove: only the login with this username or email')
    .action(async (options: { chat?: string; remove?: string; account?: string }) => options.remove
      ? (await import('../commands/computer.js')).computerLoginsRemove(options.remove, options.account)
      : (await import('../commands/computer.js')).computerLogin(options.chat, { manage: true }));
  registerOperatorCommands(program, computer);
  program.command('logs').description('What every ClikCode window, worker and editor bridge did, in order (the lifecycle log)')
    .option('--session <id>', 'Only this conversation (an id or the start of one)')
    .option('--role <role>', 'Only window, worker, bridge or command')
    .option('--since <age>', 'Only the last 30s, 10m, 2h, 1d')
    .option('-n, --lines <count>', 'How many lines (default 100)')
    .option('-f, --follow', 'Keep printing as it is written')
    .option('--latency', 'Where each turn\'s time went (marks per turn, median per harness) instead of the log lines')
    .option('--check', 'Read the log for what is wrong -- failing commands, failed tools, swallowed errors, slow writes -- over the last day')
    .option('--last <count>', 'With --latency: how many turns (default 20)')
    .action(async (options) => (await import('../commands/logs.js')).showLogs(options));
  program.command('permissions [mode]').description('Choose Ask, Bypass, or Auto approval: the default for new chats, or one chat\'s with --chat')
    .option('--chat <chat>', 'The chat to change: its id or the start of it, its name, or last')
    .action((mode: string | undefined, options: { chat?: string }) => later(() => import('../tui/pickers/permissions.js'), 'aiPermissions')(mode, options));
  const accounts = program.command('accounts').alias('account').description('Manage local provider accounts');
  accounts.command('list').alias('ls').description('List local accounts and the usage left on each')
    .option('--models', 'Include each account\'s model list').action(async (options: { models?: boolean }) => {
      await later(accountCommands, 'aiAccountsList')(options);
      // A vendor probe that never answers is a child process that would hold
      // this one open for as long as it hangs; the account is asked again
      // once its reading is older than the recheck window.
      await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
      process.exit(process.exitCode ?? 0);
    });
  accounts.command('providers').description('List supported local harnesses and login kinds').action(later(accountCommands, 'aiAccountProviders'));
  accounts.command('login <harness>').description('Install if necessary, then run the harness’s official local login flow')
    .option('--label <label>', 'Local account label')
    .action(async (harness, options) => {
      await later(accountCommands, 'aiAccountLogin')(harness, options.label);
    });
  accounts.command('status <labelOrId>').description('Run the vendor’s declared account-status check').action(later(accountCommands, 'aiAccountStatus'));
  accounts.command('logout <labelOrId>').description('Run vendor logout and retain the local alias as needs-login').action(later(accountCommands, 'aiAccountLogout'));
  accounts.command('add').description('Register a local provider login reference; credentials remain on this device')
    .requiredOption('--provider <provider>', 'Harness (claude, codex) or provider id (anthropic, openai)')
    .option('--label <label>', 'Local account alias (api-key: defaults to the email behind the key, where its vendor tells)')
    .requiredOption('--auth <kind>', 'api-key or vendor-cli; use the vendor login flow for OAuth')
    .option('--credential-ref <ref>', 'OS-keychain or vendor-CLI profile reference; never a token (vendor-cli: defaults to the CLI\'s own sign-in)')
    .option('--model <model...>', 'Model ids available through this account')
    .action(async (options) => {
      const { localHarnessForCommand, localHarnessForProvider } = await import('../runtime/lazy-bridge.js');
      const harness = localHarnessForCommand(options.provider);
      const provider = harness?.provider ?? options.provider;
      const credentialRef = options.credentialRef ?? (options.auth === 'vendor-cli' && (harness ?? localHarnessForProvider(provider))
        ? `native:${(harness ?? localHarnessForProvider(provider))!.binary}:default` : undefined);
      if (!credentialRef) throw new Error('--credential-ref is required for oauth and api-key accounts (api-key: env:<VARIABLE>)');
      await later(accountCommands, 'aiAccountAdd')({ ...options, provider, credentialRef });
    });
  accounts.command('remove <labelOrId>').alias('rm').description('Remove a local account alias, not the provider credential').action(later(accountCommands, 'aiAccountRemove'));
  program.command('models').description('List the models your local accounts offer (--gateway: the ones ClikDeploy Gateway offers you, cheapest access first)')
    .option('--gateway', 'ClikDeploy Gateway\'s models instead')
    .action((options: { gateway?: boolean }) => options.gateway ? later(statusCommands, 'aiGatewayModels')(config) : later(statusCommands, 'aiModelsList')());
  program.command('usage').description('Your AI use, per day, provider and model (--gateway: your use and credit as ClikDeploy Gateway records it)')
    .option('--gateway', 'ClikDeploy Gateway\'s record instead')
    .option('--days <days>', 'With --gateway: window in days, 1-90 (default 30)')
    .action((options: { gateway?: boolean; days?: string }) => options.gateway ? later(statusCommands, 'aiGatewayUsage')(config, options) : later(statusCommands, 'aiUsage')());
  // One command for "ask something from a script": a new chat (or --chat to
  // continue one), bound to an account, and the message sent. It took four
  // before -- sessions create, accounts add, sessions set, sessions send.
  const send = async (prompt: string[], options: { harness?: string; chat?: string; model?: string; permissions?: string }): Promise<void> => {
    const id = await later(() => import('../commands/ai/harness.js'), 'startOrResumeChat')(options);
    await untilStopped(async (signal) => (await import('../worker/scripted-send.js')).sendScriptedTurn(config, id, prompt.join(' '), signal));
  };
  program.command('send <prompt...>').description('Send a message: in a new chat, or --chat <id|name|last> to continue one')
    .option('--harness <harness>', 'Harness to run it on, e.g. claude, codex, or clikcode-local (default: the one you are signed in to)')
    .option('--chat <chat>', 'Continue this chat: its id or the start of it, its name, or last')
    .option('--model <model>', 'Model to use')
    .option('--permissions <mode>', 'ask, auto, or bypass for this chat (default: your global setting)')
    .action(send);
  const acp = program.command('acp').description('Add an Agent Client Protocol harness the catalog does not ship');
  acp.command('list').description('List harnesses added on this machine').action(later(acpCommands, 'acpList'));
  acp.command('add <command> <binary> [argv...]')
    .description('Register an ACP executable. Arguments after the binary are its ACP flags, for example -- --stdio')
    .option('--name <name>', 'Name shown in the provider list')
    .option('--provider <provider>', 'Provider id, when it should not be acp:<command>')
    .allowUnknownOption()
    .action((command: string, binary: string, argv: string[], options: { name?: string; provider?: string }) => later(acpCommands, 'acpAdd')(command, binary, argv, options));
  acp.command('remove <command>').description('Remove a harness added on this machine').action(later(acpCommands, 'acpRemove'));
  const mcp = program.command('mcp').description("Record MCP servers for ClikCode's own agent");
  mcp.command('add')
    .argument('<name>', 'Name the server is known by')
    .argument('<target>', 'Command to launch, or a URL for a remote server')
    .argument('[args...]', 'Arguments for a launched command')
    .description("Record an MCP server for ClikCode's own agent. A harness keeps its own MCP configuration")
    .option('--client-id <id>', "A remote server's OAuth client id, where its authorization server registers none itself")
    .option('--callback-port <port>', 'The fixed loopback port that client id was registered with')
    .option('--scope <scopes>', 'OAuth scopes to ask for, when the server names none')
    // A server's own flags (`--browser chrome`) are its arguments, not ours.
    .allowUnknownOption()
    .action((name: string, target: string, args: string[], options: { clientId?: string; callbackPort?: string; scope?: string }) => later(mcpCommands, 'mcpAdd')(name, target, args, options));
  mcp.command('list')
    .description("List the MCP servers recorded for ClikCode's own agent")
    .action(later(mcpCommands, 'mcpList'));
  mcp.command('remove <name>')
    .description('Remove a server recorded in ClikCode (a harness\'s own servers are never touched)')
    .action(later(mcpCommands, 'mcpRemove'));
  mcp.command('login <name>')
    .description("Sign in to a remote server that asks for it (OAuth), for ClikCode's own agent")
    .action(later(mcpCommands, 'mcpLogin'));
  mcp.command('logout <name>')
    .description("Forget ClikCode's sign-in to a remote server")
    .action(later(mcpCommands, 'mcpLogout'));
  // Claude Code's plugins, as ClikCode's own agent uses them.
  const plugin = program.command('plugin').description('Choose which of Claude Code\'s plugins (skills, commands, agents, hooks, MCP servers) ClikCode\'s own agent uses');
  plugin.command('list').description('List the plugins installed for Claude Code, and whether ClikCode uses each')
    .action(async () => (await import('../commands/plugin.js')).pluginList());
  plugin.command('enable <plugin>').description('Use a plugin in ClikCode\'s own agent')
    .action(async (name: string) => (await import('../commands/plugin.js')).pluginSetEnabled(name, true));
  plugin.command('disable <plugin>').description('Stop using a plugin in ClikCode (Claude Code\'s setting is not changed)')
    .action(async (name: string) => (await import('../commands/plugin.js')).pluginSetEnabled(name, false));
  const gateway = program.command('gateway').description('Connect ClikDeploy Gateway for models and private agents');
  gateway.command('status').description('Show the gateway connection state').action(() => later(statusCommands, 'aiGatewayStatus')(config));
  gateway.command('credit').description('Add AI credit to your ClikDeploy Gateway account (opens a Stripe checkout)')
    .option('--amount <usd>', 'Whole dollars, 5-500 (default: your account\'s top-up amount)')
    .option('--auto-topup <on|off>', 'Turn automatic top-up of your saved card on or off, instead of buying')
    .action((options: { amount?: string; autoTopup?: string }) => later(statusCommands, 'aiGatewayCredit')(config, options));
  gateway.command('login').description('Sign in to ClikDeploy Gateway')
    .option('--github', 'Use GitHub OAuth instead of Google OAuth')
    .action(async (options) => { await later(() => import('../commands/gateway.js'), 'gatewayLogin')(config, { google: !options.github, github: Boolean(options.github) }); });
  // One command, two places to train: this computer (the default), or ClikDeploy with --cloud.
  const CLOUD_ONLY = ['hardware', 'yes'] as const;
  const LOCAL_ONLY = ['rank', 'license'] as const;
  program.command('finetune <dataset>').description('Fine-tune a model on your data (JSONL or CSV): on this computer, used again here as a local model; or --cloud, with ClikDeploy on a GPU (billed) or a CPU')
    .requiredOption('--base <repo>', 'The base model\'s Hugging Face repo, e.g. Qwen/Qwen2.5-0.5B-Instruct (original weights, not a GGUF)')
    .option('--name <name>', 'The name you will choose it by: it becomes tuned:<name> (required on this computer)')
    .option('--epochs <count>', 'Passes over the data, 1-10 (default 2)')
    .option('--rank <rank>', 'LoRA rank, 4-128 (default 8)')
    .option('--license <license>', 'The base model\'s license: apache-2.0 (default) or mit')
    .option('--cloud', 'Train with ClikDeploy instead of on this computer')
    .option('--hardware <gpu|cpu>', 'With --cloud: where to train (default gpu; cpu: your own connected machine at no charge, else a rented CPU)')
    .option('--yes', 'With --cloud: start at the quoted price; without it the quote is shown and nothing starts')
    .option('--no-wait', 'With --cloud: start it and return, instead of following it to its end')
    .action((dataset: string, options: Record<string, unknown>) => {
      const misplaced = (options.cloud ? LOCAL_ONLY : CLOUD_ONLY).filter((name) => options[name] !== undefined);
      if (misplaced.length) throw new Error(`--${misplaced[0]} is ${options.cloud ? 'for this computer only (leave out --cloud)' : 'for --cloud only'}.`);
      return options.cloud
        ? later(() => import('../commands/ai/finetune.js'), 'aiGatewayFineTune')(config, dataset, options)
        : later(() => import('../commands/ai/finetune-local.js'), 'aiLocalFineTune')(dataset, options);
    });
  const sessions = program.command('sessions').alias('session').description('Create and resume persistent coding sessions');
  sessions.command('list').alias('ls').description('List saved sessions').action(later(sessionCommands, 'aiSessionsList'));
  sessions.command('audit').description('Check every conversation against the evidence of how long it was (its index row, its saved records, the vendor threads that carried it); changes nothing')
    .option('--all', 'List every conversation, not only those whose store is behind').option('--id <id>', 'Only this conversation')
    .action((options) => later(() => import('../commands/ai/sessions-audit.js'), 'aiSessionsAudit')(options));
  sessions.command('repair <id>').description('Rebuild a conversation\'s log from the newest evidence (vendor threads, saved records). A dry run unless --apply; --apply copies every file the conversation has to repair-backups/ first')
    .option('--apply', 'Write the rebuilt log')
    .action((id, options) => later(() => import('../commands/ai/sessions-audit.js'), 'aiSessionsRepair')(id, options));
  sessions.command('show <id>').description('Show a saved session').action(later(sessionCommands, 'aiSessionShow'));
  sessions.command('command <id> <slash...>').description('Run /claude, /accounts, or another session slash command')
    .action(async (id, slash: string[]) => { await later(() => import('../tui/slash/handlers.js'), 'aiSessionCommand')(id, slash.join(' ')); });
  // `open` and `resume` were two commands for one thing.
  sessions.command('resume <chat>').alias('open').description('Resume a chat -- its id or the start of it, its name, or `last` -- and its exact native chat when available')
    .action((chat) => later(interactiveCommands, 'aiSessionResume')(config, chat));
  sessions.command('close <id>').description('Close a session without deleting its local history')
    .action((id) => later(sessionCommands, 'aiSessionClose')(id));
  // A chat with no turn yet, for tests that open one (packages/vscode integration). Everyone else: send.
  sessions.command('create', { hidden: true })
    .option('--route <route>', 'local, gateway, or clikcode-local', 'local').option('--account <account>', 'Local account label or id')
    .option('--provider <provider>', 'Provider id').option('--model <model>', 'Model id')
    .option('--agent <id>', 'Gateway agent ID')
    .option('--effort <effort>', 'Provider-native reasoning level')
    .action((options) => later(sessionCommands, 'aiSessionCreate')(options));
}
