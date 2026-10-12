/** Streams a long-running command's stdout to the model as it appears: each
 * line is an event, delivered as a message before the model's next step (or as
 * a follow-up turn when none is running), exactly as a background shell's exit
 * is. The command is a background shell of the session (bash.ts), so
 * bash_output, wait and kill_bash reach it, its exit is announced, and the
 * worker's idle exit waits for it.
 *
 * Bounded on every side: a deadline (default 5 minutes; `persistent` lifts it),
 * a cap on the lines it may ever deliver, and a cap on one message. Whatever
 * ends it says so in the message the model gets. */
import { classifyCommand } from '../command-classifier.js';
import { redactSecrets } from '../security.js';
import { queueShellNotification } from '../session-state.js';
import { defineTool, type ToolContext } from '../tool-contract.js';
import { formatToolRow } from '../../harness/protocol/tools.js';
import { scopeOf } from './fs-helpers.js';
import { spawnBackgroundShell, stopBackgroundShell } from './bash.js';

interface MonitorArgs { command: string; description: string; timeout_ms?: number; persistent?: boolean }

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;
/** Lines are gathered this long before they are delivered, so a burst is one message. */
const BATCH_MS = 250;
/** Most lines one message carries; the rest of a burst is counted, not shown. */
const BATCH_LINES = 40;
const BATCH_CHARS = 4000;
/** A monitor that has delivered this many lines is stopped: it is not selective. */
const MAX_LINES = 500;

export const monitorTool = defineTool<MonitorArgs>({
  name: 'monitor',
  class: 'exec',
  description: `Start a background monitor: a long-running command whose every stdout line is an event, delivered to you as a message while you keep working (not a reply from the user, even if one lands while you wait for them). Use it for "tell me each time X happens" (tail -f app.log | grep --line-buffered ERROR, a poll loop that prints one line per change). For a single "tell me when it is ready" use bash with run_in_background and wait instead. Write a specific description: it heads every message. Filter to the lines you would act on and flush per line (grep --line-buffered); cover failure states, because silence looks like success. Only stdout is the event stream (merge stderr with 2>&1 if you need it). It ends when the command exits, at the deadline (timeout_ms, default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}; persistent: true runs until kill_bash or the session ends), or once it has delivered ${MAX_LINES} lines (re-arm with a narrower filter). Each ending is reported. Stop it early with kill_bash.`,
  parameters: {
    type: 'object', additionalProperties: false, required: ['command', 'description'],
    properties: {
      command: { type: 'string', description: 'The command whose stdout lines are the events.' },
      description: { type: 'string', description: 'Short human-readable description of what is watched; shown in every message.' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_TIMEOUT_MS, description: 'Kill the monitor after this long. Ignored when persistent is true.' },
      persistent: { type: 'boolean', description: 'No deadline: run for the lifetime of the session.' },
    },
  },
  label: (args) => formatToolRow('monitor', args.description || args.command, 'run'),
  async describe(args) {
    return [args.command, '', `monitors: ${args.description}`, args.persistent ? 'no deadline' : `stops after ${Math.round(Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS) / 1000)}s`].join('\n');
  },
  async run(args, ctx) {
    // Held here as in bash: a hard-denied command must never execute.
    const tier = classifyCommand(args.command, scopeOf(ctx));
    if (tier.tier === 'deny') return { output: `Refused: ${tier.reason}. This command is never run.`, isError: true };
    if (ctx.signal?.aborted) return { output: 'The turn was cancelled; no monitor was started.', isError: true };
    const feed = lineFeed(args.description, ctx);
    const { shell, notice } = spawnBackgroundShell({ command: args.command, description: args.description }, ctx, feed.onStdout);
    feed.bind(shell.id, (reason) => stopBackgroundShell(shell, reason));
    // The stream's end comes before the process's close, so the last lines
    // reach the model before the exit notice.
    shell.child.stdout?.once('end', feed.finish);
    let deadline = '';
    if (!args.persistent) {
      const ms = Math.min(Math.max(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
      const timer = setTimeout(() => { if (shell.status === 'running') stopBackgroundShell(shell, `the monitor "${args.description}" reached its ${Math.round(ms / 1000)}s deadline after ${feed.delivered()} line(s); re-arm it if you still need the watch, and widen the filter if silence was unexpected`); }, ms);
      timer.unref();
      shell.child.once('close', () => clearTimeout(timer));
      deadline = `, expires in ${Math.round(ms / 1000)}s unless the command ends first (you get one notice at expiry)`;
    }
    return { output: `${notice ? `${notice}\n` : ''}Monitor started (${shell.id}${deadline}). You will be messaged for each batch of output lines. Keep working: do not poll or sleep. kill_bash stops it.` };
  },
});

interface LineFeed {
  onStdout(chunk: string): void;
  /** Delivers what is left: a last unterminated line and any batch not yet sent. */
  finish(): void;
  delivered(): number;
  bind(shellId: string, stop: (reason: string) => void): void;
}

/** Splits stdout into lines and hands them to the session in batches. */
function lineFeed(description: string, ctx: ToolContext): LineFeed {
  let partial = '';
  let batch: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  let total = 0;
  let id = '';
  let stop: ((reason: string) => void) | undefined;
  const send = (): void => {
    timer = undefined;
    if (!batch.length) return;
    const lines = batch.splice(0);
    const shown: string[] = [];
    let chars = 0;
    for (const line of lines) {
      if (shown.length >= BATCH_LINES || chars + line.length > BATCH_CHARS) break;
      shown.push(line.slice(0, BATCH_CHARS));
      chars += line.length;
    }
    const more = lines.length - shown.length;
    queueShellNotification(ctx.session, {
      kind: 'output', shellId: id, command: description, at: Date.now(),
      tail: redactSecrets(`${shown.join('\n')}${more > 0 ? `\n… and ${more} more line(s)` : ''}`),
    });
  };
  const take = (line: string): void => {
    if (!line) return;
    total += 1;
    if (total > MAX_LINES) return;
    batch.push(line);
    timer ??= setTimeout(send, BATCH_MS);
    if (total === MAX_LINES) stop?.(`the monitor "${description}" delivered ${MAX_LINES} lines and was stopped: it is not selective enough; re-arm it with a narrower filter`);
  };
  const feed: LineFeed = {
    onStdout(chunk) {
      const parts = (partial + chunk).split('\n');
      partial = parts.pop() ?? '';
      for (const line of parts) take(line.replace(/\r$/, ''));
    },
    finish() {
      if (partial) { take(partial.replace(/\r$/, '')); partial = ''; }
      if (timer) clearTimeout(timer);
      send();
    },
    delivered: () => Math.min(total, MAX_LINES),
    bind(shellId, stopShell) { id = shellId; stop = stopShell; },
  };
  return feed;
}
