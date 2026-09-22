import { describe, expect, it } from 'vitest';
import { parseNativeActivityEventsFromValue } from './activity-events.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';

/**
 * Antigravity tool rows must say what the tool did, not just its name.
 *
 * tools.ts asserted this harness "carries step.tool_name and no input", so
 * the parser read only the name and every tool row rendered as a bare
 * "run_command" with nothing to identify it. The records below are verbatim
 * from agy 1.2.7 answering "run the shell command 'cat sample.txt'" -- the
 * parameters were on the stream the whole time.
 */
const antigravity = localHarnessForCommand('antigravity')!;

describe('antigravity tool rows carry their parameters', () => {
  it('shows the command a run_command actually ran', () => {
    const [event] = parseNativeActivityEventsFromValue(antigravity, {
      event: 'step_update',
      step_update: {
        conversation_id: '956b862b', step_index: 2, state: 'ACTIVE', step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'cat sample.txt' } },
      },
    });
    expect(event?.label).toBe('run_command(cat sample.txt)');
    expect(event?.kind).toBe('tool-start');
    expect(event?.category).toBe('run');
  });

  it('shows the path a view_file actually read', () => {
    const [event] = parseNativeActivityEventsFromValue(antigravity, {
      event: 'step_update',
      step_update: {
        step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'view_file',
        tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/agtool/sample.txt' } },
      },
    });
    expect(event?.label).toBe('view_file(/tmp/agtool/sample.txt)');
    expect(event?.kind).toBe('tool-done');
    expect(event?.category).toBe('read');
  });

  it('falls back to the bare name when a tool really has no useful parameter', () => {
    const [event] = parseNativeActivityEventsFromValue(antigravity, {
      event: 'step_update',
      step_update: {
        step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'manage_task',
        tool_info: { name: 'manage_task', parameters: { Action: 'status', TaskId: 'x/task-4' } },
      },
    });
    // Neither Action nor TaskId identifies anything a reader can act on, so
    // the name alone is the honest label rather than a confident-looking
    // "manage_task(status)".
    expect(event?.label).toBe('manage_task');
  });

  it('still handles a tool step with no tool_info at all', () => {
    const [event] = parseNativeActivityEventsFromValue(antigravity, {
      event: 'step_update',
      step_update: { step_index: 5, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' },
    });
    expect(event?.label).toBe('run_command');
  });
});
