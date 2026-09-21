/** The structured CLI reports through the same contract as everything else.
 *
 * It used to be the one transport with no contract at all: its lines were
 * parsed inside the turn loop and dispatched straight at the terminal from
 * there, so what a harness could report was whatever that one callback
 * happened to handle. Twelve of the twenty-four catalogued harnesses use this
 * transport, which made it the largest gap in what the UI could rely on. */
import { describe, expect, it } from 'vitest';
import { reportStructuredLine } from './structured';
import type { HarnessTurnObserver } from './turn-observer';
import type { AiLocalHarnessDefinition } from '../types';

const harness = { command: 'claude', parser: 'claude-stream-json' } as unknown as AiLocalHarnessDefinition;

const record = (): { calls: string[]; observer: HarnessTurnObserver } => {
  const calls: string[] = [];
  return {
    calls,
    observer: {
      onSessionId: (id) => { calls.push(`session:${id}`); },
      onResponseDelta: (text) => { calls.push(`text:${text.trim()}`); },
      onActivity: (event) => { calls.push(`activity:${event.kind}`); },
      onPhase: (phase) => { calls.push(`phase:${phase}`); },
      onUsage: () => { calls.push('usage'); },
      onAvailableCommands: (commands) => { calls.push(`commands:${commands.length}`); },
    },
  };
};

describe('a structured CLI line', () => {
  it('reports an answer through the observer', () => {
    const { calls, observer } = record();
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
    const outcome = reportStructuredLine(harness, line, observer);
    expect(calls, 'the answer never reached the observer').toContain('text:hello');
    expect(outcome.live, 'an answer should confirm the session is live').toBe(true);
  });

  it('says nothing for a line it does not recognise', () => {
    const { calls, observer } = record();
    const outcome = reportStructuredLine(harness, 'not json at all', observer);
    expect(calls).toEqual([]);
    expect(outcome.live).toBe(false);
  });

  it('leaves the caller its own bookkeeping rather than doing it', () => {
    // Nothing here touches a checkpoint, a timer or a session record: those
    // come back in the outcome for the turn loop to do.
    const source = reportStructuredLine.toString();
    for (const forbidden of ['checkpoint', 'activeTerminalHarness', 'session.']) {
      expect(source, `the line reporter reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });
});
