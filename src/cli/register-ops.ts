/**
 * Vendor set-up commands under `computer` (unattended mode, OAuth connect, the queue, recipes). Listed in --help only with
 * CLIKCODE_OPS=1. ClikDeploy's connector pipeline is not here: it lives in ClikDeploy (packages/connector-worker) and drives
 * ClikCode through its public `computer` and `agent` commands.
 */
import type { Command } from 'commander';

export function registerOperatorCommands(program: Command, computer: Command): void {
  const ops = { hidden: process.env.CLIKCODE_OPS !== '1' };
  computer.command('unattended [setting]', ops).description('on or off: park what needs you (a password, a code, an account choice) in the queue and go on, instead of asking (default off)').action(async (setting?: string) => (await import('../commands/computer.js')).computerUnattended(setting));
  computer.command('oauth-connect <connector>', ops).description("Connect a ClikDeploy connector for your account: start its OAuth, press through the vendor's consent in the ClikCode browser (stops at a password, code or captcha), confirm it is active. With --json: {ok, note} or {ok:false, stop}")
    .option('--tab <name>', 'The tab to work in (default oauth)').option('--egress <name>', 'The way out the tab leaves through')
    .action(async (connector: string, flags: { tab?: string; egress?: string }) => (await import('../commands/computer.js')).computerOauthConnect(connector, flags));
  const recipe = computer.command('recipe', ops).description('Saved signup and key-capture recipes: list, show, lint, compact, dry-run');
  recipe.command('list').description('List the saved recipes with their step counts and lint findings').action(async () => (await import('../commands/computer-recipes.js')).recipeList());
  recipe.command('show <host>').description("Show a host's recipe steps").action(async (host: string) => (await import('../commands/computer-recipes.js')).recipeShow(host));
  recipe.command('lint <host>').description('Flag repeated laps, consecutive duplicate clicks (toggles), a trailing click back to the start, and a missing capture step').action(async (host: string) => (await import('../commands/computer-recipes.js')).recipeLintCommand(host));
  recipe.command('compact <host>').description('Remove retry laps and toggle pairs, keeping the last successful sequence (the earlier file is kept as <host>.json.bak)').action(async (host: string) => (await import('../commands/computer-recipes.js')).recipeCompactCommand(host));
  recipe.command('dry-run <host>').description("Replay the recipe's selectors against the live page in the hidden browser and check every step's target exists, without submitting").action(async (host: string) => (await import('../commands/computer-recipes.js')).recipeDryRunCommand(host));
  computer.command('queue', ops).description('The vendor set-up queue (OAuth apps, API keys, test accounts): list it, filter with --status/--reason, record with --set <status> --vendor <name>')
    .option('--status <status>', 'Only this status').option('--reason <reason>', 'Only tasks waiting for this reason').option('--set <status>', 'Record a status for --vendor').option('--vendor <name>').option('--kind <kind>').option('--note <text>').option('--owner <email>')
    .action(async (options: { status?: string; reason?: string; set?: string; vendor?: string; kind?: string; note?: string; owner?: string }) => (await import('../commands/computer.js')).computerQueue(options));
}
