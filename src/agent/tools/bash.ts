/** Shell execution. Every command runs in its own process group so a timeout
 * or a cancelled turn takes the whole tree down, not just the shell. */
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { killProcessTreePortable, spawnPortable } from '../../harness/transport/spawn.js';
import { classifyCommand } from '../command-classifier.js';
import { OUTPUT_CAPS, redactSecrets, scrubEnvironment, toolOutputDir } from '../security.js';
import { queueShellNotification, type BackgroundShell } from '../session-state.js';
import { turnCancelledError } from '../cancellation.js';
import { defineTool, type ToolContext, type ToolRunResult } from '../tool-contract.js';
import { scopeOf } from './fs-helpers.js';
import { formatToolRow } from '../../harness/protocol/tools.js';
import { sandboxCommand, sandboxDenialHint, sandboxMissingNotice } from '../sandbox.js';

interface BashArgs { command: string; timeout_ms?: number; run_in_background?: boolean; description?: string; sandbox?: boolean }

const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 1500;
const BACKGROUND_BUFFER_CHARS = 1024 * 1024;
/** How much unread output an exit notification carries; the rest stays for bash_output. */
const NOTIFICATION_TAIL_CHARS = 2000;

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  return { file: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-c', command] };
}

/** The shell invocation, inside the session's sandbox when it has one on
 * and the model did not ask to run this command without it (`sandbox:
 * false`, which the permission layer has already let through). `notice` is
 * the once-a-session line saying no sandbox is installed. */
function sandboxedInvocation(args: BashArgs, ctx: ToolContext): { file: string; args: string[]; sandboxed: boolean; writable: string[]; notice?: string } {
  const shell = shellInvocation(args.command);
  if (ctx.sandbox !== 'workspace' || args.sandbox === false) return { ...shell, sandboxed: false, writable: [] };
  const wrapped = sandboxCommand(ctx.sandbox, shell, { cwd: ctx.cwd, addDirs: ctx.addDirs, homeDir: ctx.homeDir });
  let notice: string | undefined;
  if (!wrapped.sandboxed && wrapped.missing && !ctx.session.sandboxNoticeShown) {
    ctx.session.sandboxNoticeShown = true;
    notice = sandboxMissingNotice(wrapped.missing);
  }
  return { ...wrapped.invocation, sandboxed: wrapped.sandboxed, writable: wrapped.writable, ...(notice ? { notice } : {}) };
}

function shellEnvironment(): Record<string, string> {
  return { ...scrubEnvironment(process.env), CLIKCODE: '1', TERM: 'dumb', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' };
}

const NOTE_ROOM = 512;

/** Head + rolling tail in memory, everything on disk once the cap is passed. */
class CappedOutput {
  private head = '';
  private tail = '';
  private spill?: WriteStream;
  private spilled = 0;
  total = 0;
  spillPath?: string;

  constructor(private readonly spillTarget: string, private readonly cap: number = OUTPUT_CAPS.toolOutputBytes) {}

  async push(chunk: string): Promise<void> {
    this.total += Buffer.byteLength(chunk);
    // Head and tail leave room for the note naming the spill file: at the full
    // cap, the loop's own cap would cut that note out of the middle.
    const half = Math.floor((this.cap - NOTE_ROOM) / 2);
    if (!this.spill && this.total > this.cap - NOTE_ROOM) {
      await fs.mkdir(path.dirname(this.spillTarget), { recursive: true, mode: 0o700 });
      this.spill = createWriteStream(this.spillTarget, { mode: 0o600 });
      this.spill.on('error', () => undefined);
      this.spillPath = this.spillTarget;
      this.write(this.head + this.tail);
    }
    if (this.spill) this.write(chunk);
    let rest = chunk;
    if (this.head.length < half) {
      const take = rest.slice(0, half - this.head.length);
      this.head += take;
      rest = rest.slice(take.length);
    }
    if (rest) this.tail = (this.tail + rest).slice(-half);
  }

  private write(text: string): void {
    if (this.spilled > OUTPUT_CAPS.spillFileBytes) return;
    this.spilled += text.length;
    this.spill?.write(text);
  }

  async finish(): Promise<string> {
    if (this.spill) await new Promise<void>((resolve) => this.spill!.end(resolve));
    if (!this.spillPath) return this.head + this.tail;
    const dropped = Math.max(0, this.total - Buffer.byteLength(this.head) - Buffer.byteLength(this.tail));
    return `${this.head}\n\n… [${dropped} bytes truncated; full output saved to ${this.spillPath} — read it with read_file or grep] …\n\n${this.tail}`;
  }
}

/** SIGTERM the group, then SIGKILL it. The escalation signals the GROUP
 * directly: killProcessTreePortable stops once the shell itself has exited,
 * but a grandchild that ignored SIGTERM is still holding the pipes open. */
function killTree(child: BackgroundShell['child'], detached: boolean): void {
  killProcessTreePortable(child, 'SIGTERM', detached);
  const timer = setTimeout(() => {
    if (detached && process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* group already gone */ }
    }
    killProcessTreePortable(child, 'SIGKILL', detached);
  }, KILL_GRACE_MS);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

/** Stop a background shell for a reason the model did not give: its close
 * handler then tells the model why (see startBackground). */
export function stopBackgroundShell(shell: BackgroundShell, reason: string): void {
  if (shell.status !== 'running') return;
  shell.killReason = reason;
  killTree(shell.child, shell.detached);
}

function startBackground(args: BashArgs, ctx: ToolContext): { output: string } {
  const detached = process.platform !== 'win32';
  const { file, args: argv, notice } = sandboxedInvocation(args, ctx);
  // stdin is a pipe so bash_input can answer a prompt or drive a REPL. A
  // foreground command keeps 'ignore': nothing could ever type into it.
  const child = spawnPortable(file, argv, { cwd: ctx.cwd, env: shellEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], detached, windowsHide: true });
  // A write after the process exits is EPIPE; bash_input reports the exit instead.
  child.stdin?.on('error', () => undefined);
  const id = `bash_${ctx.session.nextShellNumber++}`;
  const shell: BackgroundShell = { id, command: args.command, child, detached, unread: '', droppedBytes: 0, status: 'running', startedAt: Date.now() };
  const onData = (chunk: string): void => {
    const combined = shell.unread + chunk;
    if (combined.length > BACKGROUND_BUFFER_CHARS) shell.droppedBytes += combined.length - BACKGROUND_BUFFER_CHARS;
    shell.unread = combined.slice(-BACKGROUND_BUFFER_CHARS);
  };
  child.stdout!.setEncoding('utf8').on('data', onData);
  child.stderr!.setEncoding('utf8').on('data', onData);
  child.once('error', (error) => { onData(`\n[failed to start: ${error.message}]`); if (shell.status === 'running') shell.status = 'exited'; });
  child.once('close', (code, signal) => {
    // The model stopped it with kill_bash and already knows. Anything else --
    // it finished, it crashed, the worker's ceiling stopped it -- is news.
    const tell = shell.status === 'running' || shell.killReason !== undefined;
    if (shell.status === 'running') shell.status = 'exited';
    shell.exitCode = code;
    shell.signal = signal;
    if (!tell) return;
    const unread = shell.unread.length > NOTIFICATION_TAIL_CHARS ? `… ${shell.unread.slice(-NOTIFICATION_TAIL_CHARS)}` : shell.unread;
    queueShellNotification(ctx.session, {
      shellId: id, command: args.command, exitCode: code, signal, tail: redactSecrets(unread),
      ...(shell.killReason ? { reason: shell.killReason } : {}), at: Date.now(),
    });
  });
  ctx.session.shells.set(id, shell);
  return { output: `${notice ? `${notice}\n` : ''}Started background shell ${id}. You will be told when it exits, with the end of its output: do not poll it or sleep waiting for it. Carry on with other work, end your turn if there is nothing else to do, or use wait (shell_ids ["${id}"]) to continue in this turn once it exits. bash_output (id "${id}") reads its output so far; bash_input types into it; kill_bash stops it.` };
}

export const bashTool = defineTool<BashArgs>({
  name: 'bash',
  class: 'exec',
  description: 'Run a shell command in the working directory and return its combined stdout/stderr and exit code. Default timeout 120s (max 600s via timeout_ms). Use run_in_background for servers, watchers and long jobs: you are notified automatically when a background shell exits, so never poll it or sleep waiting for it -- end your turn instead if nothing else is left to do, and the exit arrives as a new message; to continue in the same turn once it exits, use wait. Do not use it to read, search or edit files — use read_file, grep, glob and edit_file. Foreground commands get no input: never start editors there. A command that prompts or a REPL runs with run_in_background, and bash_input types into it. Commands run sandboxed by default: they read everything and keep the network, but write only the workspace, the temp dir and tool caches; set sandbox: false only when a command genuinely must write elsewhere (a global install, ~/.config, another repo), and it then runs under the usual permission mode.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['command'],
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      description: { type: 'string', description: 'A few words saying what the command does.' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: BASH_MAX_TIMEOUT_MS },
      run_in_background: { type: 'boolean' },
      sandbox: { type: 'boolean', description: 'false runs this one command outside the workspace sandbox. Omit it otherwise.' },
    },
  },
  label: (args) => formatToolRow('bash', args.command, 'run'),
  async run(args, ctx) {
    // Held here as well as in the permission layer: a hard-denied command
    // must never execute, however this tool was reached.
    const tier = classifyCommand(args.command, scopeOf(ctx));
    if (tier.tier === 'deny') return { output: `Refused: ${tier.reason}. This command is never run.`, isError: true };
    if (ctx.signal?.aborted) throw turnCancelledError();
    if (args.run_in_background) return startBackground(args, ctx);

    const timeoutMs = Math.min(Math.max(args.timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS, 1), BASH_MAX_TIMEOUT_MS);
    const callName = (ctx.callId ?? `call-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '_');
    const invocation = sandboxedInvocation(args, ctx);
    const result = await runForeground(invocation, timeoutMs, path.join(toolOutputDir(ctx.stateDir, ctx.sessionId), `${callName}.log`), ctx);
    const hint = invocation.sandboxed && result.isError && !result.timedOut ? sandboxDenialHint(result.output, invocation.writable) : undefined;
    return withNote(withNote(result, invocation.notice), hint, 'after');
  },
});

function withNote({ timedOut: _timedOut, ...result }: ToolRunResult & { timedOut?: boolean }, note: string | undefined, where: 'before' | 'after' = 'before'): ToolRunResult {
  if (!note) return result;
  return { ...result, output: where === 'before' ? `${note}\n${result.output}` : `${result.output}\n${note}` };
}

function runForeground(invocation: { file: string; args: string[] }, timeoutMs: number, spillTarget: string, ctx: ToolContext): Promise<ToolRunResult & { timedOut?: boolean }> {
  const detached = process.platform !== 'win32';
  const output = new CappedOutput(spillTarget, ctx.outputCap);
  return new Promise((resolve, reject) => {
    const child = spawnPortable(invocation.file, invocation.args, { cwd: ctx.cwd, env: shellEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached, windowsHide: true });
    let timedOut = false;
    let pending: Promise<void> = Promise.resolve();
    const onData = (chunk: string): void => {
      pending = pending.then(() => output.push(chunk)).catch(() => undefined);
      try { ctx.emitOutput?.(chunk); } catch { /* a UI fault must not break the command */ }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child, detached); }, timeoutMs);
    const abort = (): void => killTree(child, detached);
    ctx.signal?.addEventListener('abort', abort, { once: true });
    child.stdout!.setEncoding('utf8').on('data', onData);
    child.stderr!.setEncoding('utf8').on('data', onData);
    const cleanup = (): void => { clearTimeout(timer); ctx.signal?.removeEventListener('abort', abort); };
    child.once('error', (error) => { cleanup(); resolve({ output: `Failed to start the shell: ${error.message}`, isError: true }); });
    child.once('close', (code, signal) => {
      cleanup();
      void pending.then(() => output.finish()).then((text) => {
        if (ctx.signal?.aborted) return reject(turnCancelledError());
        const body = redactSecrets(text).replace(/\s+$/, '');
        if (timedOut) return resolve({ output: `${body}\n\n[timed out after ${Math.round(timeoutMs / 1000)}s; the process group was killed. For long-running work use run_in_background.]`.trim(), isError: true, timedOut: true });
        const status = code === 0 ? '' : `\n\n[exit code ${code ?? `signal ${signal}`}]`;
        resolve({ output: `${body || '(no output)'}${status}`, isError: code !== 0, ...(code !== null ? { exitCode: code } : {}) });
      }, reject);
    });
  });
}

interface ShellIdArgs { id: string }

export const bashOutputTool = defineTool<ShellIdArgs>({
  name: 'bash_output',
  class: 'read',
  description: 'Return new output from a background shell since the last check, plus whether it is still running.',
  parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: 'Background shell id, e.g. bash_1.' } } },
  label: (args) => `Output of ${args.id}`,
  async run(args, ctx) {
    const shell = ctx.session.shells.get(args.id);
    if (!shell) return unknownShell(args.id, ctx);
    return { output: drainShell(shell) };
  },
});

function unknownShell(id: string, ctx: ToolContext): { output: string; isError: true } {
  return { output: `No background shell "${id}". Known: ${[...ctx.session.shells.keys()].join(', ') || 'none'}.`, isError: true };
}

/** Hand the model everything the shell printed since the last read. */
function drainShell(shell: BackgroundShell): string {
  const text = shell.unread;
  const dropped = shell.droppedBytes;
  shell.unread = '';
  shell.droppedBytes = 0;
  const status = shell.status === 'running' ? 'running' : `${shell.status}${shell.exitCode !== undefined && shell.exitCode !== null ? ` (exit code ${shell.exitCode})` : shell.signal ? ` (${shell.signal})` : ''}`;
  const half = Math.floor(OUTPUT_CAPS.toolOutputBytes / 2);
  const body = redactSecrets(text.length > OUTPUT_CAPS.toolOutputBytes ? `${text.slice(0, half)}\n… [${text.length - half * 2} characters truncated] …\n${text.slice(-half)}` : text);
  return `[${shell.id}: ${status}]${dropped ? ` [${dropped} earlier characters dropped]` : ''}\n${body || '(no new output)'}`;
}

interface BashInputArgs { id: string; text?: string; newline?: boolean; close?: boolean; wait_ms?: number }

const INPUT_DEFAULT_WAIT_MS = 2000;
const INPUT_MAX_WAIT_MS = 30_000;
/** Output that has stopped growing for this long is taken as the whole reply. */
const INPUT_QUIET_MS = 300;
const INPUT_POLL_MS = 50;

/** Until the shell exits, its reply goes quiet, or the wait is up -- whichever
 * comes first. */
async function settle(shell: BackgroundShell, waitMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + waitMs;
  let seen = shell.unread.length;
  let changedAt: number | undefined;
  while (Date.now() < deadline && shell.status === 'running' && !signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, INPUT_POLL_MS));
    const now = shell.unread.length;
    if (now !== seen) { seen = now; changedAt = Date.now(); continue; }
    if (changedAt !== undefined && Date.now() - changedAt >= INPUT_QUIET_MS) return;
  }
}

export const bashInputTool = defineTool<BashInputArgs>({
  name: 'bash_input',
  class: 'exec',
  description: 'Type into a background shell started with bash run_in_background: write text to its stdin (a newline is added unless newline is false), then return its new output once it settles. Use it to answer a prompt or drive a REPL. close: true closes stdin (end of input, like Ctrl+D) after writing any text. stdin is a pipe, not a terminal: a program that insists on a TTY may not prompt.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['id'],
    properties: {
      id: { type: 'string', description: 'Background shell id, e.g. bash_1.' },
      text: { type: 'string', description: 'What to type.' },
      newline: { type: 'boolean', description: 'Add a trailing newline (default true).' },
      close: { type: 'boolean', description: 'Close stdin after writing (end of input).' },
      wait_ms: { type: 'integer', minimum: 0, maximum: INPUT_MAX_WAIT_MS, description: `How long to wait for a reply (default ${INPUT_DEFAULT_WAIT_MS}).` },
    },
  },
  label: (args) => `Input to ${args.id}`,
  async describe(args) {
    return [`types into ${args.id}: ${JSON.stringify(typedText(args))}`, ...(args.close ? ['then closes its stdin'] : [])].join('\n');
  },
  async run(args, ctx) {
    const shell = ctx.session.shells.get(args.id);
    if (!shell) return unknownShell(args.id, ctx);
    const stdin = shell.child.stdin;
    if (shell.status !== 'running') return { output: `${args.id} is not running, so it takes no input.\n${drainShell(shell)}`, isError: true };
    if (!stdin || stdin.destroyed || stdin.writableEnded) return { output: `${args.id}'s stdin is already closed.\n${drainShell(shell)}`, isError: true };
    const text = typedText(args);
    if (!text && !args.close) return { output: 'Nothing to send: give text, or close: true.', isError: true };
    if (text) await new Promise<void>((resolve) => { stdin.write(text, () => resolve()); });
    if (args.close) stdin.end();
    await settle(shell, Math.min(Math.max(args.wait_ms ?? INPUT_DEFAULT_WAIT_MS, 0), INPUT_MAX_WAIT_MS), ctx.signal);
    if (ctx.signal?.aborted) throw turnCancelledError();
    return { output: drainShell(shell) };
  },
});

function typedText(args: BashInputArgs): string {
  if (args.text === undefined) return '';
  return args.newline === false ? args.text : `${args.text}\n`;
}

export const killBashTool = defineTool<ShellIdArgs>({
  name: 'kill_bash',
  class: 'meta',
  description: 'Stop a background shell started with bash run_in_background.',
  parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
  label: (args) => `Kill ${args.id}`,
  async run(args, ctx) {
    const shell = ctx.session.shells.get(args.id);
    if (!shell) return { output: `No background shell "${args.id}".`, isError: true };
    if (shell.status !== 'running') return { output: `${args.id} already ${shell.status}.` };
    shell.status = 'killed';
    killTree(shell.child, shell.detached);
    return { output: `Stopped ${args.id}.` };
  },
});
