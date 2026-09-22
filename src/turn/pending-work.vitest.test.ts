import { beforeEach, describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { parseNativeActivityEvent } from '../harness/protocol/activity-events';
import {
  createPendingWorkTracker, forgetToolPairingEvidence,
  MAX_PENDING_CONTINUATIONS, pendingContinuationDelayMs,
} from './pending-work';

describe('pending work tracker', () => {
  beforeEach(() => { forgetToolPairingEvidence(); });

  it('reports nothing for a harness never seen to settle a tool', () => {
    // The whole hazard of acting on an absent completion: a parser that
    // reports no completions at all would otherwise look permanently
    // mid-wait and earn a continuation on every single turn.
    const tracker = createPendingWorkTracker('mystery');
    tracker.note({ kind: 'tool-start', id: 'a' });
    tracker.note({ kind: 'tool-start', id: 'b' });
    expect(tracker.outstanding).toBe(0);
  });

  it('reports an unmatched start once the harness has proven it pairs', () => {
    const tracker = createPendingWorkTracker('antigravity');
    tracker.note({ kind: 'tool-start', id: 'first' });
    tracker.note({ kind: 'tool-done', id: 'first' });
    expect(tracker.outstanding).toBe(0);
    // The real shape: a backgrounded command left in ACTIVE, never settled.
    tracker.note({ kind: 'tool-start', id: 'backgrounded' });
    expect(tracker.outstanding).toBe(1);
  });

  it('keeps the pairing evidence across turns, since the backgrounding turn often runs no other tool', () => {
    // Antigravity's stuck turn ran exactly one tool and abandoned it, so
    // evidence gathered only within that turn would never be enough.
    const earlier = createPendingWorkTracker('antigravity');
    earlier.note({ kind: 'tool-start', id: 'x' });
    earlier.note({ kind: 'tool-done', id: 'x' });

    const stuck = createPendingWorkTracker('antigravity');
    stuck.note({ kind: 'tool-start', id: 'only' });
    expect(stuck.outstanding).toBe(1);
  });

  it('settles an unpaired completion rather than leaving a start armed', () => {
    const tracker = createPendingWorkTracker('claude');
    tracker.note({ kind: 'tool-done', id: 'never-started' });
    tracker.note({ kind: 'tool-start' });
    tracker.note({ kind: 'tool-error' });
    expect(tracker.outstanding).toBe(0);
  });

  it('ignores events that are not tool lifecycle', () => {
    const tracker = createPendingWorkTracker('codex');
    tracker.note({ kind: 'tool-start', id: 'a' });
    tracker.note({ kind: 'tool-done', id: 'a' });
    tracker.note({ kind: 'thinking' });
    tracker.note(undefined);
    expect(tracker.outstanding).toBe(0);
  });

  it('does not let a failover retry inherit the abandoned starts it replaced', () => {
    const tracker = createPendingWorkTracker('antigravity');
    tracker.note({ kind: 'tool-start', id: 'a' });
    tracker.note({ kind: 'tool-done', id: 'a' });
    tracker.note({ kind: 'tool-start', id: 'lost-with-the-exhausted-account' });
    expect(tracker.outstanding).toBe(1);
    tracker.reset();
    expect(tracker.outstanding).toBe(0);
  });

  it('backs off between continuations and stays bounded', () => {
    expect(MAX_PENDING_CONTINUATIONS).toBe(3);
    const delays = Array.from({ length: MAX_PENDING_CONTINUATIONS }, (_, i) => pendingContinuationDelayMs(i));
    expect(delays).toEqual([2_000, 8_000, 20_000]);
    // Monotonic, so a slow command is not hammered at a fixed interval.
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
  });

  it('detects a backgrounded antigravity command from its real stream lines', () => {
    // Verbatim from a live reproduction against agy: a tool step reported
    // ACTIVE twice and never DONE, while the CLI printed "terminating 1
    // background task(s) on exit" and left. The duplicate ACTIVE must count
    // as ONE outstanding tool, which is what step_index-as-id buys.
    const antigravity = localHarnessForCommand('antigravity')!;
    const tracker = createPendingWorkTracker('antigravity');
    const step = (index: number, state: string, tool: string, parameters: unknown) =>
      JSON.stringify({ event: 'step_update', step_update: {
        step_index: index, state, step_type: 'tool', tool_name: tool,
        tool_info: { name: tool, parameters },
      } });
    const lines = [
      // An earlier tool that did settle: the proof this harness pairs at all.
      step(2, 'ACTIVE', 'view_file', { AbsolutePath: '/tmp/x' }),
      step(2, 'DONE', 'view_file', { AbsolutePath: '/tmp/x' }),
      // The backgrounded command, reported twice, never settled.
      step(3, 'ACTIVE', 'run_command', { CommandLine: "bash -c 'sleep 20; echo LATE'" }),
      step(3, 'ACTIVE', 'run_command', { CommandLine: "bash -c 'sleep 20; echo LATE'" }),
    ];
    for (const line of lines) tracker.note(parseNativeActivityEvent(antigravity, line));
    expect(tracker.outstanding).toBe(1);
  });

  it('gives an antigravity tool event its step_index as id', () => {
    const antigravity = localHarnessForCommand('antigravity')!;
    const event = parseNativeActivityEvent(antigravity, JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 7, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } },
    }));
    expect(event?.id).toBe('step-7');
    expect(event?.kind).toBe('tool-start');
  });
});
