/** Waiting on purpose, woken by the event itself -- never a poll.
 *
 * A background shell's exit already arrives as a message, so a model with
 * nothing else to do ends its turn. This is for the rest: carrying on in the
 * same turn once a build finishes, waiting for a file to appear or change,
 * or a timed pause ("check again in two minutes"). Whatever comes first
 * wakes it: a listed shell's exit (its process's own close event), a change
 * under the path (fs.watch), the time running out, or the turn cancelled. */
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { turnCancelledError } from '../cancellation.js';
import { defineTool } from '../tool-contract.js';

interface WaitArgs { shell_ids?: string[]; path?: string; seconds?: number }

const DEFAULT_SECONDS = 300;
const MAX_SECONDS = 1800;

export const waitTool = defineTool<WaitArgs>({
  name: 'wait',
  class: 'read',
  description: 'Wait until something happens, then continue in the same turn: a background shell exits (shell_ids; empty with no path means any running background shell), a file or directory changes (path), or the time runs out (seconds, default 300, max 1800) -- whichever comes first. Woken by the event itself, so use this instead of sleep loops or polling bash_output. If you have nothing to do until a background shell finishes and do not need to continue in this turn, end your turn instead: its exit arrives as a new message.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      shell_ids: { type: 'array', items: { type: 'string' }, description: 'Background shells to wait for (e.g. ["bash_1"]); the first to exit wakes the wait.' },
      path: { type: 'string', description: 'A file or directory to wait on: any change to it (created, written, renamed, deleted) wakes the wait.' },
      seconds: { type: 'integer', minimum: 1, maximum: MAX_SECONDS, description: 'The longest to wait, in seconds.' },
    },
  },
  label: (args) => `Wait${args.shell_ids?.length ? ` for ${args.shell_ids.join(', ')}` : ''}${args.path ? ` for ${args.path}` : ''} (≤${args.seconds ?? DEFAULT_SECONDS}s)`,
  async run(args, ctx) {
    if (ctx.signal?.aborted) throw turnCancelledError();
    const seconds = Math.min(Math.max(Math.round(args.seconds ?? DEFAULT_SECONDS), 1), MAX_SECONDS);
    const named = args.shell_ids ?? [];
    const unknown = named.filter((id) => !ctx.session.shells.has(id));
    if (unknown.length) return { output: `No background shell ${unknown.map((id) => `"${id}"`).join(', ')}. Known: ${[...ctx.session.shells.keys()].join(', ') || 'none'}.`, isError: true };
    const shells = (named.length ? named.map((id) => ctx.session.shells.get(id)!) : args.path ? [] : [...ctx.session.shells.values()].filter((shell) => shell.status === 'running'));
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
