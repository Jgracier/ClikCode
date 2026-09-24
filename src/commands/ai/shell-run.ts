/** `!command` in the composer: run a shell command the way the user would
 * have run it themselves -- no model in between, no approval gate, the same
 * working directory and environment -- and carry its output into the
 * conversation so the next request can build on it.
 *
 * The command is the user's own keystroke, so nothing here redacts or asks
 * permission: exactly as if they had typed it at a normal prompt. What IS
 * ClikCode's concern is that the output is durable and delivered: the note is
 * written into the session transcript, and re-injected into the NEXT turn the
 * same way an attachment is (see shellContextBlock and drive.ts), because a
 * resumed native session never replays ClikCode's own transcript.
 */

import { existsSync } from 'node:fs';
import { killProcessTreePortable, spawnPortable } from '../../harness/transport/spawn.js';

export interface ShellNote {
  command: string;
  output: string;
  exitCode: number | null;
  at: string;
}

export interface ShellRunResult {
  command: string;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Output is capped to something a prompt can hold; the rest is noted, not
 * dropped from the terminal -- the scrollback the command just wrote is still
 * there, and the note names the fact that the context was truncated. */
export const SHELL_OUTPUT_MAX_BYTES = 8000;
const SHELL_TIMEOUT_MS = 120_000;
export const SHELL_KILL_GRACE_MS = 1500;

export function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  return { file: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-c', command] };
}

/** Head and tail of an over-long output, with an honest count in between. */
function cappedOutput(text: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= SHELL_OUTPUT_MAX_BYTES) return text;
  const half = Math.floor(SHELL_OUTPUT_MAX_BYTES / 2);
  return `${text.slice(0, half)}\n\n… [${bytes - half * 2} bytes of output truncated; the full output is in your terminal scrollback] …\n\n${text.slice(-half)}`.trimEnd();
}

/** Run a command with the caller's own environment in the given workspace,
 * killing the whole process group on timeout or cancel. Cancellation via
 * `signal` (the composer's Escape) stops the tree, so a `!sleep 999` cannot
 * outlive the keystroke that dismissed it. */
export function runShellCommand(command: string, cwd: string, signal?: AbortSignal): Promise<ShellRunResult> {
  const detached = process.platform !== 'win32';
  const { file, args } = shellInvocation(command);
  return new Promise((resolve) => {
    const child = spawnPortable(file, args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached, windowsHide: true });
    let combined = '';
    const onData = (chunk: string): void => { if (Buffer.byteLength(combined, 'utf8') < SHELL_OUTPUT_MAX_BYTES * 2) combined += chunk; };
    let timedOut = false;
    const killTree = (): void => {
      killProcessTreePortable(child, 'SIGTERM', detached);
      const timer = setTimeout(() => {
        if (detached && process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* group already gone */ }
        }
        killProcessTreePortable(child, 'SIGKILL', detached);
      }, SHELL_KILL_GRACE_MS);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, SHELL_TIMEOUT_MS);
    const abort = (): void => killTree();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    child.stdout!.setEncoding('utf8').on('data', onData);
    child.stderr!.setEncoding('utf8').on('data', onData);
    const cleanup = (): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      cleanup();
      resolve({ command, output: `[failed to start: ${error.message}]`, exitCode: null, timedOut: false });
    });
    child.once('close', (code) => {
      cleanup();
      resolve({ command, output: cappedOutput(combined.replace(/\s+$/, '')), exitCode: code, timedOut });
    });
  });
}

/** The line a composer-level `!` detection checks once, shared by the
 * interactive loop, the waiting composer, and the queue so the three cannot
 * drift. A bare `!` counts: it cannot be escaped yet, and routing it as
 * conversation would teach no one anything -- better that it is a command
 * whose empty argument says what it wanted. */
export function isShellCommandLine(line: string): boolean {
  return line.trim().startsWith('!');
}

/** What the run becomes as a transcript message: the command as the word the
 * user typed, then what it printed, then how it ended. */
export function shellMessageContent(note: ShellNote): string {
  const status = note.exitCode === 0 ? 'exit 0'
    : note.exitCode !== null ? `exit ${note.exitCode}`
    : 'stopped';
  return `!${note.command}\n\n${note.output || '(no output)'}\n\n${status}`;
}

/** The re-injection block for the next turn, mirroring the attachment
 * envelope so the model can tell generated material from user words. Empty
 * when there is nothing to deliver. */
export function shellContextBlock(notes: readonly ShellNote[]): string {
  if (!notes.length) return '';
  const blocks = notes.map((note) => {
    const command = note.command.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const exit = note.exitCode === 0 ? '0' : note.exitCode === null ? 'killed' : String(note.exitCode);
    return `<clikcode_shell_command command="${command}" exit="${exit}">\n${note.output}\n</clikcode_shell_command>`;
  });
  return `\n\n${blocks.join('\n\n')}`;
}