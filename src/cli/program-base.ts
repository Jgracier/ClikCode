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

import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import type Conf from 'conf';
import { CLI_API_URL_OVERRIDE_ENV, CONFIG_KEYS, normalizeApiUrl } from '../constants.js';
import { toCliErrorMessage, toCliErrorDebugDetails, toCliErrorJson } from '../utils/error-message.js';
import { isDebugMode } from '../utils/debug-mode.js';
import { isJsonDefaultMode } from '../utils/output-mode.js';
import { bindGlobalFlags } from '../utils/global-flags.js';
import { emitJson } from '../utils/structured-output.js';
import type { LifecycleLock } from '../utils/lifecycle-lock.js';
import { restoreTerminal } from '../commands/terminal-restore.js';

export const CLI_VERSION: string = (() => {
  try {
    // ESM build (package.json "type": "module"): there is no `require` at
    // runtime. createRequire gives us the same relative-to-this-module lookup,
    // and it resolves identically from src/cli/ and dist/cli/ since the
    // package.json sits two levels up in both layouts.
    const requireFromHere = createRequire(import.meta.url);
    return String(requireFromHere('../../package.json')?.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

/** Rows are padded by measured cell width, not typed by hand: the lightning
 * bolt is two cells wide, and the hand-spaced version left the right border
 * two to five columns short of the corners. Default foreground + bold and dim
 * are used instead of white/gray, which vanish on light and Solarized themes. */
function bannerBox(title: string, tagline: string): string {
  const inner = 39;
  const cells = (text: string): number => [...text].reduce((total, character) => total + (/\p{Emoji_Presentation}/u.test(character) ? 2 : 1), 0);
  const row = (text: string, style: (value: string) => string): string =>
    `${chalk.cyan('║')}  ${style(text)}${' '.repeat(Math.max(0, inner - 2 - cells(text)))}${chalk.cyan('║')}`;
  return `
${chalk.cyan(`╔${'═'.repeat(inner)}╗`)}
${row(title, chalk.bold)}
${row(tagline, chalk.dim)}
${chalk.cyan(`╚${'═'.repeat(inner)}╝`)}
`;
}

export const BANNER = bannerBox('⚡ ClikDeploy CLI', 'Deploy First, Configure Later');

/** ClikCode is a free-standing product bundled in the same package for
 * distribution only; its first-run banner must say so, not show ClikDeploy's
 * deployment-platform branding. */
export const CLIKCODE_BANNER = bannerBox('⚡ ClikCode', 'Local-first AI coding runtime');

/**
 * Render a command failure. JSON mode gets a machine-readable object; human mode
 * gets a friendly line, plus stack/HTTP status/response body under --debug.
 */
/**
 * process.exit() runs synchronously right after this in both handlers below
 * -- an async fs write would very plausibly never flush before the process
 * actually dies, so this uses the sync fs API specifically, not fs/promises.
 * Never throws itself: a crash handler that can crash defeats its own point.
 */
function logCrashToDisk(kind: 'uncaughtException' | 'unhandledRejection', error: unknown): void {
  try {
    const dir = join(homedir(), '.clikcode');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    appendFileSync(join(dir, 'crash.log'), `[${new Date().toISOString()}] ${kind} (pid ${process.pid})\n${detail}\n\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* fail-open-ok: a broken crash log must never block the actual crash handling below it. */ }
}

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
export function buildBaseProgram(config: Conf, options: { lifecycleLock?: boolean; banner?: string; standaloneClikCode?: boolean; version?: string } = {}): Command {
  const program = new Command();
  const banner = options.banner ?? BANNER;
  let activeLifecycleLock: LifecycleLock | null = null;

  // Restore the terminal FIRST. The ClikCode UI runs in raw mode with the
  // cursor hidden, autowrap off and bracketed paste on; an error printed into
  // that state is unreadable and the shell it returns to is unusable. A no-op
  // when no terminal UI was ever started.
  process.on('unhandledRejection', (err) => {
    restoreTerminal();
    logCrashToDisk('unhandledRejection', err);
    handleCommandError(err);
    process.exit(process.exitCode || 1);
  });
  process.on('uncaughtException', (err) => {
    restoreTerminal();
    logCrashToDisk('uncaughtException', err);
    handleCommandError(err);
    process.exit(process.exitCode || 1);
  });

  program
    .name('clikdeploy')
    .description('Deploy apps with one command - autonomous by default, simple by design')
    .version(options.version ?? CLI_VERSION)
    .option('--json', 'Render structured JSON output (default behavior; accepted for compatibility)')
    .option('--human', 'Render human-readable output (default is JSON)')
    .option(
      '--debug',
      `On failure, also print the stack, HTTP status and response body${options.standaloneClikCode ? '' : ' (or set CLIKDEPLOY_DEBUG=1)'}`
    )
    .hook('preAction', () => {
      // Hand commander's parse of --json/--human/--debug to the modules that
      // used to re-scan process.argv for them.
      const opts = program.opts();
      bindGlobalFlags({ json: opts.json, human: opts.human, debug: opts.debug });

      // Show banner on first use for human mode only.
      if (!config.get('seenBanner') && !isJsonDefaultMode()) {
        console.log(banner);
        config.set('seenBanner', true);
      }

      // One-off URL override is `CLIKDEPLOY_API_URL` (see #495). `--local` is
      // the localhost shorthand. `--api-url` is not a registered global flag.
      if (!options.standaloneClikCode && opts.local) {
        const localFromEnv = String(process.env.CLIKDEPLOY_LOCAL_API_URL || '').trim();
        const localFromConfig = String(config.get(CONFIG_KEYS.LOCAL_API_URL) || '').trim();
        process.env[CLI_API_URL_OVERRIDE_ENV] = normalizeApiUrl(
          localFromEnv || localFromConfig || 'http://localhost:3000'
        );
      } else {
        delete process.env[CLI_API_URL_OVERRIDE_ENV];
      }
    });

  if (!options.standaloneClikCode) {
    program.option(
      '--local',
      'Use local platform URL for this command only (defaults to http://localhost:3000; override with CLIKDEPLOY_LOCAL_API_URL or `clikdeploy config localApiUrl <url>`)'
    );
  }

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    if (options.lifecycleLock === false) return;
    if (!isMutatingLifecycleCommand(getCommandPath(actionCommand))) return;
    if (activeLifecycleLock) return;
    // Loaded on demand: entrypoints that opt out (ClikCode) never evaluate the
    // module, and apps/clikcode/scripts/build.mjs stubs it out of that bundle.
    // Commander chains a promise-returning hook ahead of the action.
    const { acquireLifecycleLock } = await import('../utils/lifecycle-lock.js');
    activeLifecycleLock = acquireLifecycleLock('lifecycle');
  });

  program.hook('postAction', () => {
    if (options.lifecycleLock === false) return;
    if (!activeLifecycleLock) return;
    activeLifecycleLock.release();
    activeLifecycleLock = null;
  });

  process.on('exit', () => {
    if (options.lifecycleLock === false) return;
    if (activeLifecycleLock) activeLifecycleLock.release();
  });

  return program;
}

/**
 * Install the unknown-command handler, print help when invoked bare, and parse.
 * Call last, after every command is registered.
 */
export function runProgram(program: Command, options: { showHelpWhenBare?: boolean; banner?: string } = {}): void {
  const name = program.name();
  program.on('command:*', () => {
    if (isJsonDefaultMode()) {
      emitJson({
        status: 'clarification_required',
        command: name,
        reason: 'unknown_command',
        message: `Unknown command: ${program.args.join(' ')}`,
        options: { usage: `${name} --help` },
      });
    } else {
      console.error(chalk.red(`Unknown command: ${program.args.join(' ')}`));
      console.log();
      console.log('Run', chalk.cyan(`${name} --help`), 'for available commands');
    }
    process.exit(1);
  });

  if (!process.argv.slice(2).length && options.showHelpWhenBare !== false) {
    console.log(options.banner ?? BANNER);
    program.outputHelp();
  }

  program.parse();
}
