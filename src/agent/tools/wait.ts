/** Waiting on purpose, woken by the event itself -- never a poll.
 *
 * A background shell's exit already arrives as a message, so a model with
 * nothing else to do ends its turn. This is for the rest: carrying on in the
 * same turn once a build finishes, waiting for a server to say it is ready,
 * waiting for a file to appear or change, or a timed pause ("check again in
 * two minutes"). Whatever comes first wakes it: a listed shell's exit (its
 * process's own close event), a listed shell printing a line that matches
 * `output` (its own data events), a change under the path (fs.watch), the
 * time running out, or the turn cancelled. */
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { turnCancelledError } from '../cancellation.js';
import { defineTool } from '../tool-contract.js';

interface WaitArgs { shell_ids?: string[]; output?: string; path?: string; seconds?: number }

const DEFAULT_SECONDS = 300;
const MAX_SECONDS = 1800;
/** How much of a shell's recent output an `output` pattern is matched against. */
const MATCH_WINDOW_CHARS = 64 * 1024;

/** The whole line holding the match, so the model gets the port or the URL
 * it waited for without a bash_output call. */
function matchedLine(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  const start = text.lastIndexOf('\n', match.index) + 1;
  const end = text.indexOf('\n', match.index + match[0].length);
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 500);
}

export const waitTool = defineTool<WaitArgs>({
  name: 'wait',
  class: 'read',
  description: 'Wait until something happens, then continue in the same turn: a background shell exits (shell_ids; empty with no path means any running background shell), one of those shells prints output matching a regular expression (output, e.g. "listening on|ready"; the matching line is returned, and its output not yet read stays for bash_output), a file or directory changes (path), or the time runs out (seconds, default 300) -- whichever comes first. Use it instead of sleep loops or polling bash_output, for example to wait until a server started in the background is ready.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      shell_ids: { type: 'array', items: { type: 'string' }, description: 'Background shells (e.g. ["bash_1"]); the first to exit wakes the wait.' },
      output: { type: 'string', description: 'A regular expression (JavaScript syntax): wake as soon as one of the shells prints output that matches, including output it printed earlier that has not been read yet.' },
      path: { type: 'string', description: 'A file or directory; any change to it wakes the wait.' },
      seconds: { type: 'integer', minimum: 1, maximum: MAX_SECONDS, description: 'The longest to wait.' },
    },
  },
  label: (args) => `Wait${args.shell_ids?.length ? ` for ${args.shell_ids.join(', ')}` : ''}${args.output ? ` to print /${args.output}/` : ''}${args.path ? ` for ${args.path}` : ''} (≤${args.seconds ?? DEFAULT_SECONDS}s)`,
  async run(args, ctx) {
    if (ctx.signal?.aborted) throw turnCancelledError();
    const seconds = Math.min(Math.max(Math.round(args.seconds ?? DEFAULT_SECONDS), 1), MAX_SECONDS);
    const named = args.shell_ids ?? [];
    const unknown = named.filter((id) => !ctx.session.shells.has(id));
    if (unknown.length) return { output: `No background shell ${unknown.map((id) => `"${id}"`).join(', ')}. Known: ${[...ctx.session.shells.keys()].join(', ') || 'none'}.`, isError: true };
    let pattern: RegExp | undefined;
    if (args.output) {
      try { pattern = new RegExp(args.output, 'm'); } catch (error) {
        return { output: `output is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    }
    const shells = (named.length ? named.map((id) => ctx.session.shells.get(id)!) : args.path && !pattern ? [] : [...ctx.session.shells.values()].filter((shell) => shell.status === 'running'));
    if (pattern && !shells.length) return { output: 'No running background shell to watch for that output.', isError: true };
    // What each shell printed that the model has not read: a server that was
    // ready before the wait began wakes it at once.
    const seen = new Map(shells.map((shell) => [shell, shell.unread.slice(-MATCH_WINDOW_CHARS)]));
    if (pattern) {
      for (const [shell, text] of seen) {
        const line = matchedLine(text, pattern);
        if (line !== undefined) return { output: `${shell.id} printed: ${line}` };
      }
    }
    const done = shells.find((shell) => shell.status !== 'running');
    if (done) return { output: `${done.id} has already exited${done.exitCode !== undefined && done.exitCode !== null ? ` (code ${done.exitCode})` : ''}.` };
    const started = Date.now();
    const target = args.path ? path.resolve(ctx.cwd, args.path) : undefined;

    return new Promise((resolve, reject) => {
      const cleanup: Array<() => void> = [];
      let settled = false;
      const finish = (output: string): void => {
        if (settled) return;
        settled = true;
        for (const undo of cleanup) undo();
        resolve({ output: `${output} (after ${Math.round((Date.now() - started) / 1000)}s)` });
      };
      for (const shell of shells) {
        const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
          finish(`${shell.id} exited${code !== null ? ` (code ${code})` : signal ? ` (${signal})` : ''}; its output follows as a notification, or read it with bash_output.`);
        };
        shell.child.once('close', onClose);
        cleanup.push(() => shell.child.off('close', onClose));
        if (!pattern) continue;
        const onData = (chunk: string | Buffer): void => {
          const text = `${seen.get(shell) ?? ''}${chunk.toString()}`.slice(-MATCH_WINDOW_CHARS);
          seen.set(shell, text);
          const line = matchedLine(text, pattern);
          if (line !== undefined) finish(`${shell.id} printed: ${line}`);
        };
        for (const stream of [shell.child.stdout, shell.child.stderr]) {
          if (!stream) continue;
          stream.on('data', onData);
          cleanup.push(() => stream.off('data', onData));
        }
      }
      if (target) {
        // The parent directory, filtered to the name: catches a file that
        // does not exist yet, and one replaced by rename (editors do).
        const parent = path.dirname(target);
        const name = path.basename(target);
        let watcher: FSWatcher | undefined;
        try {
          watcher = watch(parent, (event, changed) => {
            if (changed === null || changed.toString() === name) finish(`${args.path} changed (${event}).`);
          });
          watcher.on('error', () => undefined);
          cleanup.push(() => watcher?.close());
        } catch (error) {
          for (const undo of cleanup) undo();
          resolve({ output: `Cannot watch ${args.path}: ${error instanceof Error ? error.message : String(error)}`, isError: true });
          return;
        }
        // A directory itself: changes inside it, too.
        try {
          const inside = watch(target, () => finish(`${args.path} changed.`));
          inside.on('error', () => undefined);
          cleanup.push(() => inside.close());
        } catch { /* fail-open-ok: not a directory, or not there yet -- the parent covers it */ }
      }
      const timer = setTimeout(() => finish(`Waited ${seconds}s; nothing ${shells.length || target ? 'happened' : 'to wait for'} sooner.`), seconds * 1000);
      cleanup.push(() => clearTimeout(timer));
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        for (const undo of cleanup) undo();
        reject(turnCancelledError());
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      cleanup.push(() => ctx.signal?.removeEventListener('abort', onAbort));
    });
  },
});
