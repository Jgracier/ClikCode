/** Holding Claude Code's stdin open until its background work reports back.
 *
 * The fixtures are real claude 2.1.281 streams (`-p --verbose --input-format
 * stream-json --output-format stream-json`, stdin held open), captured with a
 * backgrounded Bash and a backgrounded Agent. Each has a `result` for the
 * prompt, then -- seconds later -- the task's notification and a follow-up
 * turn with its own `result`. Closing stdin at the first `result` is what used
 * to kill the task. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackgroundWait, streamJsonUserMessage } from './background-wait.js';
import { captureNativeHarnessTurn, createTurnIdleController, createTurnInput } from './turn.js';

type Json = Record<string, unknown>;
const fixture = (name: string): Json[] => readFileSync(join(__dirname, 'fixtures', `${name}.jsonl`), 'utf8')
  .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Json);

/** Replays records; returns the index of the record after which it settled. */
function replay(records: readonly Json[], graceMs = 30_000): { settledAt: number; started: string[]; finished: string[] } {
  let settledAt = -1;
  let index = 0;
  const started: string[] = [];
  const finished: string[] = [];
  const wait = createBackgroundWait({
    onSettled: () => { settledAt = index; },
    onTaskStarted: (id) => started.push(id),
    onTaskFinished: (id, status) => finished.push(`${id}:${status}`),
    graceMs,
  });
  for (; index < records.length; index += 1) wait.note(records[index]!);
  wait.dispose();
  return { settledAt, started, finished };
}

const results = (records: readonly Json[]): number[] => records.flatMap((record, index) => record.type === 'result' ? [index] : []);

afterEach(() => { vi.useRealTimers(); });

describe('background wait on a held-open Claude stdin', () => {
  it('waits past the first result for a background Bash and its follow-up turn', () => {
    const records = fixture('claude-background-bash');
    const [first, last] = results(records);
    expect(first).toBeLessThan(last!);
    const outcome = replay(records);
    expect(outcome.settledAt, 'closed stdin at the first result, which kills the task').toBe(last);
    expect(outcome.started).toHaveLength(1);
    expect(outcome.finished).toEqual([`${outcome.started[0]}:completed`]);
  });

  it('waits for a background subagent, and not for the subagent\'s own tool', () => {
    const records = fixture('claude-background-agent');
    const outcome = replay(records);
    expect(outcome.settledAt).toBe(results(records).at(-1));
    // The subagent's foreground Bash (owned_by_subagent) is not a main-agent task.
    expect(outcome.started).toHaveLength(1);
  });

  it('settles at the result of a plain turn with no background work', () => {
    const records = fixture('claude-background-bash');
    const plain = records.slice(0, results(records)[0]).filter((record) => record.type !== 'system' || record.subtype === 'init');
    const at = plain.length;
    plain.push({ type: 'result', subtype: 'success', is_error: false });
    expect(replay(plain).settledAt).toBe(at);
  });

  it('does not wait for a follow-up when the task finished inside the turn', () => {
    // Observed live: a notification arriving while a turn runs is folded into
    // that turn, and no further turn follows.
    const records: Json[] = [
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', description: 'sleep 3' }] },
      { type: 'system', subtype: 'task_started', task_id: 'b1', is_backgrounded: true },
      { type: 'system', subtype: 'task_started', task_id: 'f1', is_backgrounded: false },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
      { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' },
      { type: 'system', subtype: 'task_notification', task_id: 'f1', status: 'completed' },
      { type: 'result', subtype: 'success', is_error: false },
    ];
    expect(replay(records).settledAt).toBe(records.length - 1);
  });

  it('stops waiting at a failed result', () => {
    const records: Json[] = [
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'task_started', task_id: 'b1', is_backgrounded: true },
      { type: 'result', subtype: 'error_during_execution', is_error: true },
    ];
    const outcome = replay(records);
    expect(outcome.settledAt).toBe(2);
    expect(outcome.finished).toEqual(['b1:abandoned']);
  });

  it('gives up on a task that left the list with no notification, after the ceiling', () => {
    vi.useFakeTimers();
    let settled = false;
    const wait = createBackgroundWait({ onSettled: () => { settled = true; }, graceMs: 1_000 });
    wait.note({ type: 'system', subtype: 'task_started', task_id: 'b1', is_backgrounded: true });
    wait.note({ type: 'result', subtype: 'success', is_error: false });
    wait.note({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    expect(settled, 'an empty list precedes the notification; it must not close stdin').toBe(false);
    vi.advanceTimersByTime(999);
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(settled).toBe(true);
  });

  it('gives up on a follow-up turn that never starts, after the ceiling', () => {
    vi.useFakeTimers();
    let settled = false;
    const wait = createBackgroundWait({ onSettled: () => { settled = true; }, graceMs: 1_000 });
    wait.note({ type: 'system', subtype: 'task_started', task_id: 'b1', is_backgrounded: true });
    wait.note({ type: 'result', subtype: 'success', is_error: false });
    wait.note({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
    expect(settled, 'a follow-up turn is owed').toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(settled).toBe(true);
  });

  it('waits for the answer to a message written while it waited', () => {
    let settled = false;
    const wait = createBackgroundWait({ onSettled: () => { settled = true; } });
    wait.note({ type: 'system', subtype: 'task_started', task_id: 'b1', is_backgrounded: true });
    wait.note({ type: 'result', subtype: 'success', is_error: false });
    wait.noteInput();
    wait.note({ type: 'system', subtype: 'init' });
    wait.note({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
    expect(settled).toBe(false);
    wait.note({ type: 'result', subtype: 'success', is_error: false });
    expect(settled).toBe(true);
  });

  it('encodes a prompt as one stream-json user message line', () => {
    expect(JSON.parse(streamJsonUserMessage('/context'))).toEqual({ type: 'user', message: { role: 'user', content: '/context' } });
    expect(streamJsonUserMessage('a\nb').trimEnd()).not.toContain('\n');
  });
});

describe('a held-open stdin on a real process', () => {
  /** A stand-in for claude: replays the fixture up to its first result, then
   * the rest a moment later -- unless stdin closed first, in which case the
   * task is "killed" the way claude kills it, and it exits. */
  const vendor = (records: readonly Json[]): string[] => {
    const first = records.findIndex((record) => record.type === 'result') + 1;
    const head = records.slice(0, first).map((record) => JSON.stringify(record));
    const tail = records.slice(first).map((record) => JSON.stringify(record));
    return ['-e', `
      const head = ${JSON.stringify(head)}, tail = ${JSON.stringify(tail)};
      let started = false, closed = false;
      process.stdin.on('data', () => { if (started) return; started = true; head.forEach((l) => console.log(l));
        setTimeout(() => { if (closed) return; tail.forEach((l) => console.log(l)); }, 150); });
      process.stdin.on('end', () => { closed = true; if (!started) process.exit(2);
        setTimeout(() => process.exit(0), 20); });
      process.stdin.resume();`];
  };

  it('keeps the vendor alive for the follow-up turn and then lets it exit', async () => {
    const records = fixture('claude-background-bash');
    const followUp = records.at(-2) as Json;
    const input = createTurnInput();
    const idle = createTurnIdleController();
    const wait = createBackgroundWait({ onSettled: () => input.end() });
    const output = await captureNativeHarnessTurn(
      { command: 'fixture', binary: process.execPath, displayName: 'Fixture' }, vendor(records), {}, {
        stdinText: streamJsonUserMessage('go'), input, idleController: idle, idleTimeoutMs: 5_000,
        onStdoutLine: (line) => wait.note(JSON.parse(line) as Json),
      });
    wait.dispose();
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain(JSON.stringify(followUp));
    expect(output.stdout.trim().split('\n')).toHaveLength(records.length);
  });
});

describe('vendor background work read off the stream', () => {
  it('reads Cursor\'s backgrounded shell and the notification that ends it', async () => {
    const { vendorBackgroundEvent } = await import('./background-task.js');
    const events = fixture('cursor-background-shell').map((value) => vendorBackgroundEvent(value)).filter(Boolean);
    expect(events).toEqual([
      { kind: 'started', id: '484640', description: 'sleep 20; echo done-marker > marker.txt' },
      { kind: 'finished', id: '484640', status: 'success' },
    ]);
  });

  it('reads Claude\'s background tasks and ignores its foreground and subagent ones', async () => {
    const { vendorBackgroundEvent } = await import('./background-task.js');
    const started = fixture('claude-background-agent').map((value) => vendorBackgroundEvent(value)).filter((event) => event?.kind === 'started');
    expect(started).toHaveLength(1);
  });
});

describe('ending the turn before the background work', () => {
  it('is quiet at the first result while the task still runs, and at the follow-up\'s result', () => {
    const records = fixture('claude-background-bash');
    const [first, last] = results(records);
    const quietAt: number[] = [];
    let index = 0;
    const wait = createBackgroundWait({ onSettled: () => undefined, onQuiet: () => quietAt.push(index) });
    for (; index < records.length; index += 1) {
      wait.note(records[index]!);
      if (index === first) {
        expect(wait.pending).toBe(1);
        expect(wait.quiet).toBe(true);
        expect(wait.settled).toBe(false);
      }
    }
    wait.dispose();
    expect(quietAt).toEqual([first, last]);
  });

  it('lets still-running tasks go a bounded while after a result, when asked to', () => {
    vi.useFakeTimers();
    let settled = false;
    const finished: string[] = [];
    const wait = createBackgroundWait({
      onSettled: () => { settled = true; }, onTaskFinished: (id, status) => finished.push(`${id}:${status}`), resultGraceMs: 60_000,
    });
    wait.note({ type: 'system', subtype: 'init' });
    wait.note({ type: 'system', subtype: 'task_started', task_id: 'dev', is_backgrounded: true });
    wait.note({ type: 'result', subtype: 'success', is_error: false });
    vi.advanceTimersByTime(59_999);
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(settled).toBe(true);
    expect(finished).toEqual(['dev:abandoned']);
  });

  it('does not let tasks go while a follow-up turn runs', () => {
    vi.useFakeTimers();
    let settled = false;
    const wait = createBackgroundWait({ onSettled: () => { settled = true; }, resultGraceMs: 1_000 });
    wait.note({ type: 'system', subtype: 'task_started', task_id: 'a', is_backgrounded: true });
    wait.note({ type: 'system', subtype: 'task_started', task_id: 'b', is_backgrounded: true });
    wait.note({ type: 'result', subtype: 'success', is_error: false });
    wait.note({ type: 'system', subtype: 'task_notification', task_id: 'a', status: 'completed' });
    wait.note({ type: 'system', subtype: 'init' });
    vi.advanceTimersByTime(5_000);
    expect(settled).toBe(false);
    wait.note({ type: 'result', subtype: 'success', is_error: false });
    vi.advanceTimersByTime(1_000);
    expect(settled).toBe(true);
  });
});
