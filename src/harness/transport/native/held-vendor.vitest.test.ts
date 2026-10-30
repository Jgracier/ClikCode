/** A Claude turn that ends with background tasks still running ends at once;
 * the process is kept for what those tasks produce.
 *
 * Replays the real claude 2.1.281 stream in fixtures/claude-background-bash
 * (a backgrounded `sleep 12; echo done-marker`, the `result` for the prompt,
 * then the task's notification and Claude's follow-up turn) through a stand-in
 * process, the same way background-wait.vitest.test.ts does. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBackgroundWait, streamJsonUserMessage } from './background-wait.js';
import { hasHeldVendorProcess, holdVendorProcess, releaseHeldVendorProcess, stopHeldVendorProcess, retireHeldVendorProcess, retiredHeldAgentCount, waitForHeldVendorSubagents, whenHeldVendorGone, type HeldVendor } from './held-vendor.js';
import { captureNativeHarnessTurn, createTurnInput, createTurnRelease } from './turn.js';
import { reportStructuredLine } from '../../events/structured.js';
import { createStreamState } from '../../events/adapters.js';
import type { BackgroundTurnOutcome, VendorBackgroundTurn } from '../background-turn.js';
import type { EndedWork } from '../handoff-work.js';
import type { AiLocalHarnessDefinition } from '../../definition.js';

type Json = Record<string, unknown>;
const records = readFileSync(join(__dirname, 'fixtures', 'claude-background-bash.jsonl'), 'utf8')
  .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Json);
const firstResult = records.findIndex((record) => record.type === 'result') + 1;
const taskId = records.find((record) => record.subtype === 'task_started')?.task_id as string;
const claude = { command: 'claude', parser: 'claude-stream-json' } as unknown as AiLocalHarnessDefinition;

/** Stand-in claude: the head up to the first result at once, the rest after
 * `delayMs` (never, when null) unless stdin closed first; exits when stdin ends. */
const vendor = (delayMs: number | null, ignoresEnd = false, asAgent = false, failed = false, quota = false): string[] => {
  const timeline = records.map((record) => {
    if (asAgent && (record.subtype === 'task_started' || record.subtype === 'background_tasks_changed')) {
      const tasks = Array.isArray(record.tasks) ? record.tasks.map((task: Json) => ({ ...task, task_type: 'local_agent' })) : undefined;
      return { ...record, ...(tasks ? { tasks } : {}), ...(record.subtype === 'task_started' ? { task_type: 'local_agent' } : {}) };
    }
    if (failed && record.type === 'result' && record === records[firstResult - 1]) return { ...record, is_error: true, subtype: 'error_during_execution' };
    if (quota && record.subtype === 'task_notification') return { ...record, status: 'failed', summary: "Agent \"x\" failed: Agent terminated early due to an API error: You've hit your weekly limit · resets Oct 28, 1am (error type rate_limit, HTTP 429, request id req_1)" };
    return record;
  });
  const head = timeline.slice(0, firstResult).map((record) => JSON.stringify(record));
  const tail = timeline.slice(firstResult).map((record) => JSON.stringify(record));
  return ['-e', `
    const head = ${JSON.stringify(head)}, tail = ${JSON.stringify(tail)}, delay = ${JSON.stringify(delayMs)};
    let started = false, closed = false;
    process.stdin.on('data', () => { if (started) return; started = true; head.forEach((l) => console.log(l));
      if (delay !== null) setTimeout(() => { if (closed) return; delivered = true; tail.forEach((l) => console.log(l)); }, delay); });
    // As claude does when its input ends: running tasks are killed, and said so.
    let delivered = false;
    process.stdin.on('end', () => { closed = true; if (${JSON.stringify(ignoresEnd)}) { setInterval(() => {}, 1000); return; }
      if (!delivered) console.log(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: ${JSON.stringify(taskId)}, status: 'killed' }));
      setTimeout(() => process.exit(0), 20); });
    process.stdin.resume();`];
};

/** The turn loop's side, as the vendor turn wires it. */
async function runTurn(sessionId: string, delayMs: number | null, ignoresEnd = false, asAgent = false, failed = false, quota = false, workEnded?: (ended: readonly EndedWork[]) => void) {
  const input = createTurnInput();
  const release = createTurnRelease();
  const turns: VendorBackgroundTurn[] = [];
  let held: HeldVendor | undefined;
  const background = createBackgroundWait({ onSettled: () => input.end(), onQuiet: () => held?.quiet() });
  const streams = new WeakMap<object, ReturnType<typeof createStreamState>>();
  const started = Date.now();
  const output = await captureNativeHarnessTurn(
    { command: 'fixture', binary: process.execPath, displayName: 'Fixture' }, vendor(delayMs, ignoresEnd, asAgent, failed, quota), {}, {
      stdinText: streamJsonUserMessage('go'), input, release,
      onStdoutLine: (line) => {
        const record = JSON.parse(line) as Json;
        if (held) { held.line(line, record); return; }
        background.note(record);
        if (record.type === 'result' && background.pending > 0 && background.quiet) {
          held = holdVendorProcess({
            sessionId, background, release, endInput: () => input.end(), handler: (turn) => { turns.push(turn); }, workEnded,
            report: (text, observer, parsed) => {
              let position = streams.get(observer);
              if (!position) streams.set(observer, position = createStreamState());
              reportStructuredLine(claude, text, observer, position, parsed);
            },
          });
        }
      },
    });
  return { output, turns, elapsedMs: Date.now() - started };
}

describe('a Claude turn that leaves background tasks running', () => {
  it('reports an agent that stopped on the usage limit, with why as fields, while its parent process is still active', async () => {
    const ended: EndedWork[][] = [];
    await runTurn('held-agent-limit', 100, false, true, false, true, (items) => ended.push([...items]));
    await vi.waitFor(() => expect(ended).toHaveLength(1), { timeout: 5_000 });
    expect(ended[0]![0]).toMatchObject({ id: taskId, kind: 'agent', outcome: 'cut-off', failure: { vendorError: true, errorKind: 'rate_limit', statusCode: 429, text: "You've hit your weekly limit · resets Oct 28, 1am" } });
    await whenHeldVendorGone('held-agent-limit');
    expect(ended).toHaveLength(1);
  });
  it('holds a subagent through a failed parent reply and lets it finish before release', async () => {
    const { turns } = await runTurn('held-agent', 400, false, true, true);
    expect(hasHeldVendorProcess('held-agent')).toBe(true);
    let finished = false;
    const waiting = waitForHeldVendorSubagents('held-agent').then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toBe(false);
    await waiting;
    expect(turns).toHaveLength(1);
    expect((await turns[0]!.finished).ended).toBe('completed');
    await vi.waitFor(() => expect(hasHeldVendorProcess('held-agent')).toBe(false), { timeout: 5000 });
  });

  it('a process the conversation leaves keeps its subagent running and tells its end', async () => {
    await runTurn('held-agent-retire', 400, false, true, true);
    const ended: EndedWork[][] = [];
    expect(retireHeldVendorProcess('held-agent-retire', (list) => ended.push(list))).toBe(true);
    // No longer the session's held process: a turn does not wait on it, and it is not stopped.
    expect(hasHeldVendorProcess('held-agent-retire')).toBe(false);
    expect(retiredHeldAgentCount('held-agent-retire')).toBe(1);
    await vi.waitFor(() => expect(ended).toHaveLength(1), { timeout: 5000 });
    expect(ended[0]![0]).toMatchObject({ kind: 'agent', outcome: 'finished' });
    await whenHeldVendorGone('held-agent-retire');
    expect(retiredHeldAgentCount('held-agent-retire')).toBe(0);
  });

  it('a retired process that goes before its subagent ends tells it cut off; a Stop tells nothing', async () => {
    await runTurn('held-agent-gone', null, false, true, true);
    const ended: EndedWork[][] = [];
    expect(retireHeldVendorProcess('held-agent-gone', (list) => ended.push(list))).toBe(true);
    await stopHeldVendorProcess('held-agent-gone');
    expect(retiredHeldAgentCount('held-agent-gone')).toBe(0);
    expect(ended).toEqual([]);
  });

  it('retiring a process that runs no subagent does nothing', async () => {
    await runTurn('held-no-agent', 400);
    expect(retireHeldVendorProcess('held-no-agent', () => undefined)).toBe(false);
    expect(hasHeldVendorProcess('held-no-agent')).toBe(true);
    await stopHeldVendorProcess('held-no-agent');
  });

  it('ends at the first result, and the follow-up arrives as a background turn', async () => {
    const { output, turns, elapsedMs } = await runTurn('held-a', 400);
    expect(output.exitCode).toBe(0);
    expect(output.stdout.trim().split('\n'), 'the turn waited past its own result').toHaveLength(firstResult);
    expect(elapsedMs).toBeLessThan(400);
    expect(hasHeldVendorProcess('held-a')).toBe(true);
    await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5_000 });
    const texts: string[] = [];
    turns[0]!.attach({ onResponseDelta: (text) => { texts.push(text); } });
    const outcome: BackgroundTurnOutcome = await turns[0]!.finished;
    expect(outcome.ended).toBe('completed');
    expect(outcome.text).toContain('done-marker');
    expect(texts.join('')).toContain('done-marker');
    // Nothing left to wait for: stdin closed and the process went away.
    await vi.waitFor(() => expect(hasHeldVendorProcess('held-a')).toBe(false), { timeout: 5_000 });
  });

  it('gives the prompt back at once for a task that never ends, and lets it go on the next turn', async () => {
    const { output, turns, elapsedMs } = await runTurn('held-b', null);
    expect(output.exitCode).toBe(0);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(hasHeldVendorProcess('held-b')).toBe(true);
    expect(await releaseHeldVendorProcess('held-b')).toBe(true);
    expect(hasHeldVendorProcess('held-b')).toBe(false);
    // Its tasks reported killed on the way out: not a background turn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(turns, 'nothing happened after the answer to show').toHaveLength(0);
    expect(await releaseHeldVendorProcess('held-b')).toBe(false);
  });

  it('supersedes a background turn under way when the next turn starts', async () => {
    const { turns } = await runTurn('held-c', 50);
    await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5_000 });
    // The follow-up may already be over; if not, the next turn ends it.
    await releaseHeldVendorProcess('held-c');
    const outcome = await turns[0]!.finished;
    expect(['completed', 'superseded']).toContain(outcome.ended);
    expect(hasHeldVendorProcess('held-c')).toBe(false);
  });

  it('tells whoever waits on it (the worker\'s idle exit) when the held process is gone', async () => {
    await expect(whenHeldVendorGone('held-none')).resolves.toBeUndefined();
    const { turns } = await runTurn('held-d', 300);
    expect(hasHeldVendorProcess('held-d')).toBe(true);
    let gone = false;
    const waiting = whenHeldVendorGone('held-d').then(() => { gone = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gone, 'gone while its task still ran').toBe(false);
    await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5_000 });
    await waiting;
    expect(hasHeldVendorProcess('held-d')).toBe(false);
  });

  // Ctrl+C while the window followed its background work used to be dropped:
  // the work, and the window's spinner, ran on until they ended by themselves.
  it('stops at once when the user stops it, even a vendor that ignores its input ending', async () => {
    await runTurn('held-e', null, true);
    expect(hasHeldVendorProcess('held-e')).toBe(true);
    const started = Date.now();
    expect(await stopHeldVendorProcess('held-e')).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(hasHeldVendorProcess('held-e')).toBe(false);
    expect(await stopHeldVendorProcess('held-e')).toBe(false);
  });
});
