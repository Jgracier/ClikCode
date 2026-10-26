/** How many background agents a vendor says are still running, from the wire
 * shapes it publishes (docs/TURN_FLOW_STANDARD.md section 10). */
import { describe, expect, it } from 'vitest';
import { backgroundWork, mergeBackgroundWork, backgroundWorkOf } from './background-agents.js';
import { createStreamState } from '../events/adapters.js';
import { reportStructuredLine } from '../events/structured.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('backgroundWork: agents', () => {
  it('counts the live local_agent tasks of a background_tasks_changed level signal (SDKBackgroundTasksChangedMessage)', () => {
    expect(backgroundWork({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 'a', task_type: 'local_agent', description: 'review' },
      { task_id: 'b', task_type: 'local_agent', description: 'tests' },
      { task_id: 'c', task_type: 'local_bash', description: 'dev server' },
      { task_id: 'd', task_type: 'local_agent', description: 'housekeeping', ambient: true },
    ] })?.agents).toBe(2);
  });

  it('an empty level is zero, not unknown', () => {
    expect(backgroundWork({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })?.agents).toBe(0);
  });

  it('reads the turn_duration the CLI records at a turn\'s end (pendingBackgroundAgentCount)', () => {
    expect(backgroundWork({ type: 'system', subtype: 'turn_duration', durationMs: 1200, messageCount: 4, pendingBackgroundAgentCount: 3 })?.agents).toBe(3);
    expect(backgroundWork({ type: 'system', subtype: 'turn_duration', durationMs: 1200, messageCount: 4 })).toBeUndefined();
  });

  it('says nothing for any other record', () => {
    expect(backgroundWork({ type: 'assistant', message: { content: [] } })).toBeUndefined();
    expect(backgroundWork({ type: 'system', subtype: 'task_started', task_id: 'a' })).toBeUndefined();
  });
});

describe('backgroundWork: the three kinds of background work', () => {
  const level = (...tasks: Array<Record<string, unknown>>) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });

  it('splits one level into agents, terminals and workflows, as Claude Code counts them', () => {
    expect(backgroundWork(level(
      { task_id: 'a', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'review' },
      { task_id: 'b', task_type: 'local_bash', description: 'npm run dev' },
      { task_id: 'c', task_type: 'local_workflow', description: 'spec' },
      { task_id: 'd', task_type: 'local_agent', description: 'tests' },
    ))).toEqual({ agents: 2, agentTasks: [{ id: 'a', label: 'review' }, { id: 'd', label: 'tests' }], terminals: 1, workflows: 1 });
  });

  it('leaves out what Claude Code leaves out: monitors, ambient tasks, teammates, the backgrounded main session, a shell an agent owns', () => {
    expect(backgroundWork(level(
      { task_id: 'm1', task_type: 'monitor_mcp', description: 'watch' },
      { task_id: 'm2', task_type: 'monitor_ws', description: 'socket' },
      { task_id: 'h', task_type: 'local_agent', description: 'housekeeping', ambient: true },
      { task_id: 't', task_type: 'in_process_teammate', description: 'teammate' },
      { task_id: 'main', task_type: 'local_agent', subagent_type: 'main-session', description: 'main' },
      { task_id: 'owned', task_type: 'local_bash', description: 'an agent\'s shell', parent_task_id: 'a' },
    ))).toEqual({ agents: 0, terminals: 0, workflows: 0 });
  });

  it('an empty level is all zeros, not unknown', () => {
    expect(backgroundWork(level())).toEqual({ agents: 0, terminals: 0, workflows: 0 });
  });

  it('a task that finished but was not yet announced is not in the live level; the turn_duration carries it', () => {
    // The level lists running tasks only: an agent that completed and has not
    // been notified to the model is counted by the end record, not here.
    expect(backgroundWork(level())).toMatchObject({ agents: 0 });
    expect(backgroundWork({ type: 'system', subtype: 'turn_duration', durationMs: 5, messageCount: 2, pendingBackgroundAgentCount: 1 })).toEqual({ agents: 1, workflows: 0 });
  });

  it('turn_duration carries agents and workflows, never terminals; absent from both says nothing', () => {
    expect(backgroundWork({ type: 'system', subtype: 'turn_duration', durationMs: 5, messageCount: 2, pendingBackgroundAgentCount: 2, pendingWorkflowCount: 1 })).toEqual({ agents: 2, workflows: 1 });
    expect(backgroundWork({ type: 'system', subtype: 'turn_duration', durationMs: 5, messageCount: 2, pendingWorkflowCount: 1 })).toEqual({ agents: 0, workflows: 1 });
    expect(backgroundWork({ type: 'system', subtype: 'turn_duration', durationMs: 5, messageCount: 2 })).toBeUndefined();
    expect(backgroundWork({ type: 'result' })).toBeUndefined();
  });

  it('a partial update replaces only the kinds it names; zeros are dropped; old data (pendingBackground alone) reads as agents', () => {
    expect(mergeBackgroundWork({ agents: 2, terminals: 1 }, { agents: 0, workflows: 1 })).toEqual({ terminals: 1, workflows: 1 });
    expect(mergeBackgroundWork(undefined, { agents: 0, terminals: 0, workflows: 0 })).toBeUndefined();
    expect(backgroundWorkOf({ pendingBackground: 3 })).toEqual({ agents: 3 });
    expect(backgroundWorkOf({ pendingBackground: 3, background: { agents: 3, workflows: 1 } })).toEqual({ agents: 3, workflows: 1 });
    expect(backgroundWorkOf({})).toBeUndefined();
    expect(mergeBackgroundWork({ agents: 2, agentTasks: [{ id: 'a', label: 'review' }, { id: 'b', label: 'tests' }] }, { terminals: 1 })?.agentTasks).toHaveLength(2);
    expect(mergeBackgroundWork({ agents: 2, agentTasks: [{ id: 'a', label: 'review' }, { id: 'b', label: 'tests' }] }, { agents: 1 })?.agentTasks).toBeUndefined();
  });
});

describe('the structured-CLI line reader', () => {
  it('reports the count through the observer', () => {
    const counts: number[] = [];
    const harness = { command: 'claude', parser: 'claude-stream-json', turn: { output: 'json-lines' } } as unknown as AiLocalHarnessDefinition;
    const state = createStreamState();
    reportStructuredLine(harness, JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a', task_type: 'local_agent', description: 'x' }] }),
      { onBackgroundWork: (work) => counts.push(work.agents ?? -1) }, state);
    expect(counts).toEqual([1]);
  });
});

describe('recorded vendor streams (src/harness/transport/native/fixtures)', () => {
  const fixture = (name: string): Array<Record<string, unknown>> =>
    readFileSync(join(__dirname, '..', 'transport', 'native', 'fixtures', `${name}.jsonl`), 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const play = (name: string, harness: { command: string; parser: string }) => {
    const seen: Array<Record<string, number | undefined>> = [];
    const state = createStreamState();
    for (const record of fixture(name)) {
      reportStructuredLine(harness as unknown as AiLocalHarnessDefinition, JSON.stringify(record), { onBackgroundWork: (work) => seen.push({ ...work }) }, state);
    }
    return seen;
  };

  it('claude: a backgrounded Bash is a terminal, and its end clears it (claude 2.1.281 recording)', () => {
    expect(play('claude-background-bash', { command: 'claude', parser: 'claude-stream-json' }).map((work) => work.terminals))
      .toEqual([1, 0]);
  });

  it('claude: a background agent is an agent, not a terminal (claude 2.1.281 recording)', () => {
    const seen = play('claude-background-agent', { command: 'claude', parser: 'claude-stream-json' });
    expect(seen.map((work) => [work.agents, work.terminals])).toEqual([[1, 0], [0, 0]]);
  });

  it("claude: a background Agent's row runs from its launch until task_notification, not just the launch call (claude 2.1.281 recording)", () => {
    const state = createStreamState();
    const harness = { command: 'claude', parser: 'claude-stream-json' } as unknown as AiLocalHarnessDefinition;
    const rows: Array<[string, number | undefined, number | undefined]> = [];
    for (const record of fixture('claude-background-agent')) {
      reportStructuredLine(harness, JSON.stringify(record), {
        onActivity: (event) => { if (event.agent && event.id === 'toolu_013yyax3JAMzifVzKLgUP5DF') rows.push([event.kind, event.childTools, event.durationMs]); },
      }, state);
    }
    // Launch, identity link, progress, and only the notification settles it.
    expect(rows.map(([kind]) => kind)).toEqual(['tool-start', 'tool-start', 'tool-start', 'tool-done']);
    expect(rows.at(-1)![2]).toBe(11067);
    expect(state.agentRows.size).toBe(0);
  });

  it('cursor: a background shell is a terminal from its call to its task_notification (cursor-agent 2026.09 recording)', () => {
    const seen = play('cursor-background-shell', { command: 'cursor-agent', parser: 'cursor-stream-json' });
    expect(seen).toEqual([{ terminals: 1 }, { terminals: 0 }]);
  });
});
