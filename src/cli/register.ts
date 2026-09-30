/**
 * The public ClikCode command surface.
 *
 * The `gateway` group is the only part that talks to a remote platform.
 */
import { untilStopped } from './stop-signal.js';
import type { Command } from 'commander';
import { acpAdd, acpList, acpRemove } from '../commands/acp.js';
import { mcpAdd, mcpTargets } from '../commands/mcp.js';
import type Conf from 'conf';
import { sendScriptedTurn } from '../worker/scripted-send.js';
import { aiPermissions } from '../tui/pickers/permissions.js';
import { aiSessionInteractive, aiSessionResume } from '../commands/ai/interactive.js';
import { aiSessionCommand } from '../tui/slash/handlers.js';
import { aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountStatus, aiAccountsList, aiDoctor, announceBareInteractiveLogin } from '../commands/account.js';
import { localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import { ensureChatReady, resolveChat, startOrResumeChat } from '../commands/ai/harness.js';
import { aiSessionClose, aiSessionCreate, aiSessionSet, aiSessionShow, aiSessionsList } from '../commands/ai/sessions.js';
import { aiGatewayModels, aiGatewayStatus, aiGatewayUsage, aiGatewayCredit, aiModelsList, aiUsage } from '../commands/ai/status.js';
import { aiStart, aiStatus, aiStop } from '../daemon/server.js';
import { gatewayLogin } from '../commands/gateway.js';
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
  program.command('start').description('Start the optional loopback-only control API')
    .option('--port <port>', 'Optional explicit loopback port; default is OS-assigned')
    .action((options) => aiStart(config, options));
  program.command('status').description('Show the optional local control API runtime').action(aiStatus);
  program.command('stop').description('Stop this ClikCode installation’s optional control API').action(aiStop);
  program.command('doctor').description('Inspect installed harness versions and centralized capabilities').action(aiDoctor);
  program.command('permissions [mode]').description('Choose Ask, Bypass, or Auto approval behavior for the active chat')
    .action((mode?: string) => aiPermissions(mode));
  const accounts = program.command('accounts').alias('account').description('Manage local provider accounts');
  accounts.command('list').alias('ls').description('List local accounts without credential material').action(aiAccountsList);
  accounts.command('providers').description('List supported local harnesses and login kinds').action(aiAccountProviders);
  accounts.command('login <harness>').description('Install if necessary, then run the harness’s official local login flow')
    .option('--label <label>', 'Local account label')
    .action(async (harness, options) => {
      const definition = localHarnessForCommand(harness);
      if (definition) announceBareInteractiveLogin(definition);
      await aiAccountLogin(harness, options.label);
    });
  accounts.command('status <labelOrId>').description('Run the vendor’s declared account-status check').action(aiAccountStatus);
  accounts.command('logout <labelOrId>').description('Run vendor logout and retain the local alias as needs-login').action(aiAccountLogout);
  accounts.command('add').description('Register a local provider login reference; credentials remain on this device')
    .requiredOption('--provider <provider>', 'Harness (claude, codex) or provider id (anthropic, openai)')
    .requiredOption('--label <label>', 'Local account alias')
    .requiredOption('--auth <kind>', 'api-key or vendor-cli; use the vendor login flow for OAuth')
    .option('--credential-ref <ref>', 'OS-keychain or vendor-CLI profile reference; never a token (vendor-cli: defaults to the CLI\'s own sign-in)')
    .option('--model <model...>', 'Model ids available through this account')
    .action((options) => {
      const harness = localHarnessForCommand(options.provider);
      const provider = harness?.provider ?? options.provider;
      const credentialRef = options.credentialRef ?? (options.auth === 'vendor-cli' && (harness ?? localHarnessForProvider(provider))
        ? `native:${(harness ?? localHarnessForProvider(provider))!.binary}:default` : undefined);
      if (!credentialRef) throw new Error('--credential-ref is required for oauth and api-key accounts (api-key: env:<VARIABLE>)');
      return aiAccountAdd({ ...options, provider, credentialRef });
    });
  accounts.command('remove <labelOrId>').alias('rm').description('Remove a local account alias, not the provider credential').action(aiAccountRemove);
  program.command('models').description('List normalized models available through local accounts').action(aiModelsList);
  program.command('usage').description('Show normalized local AI invocation usage').action(aiUsage);
  // One command for "ask something from a script": a new chat (or --chat to
  // continue one), bound to an account, and the message sent. It took four
  // before -- sessions create, accounts add, sessions set, sessions send.
  program.command('send <prompt...>').description('Send a message: in a new chat, or --chat <id|name|last> to continue one')
    .option('--harness <harness>', 'Harness to run it on, e.g. claude, codex, or clikcode-local (default: the one you are signed in to)')
    .option('--chat <chat>', 'Continue this chat: its id or the start of it, its name, or last')
    .option('--model <model>', 'Model to use')
    .option('--permissions <mode>', 'ask, auto, or bypass for this chat (default: your global setting)')
    .action(async (prompt: string[], options: { harness?: string; chat?: string; model?: string; permissions?: string }) => {
      const id = await startOrResumeChat(options);
      await untilStopped((signal) => sendScriptedTurn(config, id, prompt.join(' '), signal));
    });
  const acp = program.command('acp').description('Add an Agent Client Protocol harness the catalog does not ship');
  acp.command('list').description('List harnesses added on this machine').action(acpList);
  acp.command('add <command> <binary> [argv...]')
    .description('Register an ACP executable. Arguments after the binary are its ACP flags, for example -- --stdio')
    .option('--name <name>', 'Name shown in the provider list')
    .option('--provider <provider>', 'Provider id, when it should not be acp:<command>')
    .allowUnknownOption()
    .action((command: string, binary: string, argv: string[], options: { name?: string; provider?: string }) => acpAdd(command, binary, argv, options));
  acp.command('remove <command>').description('Remove a harness added on this machine').action(acpRemove);
  // One MCP server, added once, written into every harness that takes one.
  const mcp = program.command('mcp').description('Share an MCP server with every harness that supports one');
  mcp.command('add')
    .argument('<name>', 'Name the server is known by')
    .argument('<target>', 'Command to launch, or a URL for a remote server')
    .argument('[args...]', 'Arguments for a launched command')
    .description('Install an MCP server into every harness that supports MCP')
    .action((name: string, target: string, args: string[]) => mcpAdd(name, target, args));
  mcp.command('targets')
    .description('Show which harnesses would receive it, and how each spells the request')
    .action(mcpTargets);
  const gateway = program.command('gateway').description('Connect ClikDeploy Gateway for remote models');
  gateway.command('status').description('Show the gateway connection state').action(() => aiGatewayStatus(config));
  gateway.command('models').description('List the models ClikDeploy Gateway offers you, cheapest access first')
    .action(() => aiGatewayModels(config));
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
  sessions.command('send <chat> <prompt...>').alias('chat').description('Send a turn through a saved chat (its id or the start of it, its name, or last)')
    .action(async (chat: string, prompt: string[]) => {
      const id = await resolveChat(chat);
      await ensureChatReady(id);
      await untilStopped((signal) => sendScriptedTurn(config, id, prompt.join(' '), signal));
    });
  sessions.command('command <id> <slash...>').alias('slash').description('Run /claude, /accounts, or another session slash command')
    .action(async (id, slash: string[]) => { await aiSessionCommand(id, slash.join(' ')); });
  // `open` and `resume` were two commands for one thing.
  sessions.command('resume <chat>').aliases(['open', 'interactive']).description('Resume a chat -- its id or the start of it, its name, or `last` -- and its exact native chat when available')
    .action((chat) => aiSessionResume(config, chat));
  sessions.command('close <id>').description('Close a session without deleting its local history')
    .action((id) => aiSessionClose(id));
  sessions.command('set <id>').description('Change route, account, provider, model, or effort')
    .option('--route <route>', 'local, gateway, or clikcode-local').option('--account <account>', 'Local account label or id')
    .option('--provider <provider>', 'Provider id').option('--model <model>', 'Model id')
    .option('--native-session <id>', 'Verified native session id to resume through its adapter')
    .option('--effort <effort>', 'low, medium, high, or xhigh').option('--permissions <mode>', 'ask, bypass, or auto')
    .option('--account-failover <mode>', 'never or on-quota-exhausted')
    .action((id, options) => aiSessionSet(id, options));
  sessions.command('create').description('Create a session')
    .option('--route <route>', 'local, gateway, or clikcode-local', 'local').option('--account <account>', 'Local account label or id')
    .option('--provider <provider>', 'Provider id').option('--model <model>', 'Model id')
    .option('--effort <effort>', 'Provider-native reasoning level').option('--account-failover <mode>', 'never or on-quota-exhausted')
    .action((options) => aiSessionCreate(options));
}
