/**
 * The parts of the CLI that both entrypoints — src/index.ts (public, → dist/)
 * and src/index-admin.ts (internal operator build, → dist-admin/) — must share.
 *
 * They previously carried 418 identical lines each, and had already drifted in a
 * way that mattered: index-admin's handleCommandError had lost the JSON-mode
 * branch and the --debug detail dump, so piping an admin command's failure
 * produced un-parseable prose while the public build produced JSON. Two copies
 * of a thing means one of them is wrong and nobody finds out; there is now one.
 *
 * This module deliberately contains NO admin imports, so it is safe on both
 * sides of the admin-wall documented in tsconfig.json.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import type Conf from 'conf';
import { CLI_API_URL_OVERRIDE_ENV, CONFIG_KEYS, normalizeApiUrl } from '../constants';
import { toCliErrorMessage, toCliErrorDebugDetails, toCliErrorJson } from '../utils/error-message';
import { isDebugMode } from '../utils/debug-mode';
import { isJsonDefaultMode } from '../utils/output-mode';
import { bindGlobalFlags } from '../utils/global-flags';
import { emitJson } from '../utils/structured-output';
import { acquireLifecycleLock, type LifecycleLock } from '../utils/lifecycle-lock';

export const CLI_VERSION: string = (() => {
  try {
    return String(require('../../package.json')?.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

export const BANNER = `
${chalk.cyan('╔═══════════════════════════════════════╗')}
${chalk.cyan('║')}  ${chalk.bold.white('⚡ ClikDeploy CLI')}               ${chalk.cyan('║')}
${chalk.cyan('║')}  ${chalk.gray('Deploy First, Configure Later')}      ${chalk.cyan('║')}
${chalk.cyan('╚═══════════════════════════════════════╝')}
`;

/**
 * Render a command failure. JSON mode gets a machine-readable object; human mode
 * gets a friendly line, plus stack/HTTP status/response body under --debug.
 */
export function handleCommandError(error: unknown): void {
  if (isJsonDefaultMode()) {
    emitJson(toCliErrorJson(error));
    process.exitCode = 1;
    return;
  }
  console.error(chalk.red(toCliErrorMessage(error)));
  if (isDebugMode()) {
    const details = toCliErrorDebugDetails(error);
    if (details) console.error(chalk.gray(details));
  }
  process.exitCode = 1;
}

function getCommandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current) {
    const n = current.name?.();
    if (n) names.unshift(n);
    current = current.parent ?? null;
  }
  return names.join(' ');
}

function isMutatingLifecycleCommand(commandPath: string): boolean {
  const normalized = commandPath.toLowerCase();
  return (
    normalized.includes(' delete') ||
    normalized.includes(' restart') ||
    normalized.includes(' start') ||
    normalized.includes(' stop') ||
    normalized.includes(' reconnect')
  );
}

/**
 * Build the root program: name/description/version, the four global options,
 * the banner + --local resolution preAction, the lifecycle-lock hooks, and the
 * process-level error safety net.
 */
export function buildBaseProgram(config: Conf): Command {
  const program = new Command();
  let activeLifecycleLock: LifecycleLock | null = null;

  process.on('unhandledRejection', (err) => {
    handleCommandError(err);
    process.exit(process.exitCode || 1);
  });
  process.on('uncaughtException', (err) => {
    handleCommandError(err);
    process.exit(process.exitCode || 1);
  });

  program
    .name('clikdeploy')
    .description('Deploy apps with one command - autonomous by default, simple by design')
    .version(CLI_VERSION)
    .option(
      '--local',
      'Use local platform URL for this command only (defaults to http://localhost:3000; override with CLIKDEPLOY_LOCAL_API_URL or `clikdeploy config localApiUrl <url>`)'
    )
    .option('--json', 'Render structured JSON output (default behavior; accepted for compatibility)')
    .option('--human', 'Render human-readable output (default is JSON)')
    .option(
      '--debug',
      'On failure, also print the stack, HTTP status and response body (or set CLIKDEPLOY_DEBUG=1)'
    )
    .hook('preAction', () => {
      // Hand commander's parse of --json/--human/--debug to the modules that
      // used to re-scan process.argv for them.
      const opts = program.opts();
      bindGlobalFlags({ json: opts.json, human: opts.human, debug: opts.debug });

      // Show banner on first use for human mode only.
      if (!config.get('seenBanner') && !isJsonDefaultMode()) {
        console.log(BANNER);
        config.set('seenBanner', true);
      }

      if (opts.local) {
        const localFromEnv = String(process.env.CLIKDEPLOY_LOCAL_API_URL || '').trim();
        const localFromConfig = String(config.get(CONFIG_KEYS.LOCAL_API_URL) || '').trim();
        process.env[CLI_API_URL_OVERRIDE_ENV] = normalizeApiUrl(
          localFromEnv || localFromConfig || 'http://localhost:3000'
        );
      } else {
        delete process.env[CLI_API_URL_OVERRIDE_ENV];
      }
    });

  program.hook('preAction', (_thisCommand, actionCommand) => {
    if (!isMutatingLifecycleCommand(getCommandPath(actionCommand))) return;
    if (activeLifecycleLock) return;
    activeLifecycleLock = acquireLifecycleLock('lifecycle');
  });

  program.hook('postAction', () => {
    if (!activeLifecycleLock) return;
    activeLifecycleLock.release();
    activeLifecycleLock = null;
  });

  process.on('exit', () => {
    if (activeLifecycleLock) activeLifecycleLock.release();
  });

  return program;
}

/**
 * Install the unknown-command handler, print help when invoked bare, and parse.
 * Call last, after every command is registered.
 */
export function runProgram(program: Command): void {
  program.on('command:*', () => {
    if (isJsonDefaultMode()) {
      emitJson({
        status: 'clarification_required',
        command: 'clikdeploy',
        reason: 'unknown_command',
        message: `Unknown command: ${program.args.join(' ')}`,
        options: { usage: 'clikdeploy --help' },
      });
    } else {
      console.error(chalk.red(`Unknown command: ${program.args.join(' ')}`));
      console.log();
      console.log('Run', chalk.cyan('clikdeploy --help'), 'for available commands');
    }
    process.exit(1);
  });

  if (!process.argv.slice(2).length) {
    console.log(BANNER);
    program.outputHelp();
  }

  program.parse();
}
