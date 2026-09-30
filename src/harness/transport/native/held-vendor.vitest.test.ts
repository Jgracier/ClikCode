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
import { hasHeldVendorProcess, holdVendorProcess, releaseHeldVendorProcess, type HeldVendor } from './held-vendor.js';
import { captureNativeHarnessTurn, createTurnIdleController, createTurnInput, createTurnRelease } from './turn.js';
import { reportStructuredLine } from '../../events/structured.js';
import { createStreamState } from '../../events/adapters.js';
import type { BackgroundTurnOutcome, VendorBackgroundTurn } from '../background-turn.js';
import type { AiLocalHarnessDefinition } from '../../definition.js';

type Json = Record<string, unknown>;
const records = readFileSync(join(__dirname, 'fixtures', 'claude-background-bash.jsonl'), 'utf8')
  .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Json);
const firstResult = records.findIndex((record) => record.type === 'result') + 1;
const taskId = records.find((record) => record.subtype === 'task_started')?.task_id as string;
const claude = { command: 'claude', parser: 'claude-stream-json' } as unknown as AiLocalHarnessDefinition;

/** Stand-in claude: the head up to the first result at once, the rest after
 * `delayMs` (never, when null) unless stdin closed first; exits when stdin ends. */
const vendor = (delayMs: number | null): string[] => {
  const head = records.slice(0, firstResult).map((record) => JSON.stringify(record));
  const tail = records.slice(firstResult).map((record) => JSON.stringify(record));
  return ['-e', `
    const head = ${JSON.stringify(head)}, tail = ${JSON.stringify(tail)}, delay = ${JSON.stringify(delayMs)};
    let started = false, closed = false;
    process.stdin.on('data', () => { if (started) return; started = true; head.forEach((l) => console.log(l));
      if (delay !== null) setTimeout(() => { if (closed) return; delivered = true; tail.forEach((l) => console.log(l)); }, delay); });
    // As claude does when its input ends: running tasks are killed, and said so.
    let delivered = false;
    process.stdin.on('end', () => { closed = true;
      if (!delivered) console.log(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: ${JSON.stringify(taskId)}, status: 'killed' }));
      setTimeout(() => process.exit(0), 20); });
    process.stdin.resume();`];
};

/** The turn loop's side, as the vendor turn wires it. */
async function runTurn(sessionId: string, delayMs: number | null) {
  const input = createTurnInput();
  const idle = createTurnIdleController();
  const release = createTurnRelease();
  const turns: VendorBackgroundTurn[] = [];
  let held: HeldVendor | undefined;
  const background = createBackgroundWait({ onSettled: () => input.end(), onQuiet: () => held?.quiet() });
  const streams = new WeakMap<object, ReturnType<typeof createStreamState>>();
  const started = Date.now();
  const output = await captureNativeHarnessTurn(
    { command: 'fixture', binary: process.execPath, displayName: 'Fixture' }, vendor(delayMs), {}, {
      stdinText: streamJsonUserMessage('go'), input, idleController: idle, idleTimeoutMs: 10_000, release,
      onStdoutLine: (line) => {
        const record = JSON.parse(line) as Json;
        if (held) { held.line(line, record); return; }
        background.note(record);
        if (record.type === 'result' && record.is_error !== true && background.pending > 0 && background.quiet) {
          held = holdVendorProcess({
            sessionId, background, release, endInput: () => input.end(), handler: (turn) => { turns.push(turn); },
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
});
