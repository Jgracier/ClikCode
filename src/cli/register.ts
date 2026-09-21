/**
 * The public ClikCode command surface.
 *
 * The `gateway` group is the only part that talks to a remote platform, and it
 * is registered only when the optional gateway is enabled — see constants.ts.
 */
import type { Command } from 'commander';
import { mcpAdd, mcpTargets } from '../commands/mcp.js';
import type Conf from 'conf';
import { aiGatewaySessionSend } from '../turn/drive.js';
import { aiPermissions } from '../tui/pickers/permissions.js';
import { aiSessionInteractive, aiSessionResume } from '../commands/ai/interactive.js';
import { aiSessionCommand } from '../tui/slash/handlers.js';
import { aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountStatus, aiAccountsList, aiDoctor } from '../commands/account.js';
import { aiSessionClose, aiSessionCreate, aiSessionSet, aiSessionShow, aiSessionsList } from '../commands/ai/sessions.js';
import { aiGatewayStatus, aiModelsList, aiUsage } from '../commands/ai/status.js';
import { aiStart, aiStatus, aiStop } from '../daemon/server.js';
import { gatewayLogin } from '../commands/gateway.js';
import { isGatewayEnabled } from '../constants.js';

export function registerClikCodeCommands(program: Command, config: Conf): void {
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
    .action(async (harness, options) => { await aiAccountLogin(harness, options.label); });
  accounts.command('status <labelOrId>').description('Run the vendor’s declared account-status check').action(aiAccountStatus);
  accounts.command('logout <labelOrId>').description('Run vendor logout and retain the local alias as needs-login').action(aiAccountLogout);
  accounts.command('add').description('Register a local provider login reference; credentials remain on this device')
    .requiredOption('--provider <provider>', 'Provider id, e.g. openai or anthropic')
    .requiredOption('--label <label>', 'Local account alias')
    .requiredOption('--auth <kind>', 'oauth, api-key, or vendor-cli')
    .requiredOption('--credential-ref <ref>', 'OS-keychain or vendor-CLI profile reference; never a token')
    .option('--model <model...>', 'Model ids available through this account')
    .action((options) => aiAccountAdd(options));
  accounts.command('remove <labelOrId>').alias('rm').description('Remove a local account alias, not the provider credential').action(aiAccountRemove);
  program.command('models').description('List normalized models available through local accounts').action(aiModelsList);
  program.command('usage').description('Show normalized local AI invocation usage').action(aiUsage);
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
  if (isGatewayEnabled()) {
    const gateway = program.command('gateway').description('Optionally connect a hosted gateway for remote models');
    gateway.command('status').description('Show the gateway connection state').action(() => aiGatewayStatus(config));
    gateway.command('login').description('Sign in to the configured gateway for optional remote model access')
      .option('--github', 'Use GitHub OAuth instead of Google OAuth')
      .action(async (options) => { await gatewayLogin(config, { google: !options.github, github: Boolean(options.github) }); });
  }
  const sessions = program.command('sessions').alias('session').description('Create and resume persistent coding sessions');
  sessions.command('list').alias('ls').description('List saved sessions').action(aiSessionsList);
  sessions.command('show <id>').description('Show a saved session').action(aiSessionShow);
  sessions.command('send <id> <prompt...>').alias('chat').description('Send a turn through a saved session')
    .action((id, prompt: string[]) => aiGatewaySessionSend(config, id, prompt.join(' ')));
  sessions.command('command <id> <slash...>').alias('slash').description('Run /claude, /accounts, or another session slash command')
    .action(async (id, slash: string[]) => { await aiSessionCommand(id, slash.join(' ')); });
  sessions.command('open <id>').alias('interactive').description('Open a persistent session; use /accounts, /claude, or /exit')
    .action((id) => aiSessionInteractive(config, id));
  sessions.command('resume <id>').description('Resume a ClikCode session and its exact native chat when available')
    .action((id) => aiSessionResume(config, id));
  sessions.command('close <id>').description('Close a session without deleting its local history')
    .action((id) => aiSessionClose(id));
  sessions.command('set <id>').description('Change route, account, provider, model, or effort')
    .option('--route <route>', 'local or gateway').option('--account <account>', 'Local account label or id')
    .option('--provider <provider>', 'Provider id').option('--model <model>', 'Model id')
    .option('--native-session <id>', 'Verified native session id to resume through its adapter')
    .option('--effort <effort>', 'low, medium, high, or xhigh').option('--permissions <mode>', 'ask, bypass, or auto')
    .option('--account-failover <mode>', 'never or on-quota-exhausted')
    .action((id, options) => aiSessionSet(id, options));
  sessions.command('create').description('Create a session')
    .option('--route <route>', 'local or gateway', 'local').option('--account <account>', 'Local account label or id')
    .option('--provider <provider>', 'Provider id').option('--model <model>', 'Model id')
    .option('--effort <effort>', 'Provider-native reasoning level').option('--account-failover <mode>', 'never or on-quota-exhausted')
    .action((options) => aiSessionCreate(options));
}
