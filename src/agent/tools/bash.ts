/** Shell execution. Every command runs in its own process group so a timeout
 * or a cancelled turn takes the whole tree down, not just the shell. */
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { killProcessTreePortable, spawnPortable } from '../../harness/transport/spawn.js';
import { classifyCommand, OUTPUT_CAPS, redactSecrets, scrubEnvironment, toolOutputDir } from '../security.js';
import type { BackgroundShell } from '../session-state.js';
import { defineTool, turnCancelledError, type ToolContext } from '../types.js';
import { scopeOf } from './fs-helpers.js';

interface BashArgs { command: string; timeout_ms?: number; run_in_background?: boolean; description?: string }

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 1500;
const BACKGROUND_BUFFER_CHARS = 1024 * 1024;

export function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  return { file: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-c', command] };
}

export function shellEnvironment(): Record<string, string> {
  return { ...scrubEnvironment(process.env), CLIKCODE: '1', TERM: 'dumb', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' };
}

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
    const half = Math.floor(this.cap / 2);
    if (!this.spill && this.total > this.cap) {
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
export function killTree(child: BackgroundShell['child'], detached: boolean): void {
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

function startBackground(args: BashArgs, ctx: ToolContext): { output: string } {
  const detached = process.platform !== 'win32';
  const { file, args: argv } = shellInvocation(args.command);
  const child = spawnPortable(file, argv, { cwd: ctx.cwd, env: shellEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached, windowsHide: true });
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
  child.once('close', (code, signal) => { if (shell.status === 'running') shell.status = 'exited'; shell.exitCode = code; shell.signal = signal; });
  ctx.session.shells.set(id, shell);
  return { output: `Started background shell ${id}. Check it with bash_output (id "${id}") and stop it with kill_bash.` };
}

export const bashTool = defineTool<BashArgs>({
  name: 'bash',
  class: 'exec',
  description: 'Run a shell command in the working directory and return its combined stdout/stderr and exit code. Default timeout 120s (max 600s via timeout_ms). Use run_in_background for servers and watchers, then poll with bash_output. Do not use it to read, search or edit files — use read_file, grep, glob and edit_file. Commands are non-interactive: never start editors or prompts.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['command'],
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      description: { type: 'string', description: 'A few words saying what the command does.' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: BASH_MAX_TIMEOUT_MS },
      run_in_background: { type: 'boolean' },
    },
  },
  label: (args) => args.command.length > 120 ? `${args.command.slice(0, 117)}…` : args.command,
  async run(args, ctx) {
    // Held here as well as in the permission layer: a hard-denied command
    // must never execute, however this tool was reached.
    const tier = classifyCommand(args.command, scopeOf(ctx));
    if (tier.tier === 'deny') return { output: `Refused: ${tier.reason}. This command is never run.`, isError: true };
    if (ctx.signal?.aborted) throw turnCancelledError();
    if (args.run_in_background) return startBackground(args, ctx);

    const timeoutMs = Math.min(Math.max(args.timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS, 1), BASH_MAX_TIMEOUT_MS);
    const detached = process.platform !== 'win32';
    const { file, args: argv } = shellInvocation(args.command);
    const spillTarget = path.join(toolOutputDir(ctx.stateDir, ctx.sessionId), `${(ctx.callId ?? `call-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
    const output = new CappedOutput(spillTarget);
    return new Promise((resolve, reject) => {
      const child = spawnPortable(file, argv, { cwd: ctx.cwd, env: shellEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached, windowsHide: true });
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
          if (timedOut) return resolve({ output: `${body}\n\n[timed out after ${Math.round(timeoutMs / 1000)}s; the process group was killed. For long-running work use run_in_background.]`.trim(), isError: true });
          const status = code === 0 ? '' : `\n\n[exit code ${code ?? `signal ${signal}`}]`;
          resolve({ output: `${body || '(no output)'}${status}`, isError: code !== 0 });
        }, reject);
      });
    });
  },
});

interface ShellIdArgs { id: string }

export const bashOutputTool = defineTool<ShellIdArgs>({
  name: 'bash_output',
  class: 'read',
  description: 'Return new output from a background shell since the last check, plus whether it is still running.',
  parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: 'Background shell id, e.g. bash_1.' } } },
  label: (args) => `Output of ${args.id}`,
  async run(args, ctx) {
    const shell = ctx.session.shells.get(args.id);
    if (!shell) return { output: `No background shell "${args.id}". Known: ${[...ctx.session.shells.keys()].join(', ') || 'none'}.`, isError: true };
    const text = shell.unread;
    const dropped = shell.droppedBytes;
    shell.unread = '';
    shell.droppedBytes = 0;
    const status = shell.status === 'running' ? 'running' : `${shell.status}${shell.exitCode !== undefined && shell.exitCode !== null ? ` (exit code ${shell.exitCode})` : shell.signal ? ` (${shell.signal})` : ''}`;
    const half = Math.floor(OUTPUT_CAPS.toolOutputBytes / 2);
    const body = redactSecrets(text.length > OUTPUT_CAPS.toolOutputBytes ? `${text.slice(0, half)}\n… [${text.length - half * 2} characters truncated] …\n${text.slice(-half)}` : text);
    return { output: `[${args.id}: ${status}]${dropped ? ` [${dropped} earlier characters dropped]` : ''}\n${body || '(no new output)'}` };
  },
});

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
