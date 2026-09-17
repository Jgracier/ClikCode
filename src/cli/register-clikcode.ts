/** The public ClikCode command surface. It intentionally does not expose deployment commands. */
import type { Command } from 'commander';
import type Conf from 'conf';
import {
  aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountStatus, aiAccountsList,
  aiDoctor, aiGatewaySessionSend, aiGatewayStatus, aiModelsList, aiSessionCommand,
  aiSessionClose, aiSessionCreate, aiSessionInteractive, aiSessionResume, aiSessionSet, aiSessionShow,
  aiSessionsList, aiStart, aiStatus, aiStop, aiUsage,
} from '../commands/ai.js';
import { login } from '../commands/auth.js';

export function registerClikCodeCommands(program: Command, config: Conf): void {
  program.command('start').description('Start the optional loopback-only control API')
    .option('--port <port>', 'Optional explicit loopback port; default is OS-assigned')
    .action((options) => aiStart(config, options));
  program.command('status').description('Show the optional local control API runtime').action(aiStatus);
  program.command('stop').description('Stop this ClikCode installation’s optional control API').action(aiStop);
  program.command('doctor').description('Inspect installed harness versions and centralized capabilities').action(aiDoctor);
  const accounts = program.command('accounts').alias('account').description('Manage local provider accounts');
  accounts.command('list').alias('ls').description('List local accounts without credential material').action(aiAccountsList);
  accounts.command('providers').description('List supported local harnesses and login kinds').action(aiAccountProviders);
  accounts.command('login <harness>').description('Install if necessary, then run the harness’s official local login flow')
    .option('--label <label>', 'Local account label')
    .action((harness, options) => aiAccountLogin(harness, options.label));
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
  const gateway = program.command('gateway').description('Optionally connect ClikDeploy Gateway');
  gateway.command('status').description('Show the ClikDeploy Gateway connection state').action(() => aiGatewayStatus(config));
  gateway.command('login').description('Sign in to ClikDeploy for optional Gateway model access')
    .option('--github', 'Use GitHub OAuth instead of Google OAuth')
    .action((options) => login(config, { google: !options.github, github: Boolean(options.github) }));
  const sessions = program.command('sessions').alias('session').description('Create and resume persistent coding sessions');
  sessions.command('list').alias('ls').description('List saved sessions').action(aiSessionsList);
  sessions.command('show <id>').description('Show a saved session').action(aiSessionShow);
  sessions.command('send <id> <prompt...>').alias('chat').description('Send a turn through a saved session')
    .action((id, prompt: string[]) => aiGatewaySessionSend(config, id, prompt.join(' ')));
  sessions.command('command <id> <slash...>').alias('slash').description('Run /claude, /accounts, or another session slash command')
    .action((id, slash: string[]) => aiSessionCommand(id, slash.join(' ')));
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
    .option('--effort <effort>', 'low, medium, high, or xhigh').option('--account-failover <mode>', 'never or on-quota-exhausted')
    .action((id, options) => aiSessionSet(id, options));
  sessions.command('create').description('Create a session')
    .option('--route <route>', 'local or gateway', 'local').option('--account <account>', 'Local account label or id')
    .option('--provider <provider>', 'Provider id').option('--model <model>', 'Model id')
    .option('--effort <effort>', 'Provider-native reasoning level').option('--account-failover <mode>', 'never or on-quota-exhausted')
    .action((options) => aiSessionCreate(options));
}
