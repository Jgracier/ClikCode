/**
 * spawns `connectors agent-mcp` -- but listed in --help only with CLIKCODE_OPS=1.
 */
import type { Command } from 'commander';
import { serveThenExit } from './stop-signal.js';

export function registerOperatorCommands(program: Command, computer: Command): void {
  const ops = { hidden: process.env.CLIKCODE_OPS !== '1' };
  computer.command('unattended [setting]', ops).description('on or off: park what needs you (a password, a code, an account choice) in the queue and go on, instead of asking (default off)').action(async (setting?: string) => (await import('../commands/computer.js')).computerUnattended(setting));
  computer.command('oauth-connect <connector>', ops).description("Connect a ClikDeploy connector: start its OAuth, press through the vendor's consent in the ClikCode browser (stops at a password, code or captcha), confirm it is active").action(async (connector: string) => (await import('../commands/computer.js')).computerOauthConnect(connector));
  connectors.command('run').description('Advance queued connectors without a model: connect test accounts through the consent driver, capture keys by saved recipes, call pipeline tools; hand unknown screens to an agent and record human-only walls')
    .option('--limit <n>', 'How many queued vendors to take (default 5, at most 25)')
    .option('--ids <ids>', 'Comma-separated connector ids instead of the next queued ones')
    .option('--parallel <n>', 'Vendors worked at once (default 1, at most 4; the browser still takes turns)')
    .option('--max-steps <n>', 'Most actions per vendor (default 12)')
    .option('--max-minutes <n>', 'Most minutes per vendor (default 5)')
    .option('--published', 'With --ids: connect only. Send each id straight to the consent driver, even when it is already published to users and developers (onboarding refuses those)')
    .option('--dry-run', 'Show the plan per vendor and change nothing')
    .option('--max-calls <n>', 'With --loop: most ClikDeploy calls per vendor (default 60)')
    .option('--agent-minutes <n>', 'With --loop: minutes one agent hand-off may take, on top of --max-minutes (default 20)')
    .option('--agent-calls <n>', 'With --loop: tool calls one agent hand-off may make (default 120)')
    .option('--max-hours <n>', 'With --loop: stop starting vendors after this many hours (default 8, at most 168)')
    .option('--cooldown-hours <n>', 'With --loop: hours before the same vendor is tried again (default 6; a wall holds 24)')
    .action(async (flags: import('../commands/connectors.js').ConnectorsRunFlags & import('../commands/connectors.js').ConnectorsLoopFlags & { loop?: boolean }) => {
      const commands = await import('../commands/connectors.js');
      if (!flags.loop) return commands.connectorsRun(flags);
      if (flags.ids || flags.dryRun || flags.published || flags.limit) throw new Error('--loop takes its vendors from the queue: leave out --ids, --limit, --published and --dry-run.');
      return commands.connectorsLoop(flags);
    });
    .action(async (flags: { lines?: string }) => (await import('../commands/connectors.js')).connectorsStatus(flags));
  connectors.command('qualify').description('Render each vendor\'s sign-up, pricing and developer pages (20 s a page, in its own named tab) and classify walls from the rendered text: JSON {id, lane auto|human|dead, kinds, evidence}')
    .option('--ids <a,b,c>', 'vendors to check').option('--next <n>', 'the next N vendors waiting for an agent').option('--parallel <n>', 'vendors at once, 1-4 (default 1)').option('--report', 'write the verdict into the work item note at ClikDeploy').option('--dump <dir>', 'save each rendered page\'s text there, to see what the verdict was read from')
    .action(async (flags: import('../commands/connectors.js').ConnectorsQualifyFlags) => (await import('../commands/connectors.js')).connectorsQualify(flags));
  connectors.command('agent-mcp', { hidden: true }).requiredOption('--tab <name>').requiredOption('--max-calls <n>').option('--counter <file>').option('--connector <id>')
    .action(async (flags: { tab: string; maxCalls: string; counter?: string; connector?: string }) => {
      await serveThenExit((signal) => agentMcpServe({ tab: flags.tab, ...(flags.connector ? { connector: flags.connector } : {}), maxCalls: Number(flags.maxCalls), ...(flags.counter ? { counter: flags.counter } : {}) }, signal));
    });
  connectors.command('resume <id>').description('Carry on with a connector whose keygrab could not finish: reattach to its parked hidden tab, optionally press one thing or go to one address, and continue getting the API key')
    .option('--click <text>', 'Press the control with this visible text first')
    .option('--goto <url>', 'Go to this https address in the parked tab first')
    .option('--only', 'Press or go, then show the page and stop (no keygrab): for a form that needs several plain presses')
    .option('--max-steps <n>', 'Most browser actions (default 60)')
    .option('--max-minutes <n>', 'Most minutes (default 4)')
    .action(async (id: string, flags: import('../commands/connectors.js').ConnectorsResumeFlags) => (await import('../commands/connectors.js')).connectorsResume(id, flags));
  const recipe = computer.command('recipe', ops).description('Saved signup and key-capture recipes: list, show, lint, compact, dry-run');
  recipe.command('list').description('List the saved recipes with their step counts and lint findings').action(async () => (await import('../commands/computer-recipes.js')).recipeList());
  recipe.command('show <host>').description("Show a host's recipe steps").action(async (host: string) => (await import('../commands/computer-recipes.js')).recipeShow(host));
  recipe.command('lint <host>').description('Flag repeated laps, consecutive duplicate clicks (toggles), a trailing click back to the start, and a missing capture step').action(async (host: string) => (await import('../commands/computer-recipes.js')).recipeLintCommand(host));
  recipe.command('compact <host>').description('Remove retry laps and toggle pairs, keeping the last successful sequence (the earlier file is kept as <host>.json.bak)').action(async (host: string) => (await import('../commands/computer-recipes.js')).recipeCompactCommand(host));
  recipe.command('dry-run <host>').description("Replay the recipe's selectors against the live page in the hidden browser and check every step's target exists, without submitting").action(async (host: string) => (await import('../commands/computer-recipes.js')).recipeDryRunCommand(host));
  computer.command('queue', ops).description('The vendor set-up queue (OAuth apps, API keys, test accounts): list it, filter with --status/--reason, record with --set <status> --vendor <name>')
    .option('--status <status>', 'Only this status').option('--reason <reason>', 'Only tasks waiting for this reason').option('--set <status>', 'Record a status for --vendor').option('--vendor <name>').option('--kind <kind>').option('--note <text>').option('--owner <email>').option('--import-ledger <file>', 'Load a vendor ledger JSON ({vendor: {ids, status, note}})')
    .action(async (options: { status?: string; reason?: string; set?: string; vendor?: string; kind?: string; note?: string; owner?: string; importLedger?: string }) => (await import('../commands/computer.js')).computerQueue(options));
  computer.command('proof <id>', ops).description('Read ClikDeploy’s current connector proof verdict and sync the local work queue')
    .action(async (id: string) => (await import('../commands/computer.js')).computerConnectorProof(id));
}
