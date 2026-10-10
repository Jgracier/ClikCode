/**
 * The public ClikCode command surface.
 *
 * The `gateway` group is the only part that talks to a remote platform.
 */
import { untilStopped } from './stop-signal.js';
import type { Command } from 'commander';
import { acpAdd, acpList, acpRemove } from '../commands/acp.js';
import { mcpAdd, mcpList, mcpLogin, mcpLogout, mcpRemove, mcpTargets } from '../commands/mcp.js';
import type Conf from 'conf';
import { sendScriptedTurn } from '../worker/scripted-send.js';
import { aiPermissions } from '../tui/pickers/permissions.js';
import { aiSessionResume } from '../commands/ai/interactive.js';
import { aiSessionCommand } from '../tui/slash/handlers.js';
import { aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountStatus, aiAccountsList, aiDoctor } from '../commands/account.js';
import { localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import { startOrResumeChat } from '../commands/ai/harness.js';
import { aiSessionClose, aiSessionCreate, aiSessionSet, aiSessionShow, aiSessionsList } from '../commands/ai/sessions.js';
import { aiGatewayModels, aiGatewayStatus, aiGatewayUsage, aiGatewayCredit, aiModelsList, aiUsage } from '../commands/ai/status.js';
import { aiStart, aiStatus, aiStop } from '../daemon/server.js';
import { gatewayLogin } from '../commands/gateway.js';
import {
  AGENT_EFFORTS, gatewayAgentCreate, gatewayAgentDelete, gatewayAgentEventAdd, gatewayAgentList, gatewayAgentScheduleAdd,
  gatewayAgentSet, gatewayAgentShow, gatewayAgentTools, gatewayAgentTriggerRemove, gatewayAgentTriggers,
  type AgentSettingsOptions, type ScheduleOptions,
} from '../commands/gateway-agents.js';
import { runSessionWorker } from '../worker/session-worker.js';

export function registerClikCodeCommands(program: Command, config: Conf): void {
  // Not a user command: the entry point client.ts's spawnSessionWorker spawns
  // as a fresh, detached process (see worker/client.ts). Hidden rather than
  // undocumented-but-listed, since running it by hand does something real
  // (binds a socket, writes a runtime record) that only makes sense as a
  // spawn target.
  program.command('session-worker <id>', { hidden: true }).action((id: string) => runSessionWorker(id));
  // An editor extension's client (ide/bridge.ts), over an IPC channel the
  // extension opens; and the terminal it runs a vendor sign-in in. Hidden for
  // the same reason as session-worker: neither is anything to type.
  program.command('ide-bridge', { hidden: true }).action(async () => (await import('../ide/bridge.js')).runIdeBridge(config));
  program.command('ide-terminal <spec>', { hidden: true }).action(async (spec: string) => (await import('../ide/terminal.js')).runIdeTerminal(spec));
  program.command('conversations-mcp', { hidden: true }).description('Serves search_conversations, read_conversation, active_conversations and hindsight to a vendor agent over stdio MCP').action(async () => (await import('../search/mcp.js')).serveConversationsMcp());
  program.command('swarm-mcp', { hidden: true }).description('Answers the swarm tool for the conversation that spawned it').action(async () => (await import('../swarm/mcp.js')).serveSwarmMcp());
  program.command('start').description('Start the optional loopback-only control API')
    .option('--port <port>', 'Optional explicit loopback port; default is OS-assigned')
    .action((options) => aiStart(config, options));
  program.command('status').description('Show the optional local control API runtime').action(aiStatus);
  program.command('stop').description('Stop this ClikCode installation’s optional control API').action(aiStop);
  program.command('doctor').description('Inspect installed harness versions and centralized capabilities').action(aiDoctor);
  program.command('logs').description('What every ClikCode window, worker and editor bridge did, in order (the lifecycle log)')
    .option('--session <id>', 'Only this conversation (an id or the start of one)')
    .option('--role <role>', 'Only window, worker, bridge or command')
    .option('--since <age>', 'Only the last 30s, 10m, 2h, 1d')
    .option('-n, --lines <count>', 'How many lines (default 100)')
    .option('-f, --follow', 'Keep printing as it is written')
    .action(async (options) => (await import('../commands/logs.js')).showLogs(options));
  program.command('permissions [mode]').description('Choose Ask, Bypass, or Auto approval behavior for the active chat')
    .action((mode?: string) => aiPermissions(mode));
  const accounts = program.command('accounts').alias('account').description('Manage local provider accounts');
  accounts.command('list').alias('ls').description('List local accounts and the usage left on each')
    .option('--models', 'Include each account\'s model list').action((options: { models?: boolean }) => aiAccountsList(options));
  accounts.command('providers').description('List supported local harnesses and login kinds').action(aiAccountProviders);
  accounts.command('login <harness>').description('Install if necessary, then run the harness’s official local login flow')
    .option('--label <label>', 'Local account label')
    .action(async (harness, options) => {
      await aiAccountLogin(harness, options.label);
    });
  accounts.command('status <labelOrId>').description('Run the vendor’s declared account-status check').action(aiAccountStatus);
  accounts.command('logout <labelOrId>').description('Run vendor logout and retain the local alias as needs-login').action(aiAccountLogout);
  accounts.command('add').description('Register a local provider login reference; credentials remain on this device')
    .requiredOption('--provider <provider>', 'Harness (claude, codex) or provider id (anthropic, openai)')
    .option('--label <label>', 'Local account alias (api-key: defaults to the email behind the key, where its vendor tells)')
    .requiredOption('--auth <kind>', 'api-key or vendor-cli; use the vendor login flow for OAuth')
    .option('--credential-ref <ref>', 'OS-keychain or vendor-CLI profile reference; never a token (vendor-cli: defaults to the CLI\'s own sign-in)')
    .option('--model <model...>', 'Model ids available through this account')
    .action(async (options) => {
      const harness = localHarnessForCommand(options.provider);
      const provider = harness?.provider ?? options.provider;
      const credentialRef = options.credentialRef ?? (options.auth === 'vendor-cli' && (harness ?? localHarnessForProvider(provider))
        ? `native:${(harness ?? localHarnessForProvider(provider))!.binary}:default` : undefined);
      if (!credentialRef) throw new Error('--credential-ref is required for oauth and api-key accounts (api-key: env:<VARIABLE>)');
      await aiAccountAdd({ ...options, provider, credentialRef });
    });
  accounts.command('remove <labelOrId>').alias('rm').description('Remove a local account alias, not the provider credential').action(aiAccountRemove);
  program.command('models').description('List normalized models available through local accounts').action(aiModelsList);
  program.command('usage').description('Show normalized local AI invocation usage').action(aiUsage);
  // One command for "ask something from a script": a new chat (or --chat to
  // continue one), bound to an account, and the message sent. It took four
  // before -- sessions create, accounts add, sessions set, sessions send.
  const send = async (prompt: string[], options: { harness?: string; chat?: string; model?: string; permissions?: string }): Promise<void> => {
    const id = await startOrResumeChat(options);
    await untilStopped((signal) => sendScriptedTurn(config, id, prompt.join(' '), signal));
  };
  program.command('send <prompt...>').description('Send a message: in a new chat, or --chat <id|name|last> to continue one')
    .option('--harness <harness>', 'Harness to run it on, e.g. claude, codex, or clikcode-local (default: the one you are signed in to)')
    .option('--chat <chat>', 'Continue this chat: its id or the start of it, its name, or last')
    .option('--model <model>', 'Model to use')
    .option('--permissions <mode>', 'ask, auto, or bypass for this chat (default: your global setting)')
    .action(send);
  const acp = program.command('acp').description('Add an Agent Client Protocol harness the catalog does not ship');
  acp.command('list').description('List harnesses added on this machine').action(acpList);
  acp.command('add <command> <binary> [argv...]')
    .description('Register an ACP executable. Arguments after the binary are its ACP flags, for example -- --stdio')
    .option('--name <name>', 'Name shown in the provider list')
    .option('--provider <provider>', 'Provider id, when it should not be acp:<command>')
    .allowUnknownOption()
    .action((command: string, binary: string, argv: string[], options: { name?: string; provider?: string }) => acpAdd(command, binary, argv, options));
  acp.command('remove <command>').description('Remove a harness added on this machine').action(acpRemove);
  // Recorded once. Each harness receives it when that provider is chosen.
  const mcp = program.command('mcp').description('Record an MCP server for whichever harness you choose');
  mcp.command('add')
    .argument('<name>', 'Name the server is known by')
    .argument('<target>', 'Command to launch, or a URL for a remote server')
    .argument('[args...]', 'Arguments for a launched command')
    .description('Record an MCP server. It is installed into a harness when you choose that provider, if the name is not already there')
    .option('--client-id <id>', "A remote server's OAuth client id, where its authorization server registers none itself")
    .option('--callback-port <port>', 'The fixed loopback port that client id was registered with')
    .option('--scope <scopes>', 'OAuth scopes to ask for, when the server names none')
    // A server's own flags (`--browser chrome`) are its arguments, not ours.
    .allowUnknownOption()
    .action((name: string, target: string, args: string[], options: { clientId?: string; callbackPort?: string; scope?: string }) => mcpAdd(name, target, args, options));
  mcp.command('list')
    .description('List the MCP servers recorded in ClikCode, and the harnesses ClikCode has given each')
    .action(mcpList);
  mcp.command('remove <name>')
    .description('Remove a server from ClikCode, and take ClikCode\'s own copies back out of every harness (never one you added there)')
    .action(mcpRemove);
  mcp.command('login <name>')
    .description("Sign in to a remote server that asks for it (OAuth), for ClikCode's own agent")
    .action(mcpLogin);
  mcp.command('logout <name>')
    .description("Forget ClikCode's sign-in to a remote server")
    .action(mcpLogout);
  mcp.command('targets')
    .description('Show how each harness would be given a server, when you choose it')
    .action(mcpTargets);
  // Claude Code-format plugins for ClikCode's own agent.
  const plugin = program.command('plugin').description('Install Claude Code-format plugins (skills, commands, agents, hooks, MCP servers) for ClikCode\'s own agent');
  plugin.command('add <source>')
    .description('Install a plugin from a directory, a git URL, or name@marketplace')
    .action(async (source: string) => (await import('../commands/plugin.js')).pluginAdd(source));
  plugin.command('list').description('List ClikCode\'s plugins and the ones installed for Claude Code')
    .action(async () => (await import('../commands/plugin.js')).pluginList());
  plugin.command('remove <plugin>').description('Uninstall a plugin added in ClikCode')
    .action(async (name: string) => (await import('../commands/plugin.js')).pluginRemove(name));
  plugin.command('enable <plugin>').description('Use a plugin in ClikCode\'s own agent')
    .action(async (name: string) => (await import('../commands/plugin.js')).pluginSetEnabled(name, true));
  plugin.command('disable <plugin>').description('Stop using a plugin in ClikCode (Claude Code\'s setting is not changed)')
    .action(async (name: string) => (await import('../commands/plugin.js')).pluginSetEnabled(name, false));
  const marketplace = plugin.command('marketplace').description('Plugin marketplaces: a directory or git repository with .claude-plugin/marketplace.json');
  marketplace.command('add <source>').description('Add a marketplace from a directory or a git URL')
    .action(async (source: string) => (await import('../commands/plugin.js')).pluginMarketplaceAdd(source));
  marketplace.command('list').description('List marketplaces, ClikCode\'s and Claude Code\'s')
    .action(async () => (await import('../commands/plugin.js')).pluginMarketplaceList());
  marketplace.command('remove <name>').description('Remove a marketplace added in ClikCode')
    .action(async (name: string) => (await import('../commands/plugin.js')).pluginMarketplaceRemove(name));
  const gateway = program.command('gateway').description('Connect ClikDeploy Gateway for models and private agents');
  gateway.command('status').description('Show the gateway connection state').action(() => aiGatewayStatus(config));
  gateway.command('models').description('List the models ClikDeploy Gateway offers you, cheapest access first')
    .action(() => aiGatewayModels(config));
  const gatewayAgents = gateway.command('agents').description('List and build your Gateway agents (and, as the super admin, the platform agents)');
  gatewayAgents.command('list').description('List the agents you manage').action(() => gatewayAgentList(config));
  gatewayAgents.command('show <agent>').description('Show an agent\'s settings and when it runs (id, handle or name)')
    .action((agent: string) => gatewayAgentShow(config, agent));
  gatewayAgents.command('tools').description('List the toolsets and tools you may give an agent').action(() => gatewayAgentTools(config));
  const totpOption = (command: Command) => command.option('--totp <code>', 'Authenticator code, for a platform agent without a prompt');
  const settingOptions = (command: Command) => command
    .option('--name <name>', 'Agent name')
    .option('--description <text>', 'Short description')
    .option('--instructions <text>', 'The agent\'s instructions')
    .option('--instructions-file <path>', 'UTF-8 file containing the agent\'s instructions')
    .option('--tools <edit...>', 'add|remove|set, then toolset or tool names (see `tools`); set none clears them')
    .option('--model <id>', 'Model id, or auto')
    .option('--effort <level>', `auto or ${AGENT_EFFORTS.join(', ')}`)
    .option('--permission <mode>', 'ask, auto or bypass')
    .option('--spend-limit <usd>', 'USD of paid models per day: 0 = subscriptions and free only, none = no cap')
    .option('--on', 'Switch the agent on')
    .option('--off', 'Switch the agent off');
  settingOptions(gatewayAgents.command('create').description('Build an agent of your own'))
    .action((options: AgentSettingsOptions) => gatewayAgentCreate(config, options));
  totpOption(settingOptions(gatewayAgents.command('set <agent>').description('Change an agent\'s settings')))
    .action((agent: string, options: AgentSettingsOptions) => gatewayAgentSet(config, agent, options));
  totpOption(gatewayAgents.command('delete <agent>').alias('remove').description('Delete an agent'))
    .action((agent: string, options: { totp?: string }) => gatewayAgentDelete(config, agent, options));
  const schedules = gatewayAgents.command('schedules').description('When an agent runs on a clock');
  schedules.command('list <agent>').description('List an agent\'s schedules and the presets')
    .action((agent: string) => gatewayAgentTriggers(config, agent, 'schedule'));
  totpOption(schedules.command('add <agent>').description('Run an agent on a schedule')
    .option('--cron <expression>', 'Cron expression, in UTC')
    .option('--preset <name>', 'hourly, daily, weekdays or weekly')
    .option('--at <time>', 'Once, at this date and time')
    .option('--instruction <text>', 'What to do when it runs')
    .option('--off', 'Add it switched off'))
    .action((agent: string, options: ScheduleOptions) => gatewayAgentScheduleAdd(config, agent, options));
  totpOption(schedules.command('remove <agent> <scheduleId>').description('Remove a schedule'))
    .action((agent: string, id: string, options: { totp?: string }) => gatewayAgentTriggerRemove(config, agent, id, options));
  const events = gatewayAgents.command('events').description('When an agent runs on a platform event');
  events.command('list <agent>').description('List an agent\'s event triggers and the events available to you')
    .action((agent: string) => gatewayAgentTriggers(config, agent, 'event'));
  totpOption(events.command('add <agent> <event>').description('Run an agent when an event happens')
    .option('--instruction <text>', 'What to do when it runs')
    .option('--off', 'Add it switched off'))
    .action((agent: string, event: string, options: { instruction?: string; off?: boolean; totp?: string }) => gatewayAgentEventAdd(config, agent, event, options));
  totpOption(events.command('remove <agent> <triggerId>').description('Remove an event trigger'))
    .action((agent: string, id: string, options: { totp?: string }) => gatewayAgentTriggerRemove(config, agent, id, options));
  gateway.command('usage').description('Show your AI use and credit as ClikDeploy Gateway records it')
    .option('--days <days>', 'Window in days, 1-90 (default 30)')
    .action((options: { days?: string }) => aiGatewayUsage(config, options));
  gateway.command('credit').description('Add AI credit to your ClikDeploy Gateway account (opens a Stripe checkout)')
    .option('--amount <usd>', 'Whole dollars, 5-500 (default: your account\'s top-up amount)')
    .option('--auto-topup <on|off>', 'Turn automatic top-up of your saved card on or off, instead of buying')
    .action((options: { amount?: string; autoTopup?: string }) => aiGatewayCredit(config, options));
  gateway.command('login').description('Sign in to ClikDeploy Gateway')
    .option('--github', 'Use GitHub OAuth instead of Google OAuth')
    .action(async (options) => { await gatewayLogin(config, { google: !options.github, github: Boolean(options.github) }); });
  const sessions = program.command('sessions').alias('session').description('Create and resume persistent coding sessions');
  sessions.command('list').alias('ls').description('List saved sessions').action(aiSessionsList);
  sessions.command('show <id>').description('Show a saved session').action(aiSessionShow);
  // `send --chat <chat>`, under its older name.
  sessions.command('send <chat> <prompt...>').alias('chat').description('Send a turn through a saved chat (its id or the start of it, its name, or last)')
    .action((chat: string, prompt: string[]) => send(prompt, { chat }));
  sessions.command('command <id> <slash...>').alias('slash').description('Run /claude, /accounts, or another session slash command')
    .action(async (id, slash: string[]) => { await aiSessionCommand(id, slash.join(' ')); });
  // `open` and `resume` were two commands for one thing.
  sessions.command('resume <chat>').aliases(['open', 'interactive']).description('Resume a chat -- its id or the start of it, its name, or `last` -- and its exact native chat when available')
    .action((chat) => aiSessionResume(config, chat));
  sessions.command('close <id>').description('Close a session without deleting its local history')
    .action((id) => aiSessionClose(id));
  sessions.command('set <id>').description('Change route, account, provider, model, agent, or effort')
    .option('--route <route>', 'local, gateway, or clikcode-local').option('--account <account>', 'Local account label or id')
    .option('--provider <provider>', 'Provider id').option('--model <model>', 'Model id')
    .option('--agent <id>', 'Gateway agent ID, or none to use the normal Gateway')
    .option('--native-session <id>', 'Verified native session id to resume through its adapter')
    .option('--effort <effort>', 'low, medium, high, or xhigh').option('--permissions <mode>', 'ask, bypass, or auto')
    .option('--sandbox <mode>', "workspace (the default) or off: ClikCode's own agent's shell commands write only the workspace, temp and caches")
    .action((id, options) => aiSessionSet(id, options));
  sessions.command('create').description('Create a session')
    .option('--route <route>', 'local, gateway, or clikcode-local', 'local').option('--account <account>', 'Local account label or id')
    .option('--provider <provider>', 'Provider id').option('--model <model>', 'Model id')
    .option('--agent <id>', 'Gateway agent ID')
    .option('--effort <effort>', 'Provider-native reasoning level')
    .action((options) => aiSessionCreate(options));
}
