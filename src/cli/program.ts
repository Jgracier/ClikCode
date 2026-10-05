/**
 * The process-level pieces of the ClikCode program: the root command, the
 * global flags, the first-run banner, crash capture and the error renderer.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { lifecycleProcess, setLifecycleRole } from '../runtime/lifecycle-log.js';
import { stateDirectory } from '../session/store/paths.js';
import { join } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import type Conf from 'conf';
import { toCliErrorMessage, toCliErrorDebugDetails, toCliErrorJson } from './errors/message.js';
import { isDebugMode } from './debug-mode.js';
import { isJsonDefaultMode } from './output-mode.js';
import { bindGlobalFlags } from './flags.js';
import { emitResult } from './structured-output.js';
import { restoreTerminal } from '../tui/restore.js';
import { CLIKCODE_VERSION } from '../version.js';

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

const CLIKCODE_BANNER = bannerBox('⚡ ClikCode', 'Local-first AI coding runtime');

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
    const dir = stateDirectory();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    appendFileSync(join(dir, 'crash.log'), `[${new Date().toISOString()}] ${kind} (pid ${process.pid})\n${detail}\n\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* fail-open-ok: a broken crash log must never block the actual crash handling below it. */ }
}

export function handleCommandError(error: unknown): void {
  if (isJsonDefaultMode()) {
    emitResult(toCliErrorJson(error));
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


/**
 * Build the root program: name/description/version, the three global options,
 * the first-run banner, and the process-level error safety net.
 */
export function buildBaseProgram(config: Conf): Command {
  const program = new Command();
  // Every process says what it is, when it started and how it ended
  // (runtime/lifecycle-log.ts). A window names its conversation once open.
  const [command, argument] = process.argv.slice(2);
  if (command === 'session-worker') setLifecycleRole('worker', argument);
  else if (command === 'ide-bridge') setLifecycleRole('bridge');
  // Reading the log is not part of what it records.
  if (command !== 'logs') lifecycleProcess({ version: CLIKCODE_VERSION });

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
    .name('clikcode')
    .description('The terminal harness for all your AI coding providers')
    .version(CLIKCODE_VERSION)
    .option('--json', 'Write results as JSON, one record per line (the default when output is not a terminal)')
    .option('--human', 'Write results as readable text (the default in a terminal)')
    .option(
      '--debug',
      'On failure, also print the stack, HTTP status and response body'
    )
    .hook('preAction', () => {
      // Hand commander's parse of --json/--human/--debug to the modules that
      // used to re-scan process.argv for them.
      const opts = program.opts();
      bindGlobalFlags({ json: opts.json, human: opts.human, debug: opts.debug });

      // Show banner on first use for human mode only.
      if (!config.get('seenBanner') && !isJsonDefaultMode()) {
        console.log(CLIKCODE_BANNER);
        config.set('seenBanner', true);
      }
    });

  return program;
}

/**
 * Install the unknown-command handler and parse. Call last, after every
 * command is registered. Invoked bare, the root action runs (it opens a chat).
 */
export function runProgram(program: Command): void {
  const name = program.name();
  program.on('command:*', () => {
    if (isJsonDefaultMode()) {
      emitResult({
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

  // Always `node <script> args`: on VS Code's Electron (ELECTRON_RUN_AS_NODE,
  // the extension's fallback runtime) commander would otherwise read the
  // script path and command as arguments, and ClikCode could not start.
  program.parse(process.argv, { from: 'node' });
}
