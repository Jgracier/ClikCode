/** How many background agents a vendor says are still running, from the wire
 * shapes it publishes (docs/TURN_FLOW_STANDARD.md section 10). */
import { describe, expect, it } from 'vitest';
import { backgroundAgentCount } from './background-agents.js';
import { createStreamState } from '../events/adapters.js';
import { reportStructuredLine } from '../events/structured.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

describe('backgroundAgentCount', () => {
  it('counts the live local_agent tasks of a background_tasks_changed level signal (SDKBackgroundTasksChangedMessage)', () => {
    expect(backgroundAgentCount({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 'a', task_type: 'local_agent', description: 'review' },
      { task_id: 'b', task_type: 'local_agent', description: 'tests' },
      { task_id: 'c', task_type: 'local_bash', description: 'dev server' },
      { task_id: 'd', task_type: 'local_agent', description: 'housekeeping', ambient: true },
    ] })).toBe(2);
  });

  it('an empty level is zero, not unknown', () => {
    expect(backgroundAgentCount({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })).toBe(0);
  });

  it('reads the turn_duration the CLI records at a turn\'s end (pendingBackgroundAgentCount)', () => {
    expect(backgroundAgentCount({ type: 'system', subtype: 'turn_duration', durationMs: 1200, messageCount: 4, pendingBackgroundAgentCount: 3 })).toBe(3);
    expect(backgroundAgentCount({ type: 'system', subtype: 'turn_duration', durationMs: 1200, messageCount: 4 })).toBeUndefined();
  });

  it('says nothing for any other record', () => {
    expect(backgroundAgentCount({ type: 'assistant', message: { content: [] } })).toBeUndefined();
    expect(backgroundAgentCount({ type: 'system', subtype: 'task_started', task_id: 'a' })).toBeUndefined();
  });
});

describe('the structured-CLI line reader', () => {
  it('reports the count through the observer', () => {
    const counts: number[] = [];
    const harness = { command: 'claude', parser: 'claude-stream-json', turn: { output: 'json-lines' } } as unknown as AiLocalHarnessDefinition;
    const state = createStreamState();
    reportStructuredLine(harness, JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a', task_type: 'local_agent', description: 'x' }] }),
      { onBackgroundAgents: (count) => counts.push(count) }, state);
    expect(counts).toEqual([1]);
  });
});
