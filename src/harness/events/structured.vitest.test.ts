/** The structured CLI reports through the same contract as everything else.
 *
 * It used to be the one transport with no contract at all: its lines were
 * parsed inside the turn loop and dispatched straight at the terminal from
 * there, so what a harness could report was whatever that one callback
 * happened to handle. Twelve of the twenty-four catalogued harnesses use this
 * transport, which made it the largest gap in what the UI could rely on. */
import { describe, expect, it } from 'vitest';
import { reportStructuredLine } from './structured';
import { createStreamState } from './adapters';
import type { HarnessTurnObserver } from './turn-observer';
import type { AiLocalHarnessDefinition } from '../definition';

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
    const outcome = reportStructuredLine(harness, line, observer, createStreamState());
    expect(calls, 'the answer never reached the observer').toContain('text:hello');
    expect(outcome.live, 'an answer should confirm the session is live').toBe(true);
  });

  it('says nothing for a line it does not recognise', () => {
    const { calls, observer } = record();
    const outcome = reportStructuredLine(harness, 'not json at all', observer, createStreamState());
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

  it('says when the vendor closed its turn, and how', () => {
    const { observer } = record();
    // Captured from claude 2.1.281, Amp and Antigravity (trimmed).
    expect(reportStructuredLine(harness, '{"type":"result","subtype":"success","is_error":false,"result":"started"}', observer, createStreamState()).result).toBe('success');
    expect(reportStructuredLine(harness, '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["402"]}', observer, createStreamState()).result).toBe('error');
    const agy = { command: 'antigravity', parser: 'antigravity' } as unknown as AiLocalHarnessDefinition;
    expect(reportStructuredLine(agy, '{"event":"result","result":{"status":"SUCCESS","response":"started"}}', observer, createStreamState()).result).toBe('success');
    expect(reportStructuredLine(agy, '{"event":"result","result":{"status":"ERROR","error":"API error"}}', observer, createStreamState()).result).toBe('error');
    expect(reportStructuredLine(harness, '{"type":"assistant","message":{"content":[]}}', observer, createStreamState()).result).toBeUndefined();
  });
});

describe('a structured CLI\'s todo list', () => {
  it('reaches the observer as the plan, but a sub-agent\'s own list does not', async () => {
    const { reportStructuredLine } = await import('./structured.js');
    const plans: unknown[] = [];
    const observer = { onPlan: (entries: unknown) => plans.push(entries) } as never;
    const line = (parent: string | null) => JSON.stringify({
      type: 'assistant', parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: [{ content: 'step', status: 'in_progress' }] } }] },
    });
    const harness = { command: 'claude', parser: 'claude-stream-json', turn: { output: 'json-lines' } } as never;
    reportStructuredLine(harness, line(null), observer, createStreamState());
    reportStructuredLine(harness, line('toolu_parent'), observer, createStreamState());
    expect(plans).toEqual([[{ content: 'step', status: 'in_progress' }]]);
  });
});
