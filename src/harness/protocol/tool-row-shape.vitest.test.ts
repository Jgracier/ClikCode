import { describe, expect, it } from 'vitest';
import { formatToolRow, toolLabel } from './tools.js';
import { parseNativeActivityEventsFromValue } from './activity-events.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';

/**
 * One tool-row shape, whichever harness produced the event.
 *
 * These had drifted into four: `name(detail)`, a bare detail with no name,
 * `name` alone, and a hand-built `name(description)` that repeated the
 * formatting inline and only applied while the tool was still running. The
 * same action looked different depending on which vendor ran it, and an ACP
 * tool that FAILED -- the one most worth identifying -- lost its arguments
 * entirely.
 */
describe('formatToolRow is the single shape', () => {
  it('renders name(detail) when there is a detail', () => {
    expect(formatToolRow('Bash', 'cat x.txt')).toBe('Bash(cat x.txt)');
  });

  it('renders a bare name when the detail is empty or absent', () => {
    expect(formatToolRow('manage_task')).toBe('manage_task');
    expect(formatToolRow('manage_task', '   ')).toBe('manage_task');
  });

  it('takes only the first line, so a multi-line command cannot break the row', () => {
    expect(formatToolRow('Bash', 'echo one\necho two')).toBe('Bash(echo one)');
  });

  it('caps the detail so one long command cannot push the row off screen', () => {
    const row = formatToolRow('Bash', 'x'.repeat(500));
    expect(row.length).toBeLessThan(90);
  });

  it('is what toolLabel produces, so input-driven and detail-driven agree', () => {
    expect(toolLabel('Bash', { command: 'cat x.txt' })).toBe(formatToolRow('Bash', 'cat x.txt'));
  });
});

describe('different vendors, same shape', () => {
  const goose = localHarnessForCommand('goose')!;
  // Goose's own Message serialization, per the parser's own doc comment:
  // { type:'message', message:{ content:[ {type:'toolRequest', toolCall:{status, value:{name, arguments}}} ] } }
  const gooseMessage = (status: string | undefined, args: Record<string, unknown>) => ({
    type: 'message',
    message: {
      content: [{
        type: 'toolRequest', id: 't1',
        toolCall: { ...(status ? { status } : {}), value: { name: 'developer__shell', arguments: args } },
      }],
    },
  });

  it('renders a vendor-prefixed tool name the same way antigravity does', () => {
    const [ag] = parseNativeActivityEventsFromValue(localHarnessForCommand('antigravity')!, {
      event: 'step_update',
      step_update: {
        step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command',
        tool_info: { parameters: { CommandLine: 'cat x.txt' } },
      },
    });
    const [gs] = parseNativeActivityEventsFromValue(goose, gooseMessage(undefined, { command: 'cat x.txt' }));
    expect(ag?.label).toBe('run_command(cat x.txt)');
    expect(gs?.label).toBe('developer__shell(cat x.txt)');
    // Different vendors, different tool names, identical SHAPE.
    const shape = (label?: string): string => (label ?? '').replace(/^[^(]+/, 'NAME');
    expect(shape(gs?.label)).toBe(shape(ag?.label));
  });

  it('a tool that failed keeps the detail a running one showed', () => {
    const running = parseNativeActivityEventsFromValue(goose, gooseMessage(undefined, { command: 'cat missing.txt' }))[0];
    const failed = parseNativeActivityEventsFromValue(goose, gooseMessage('error', { command: 'cat missing.txt' }))[0];
    expect(running?.kind).toBe('tool-start');
    expect(failed?.kind).toBe('tool-error');
    // The regression this guards: the error branch used `label: name` while
    // the start branch used toolLabel(name, args), so a FAILING call -- the
    // one most worth identifying -- lost the argument saying which it was.
    expect(failed?.label).toBe(running?.label);
    expect(failed?.label).toBe('developer__shell(cat missing.txt)');
  });
});
