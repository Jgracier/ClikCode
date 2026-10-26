/**
 * The process-level pieces of the ClikCode program: the root command, the
 * global flags, crash capture and the error renderer.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { lifecycle, lifecycleProcess, setLifecycleRole } from '../runtime/lifecycle-log.js';
import { stateDirectory } from '../session/store/paths.js';
import { join } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { toCliErrorMessage, toCliErrorDebugDetails, toCliErrorJson } from './errors/message.js';
import { bindGlobalFlags, globalFlag, isJsonDefaultMode } from './output-mode.js';
import { emitResult } from './structured-output.js';
import { restoreTerminal } from '../tui/restore.js';
import { CLIKCODE_VERSION } from '../version.js';

/**
 * process.exit() runs synchronously right after this in both handlers below
 * -- an async fs write would very plausibly never flush before the process
 * actually dies, so this uses the sync fs API specifically, not fs/promises.
 * Never throws itself: a crash handler that can crash defeats its own point.
 */
/** A terminal that closed (EIO) or a reader that went away (EPIPE). The same
 * end as a hangup: nobody is left to read a stack, and crash.log is not
 * where it belongs. */
export function isClosedStream(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'EIO' || code === 'EPIPE';
}

function logCrashToDisk(kind: 'uncaughtException' | 'unhandledRejection', error: unknown): void {
  try {
    const dir = stateDirectory();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    appendFileSync(join(dir, 'crash.log'), `[${new Date().toISOString()}] ${kind} (pid ${process.pid}, ${process.argv.slice(2, 4).join(' ') || 'no command'}, clikcode ${CLIKCODE_VERSION})\n${detail}\n\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* fail-open-ok: a broken crash log must never block the actual crash handling below it. */ }
}

/** `--debug`, or CLIKCODE_DEBUG=1: a failure also prints the stack, HTTP
 * status and raw response body the friendly line collapses. */
function isDebugMode(): boolean {
  return globalFlag('debug') || ['1', 'true', 'yes'].includes(String(process.env.CLIKCODE_DEBUG || '').trim().toLowerCase());
}

/**
 * Render a command failure. JSON mode gets a machine-readable object; human mode
 * gets a friendly line, plus stack/HTTP status/response body under --debug.
 */
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
 * and the process-level error safety net.
 */
export function buildBaseProgram(): Command {
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
  const onCrash = (kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void => {
    // The stream 'error' listener below covers writes to stdout itself. A
    // write anywhere else (a socket, a pipe) with the same code still arrives
    // here, and used to be appended to crash.log: 195 of them were a closed
    // terminal. The window's worker keeps any turn running.
    if (isClosedStream(err)) {
      lifecycle('process.hangup', { code: (err as { code?: string }).code });
      process.exit(process.exitCode ?? 0);
    }
    restoreTerminal();
    logCrashToDisk(kind, err);
    handleCommandError(err);
    process.exit(process.exitCode || 1);
  };
  process.on('unhandledRejection', (err) => onCrash('unhandledRejection', err));
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (isClosedStream(error)) process.exit(process.exitCode ?? 0);
      throw error;
    });
  }
  process.on('uncaughtException', (err) => onCrash('uncaughtException', err));

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
    lifecycle('command.unknown', { command: program.args.join(' ').slice(0, 120) });
    process.exit(1);
  });

  // Always `node <script> args`: on VS Code's Electron (ELECTRON_RUN_AS_NODE,
  // the extension's fallback runtime) commander would otherwise read the
  // script path and command as arguments, and ClikCode could not start.
  program.parse(process.argv, { from: 'node' });
}
