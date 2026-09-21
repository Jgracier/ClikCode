import { describe, expect, it } from 'vitest';
import { parseNativeActivityEvent } from './activity-events';
import { renderActivityLine } from './activity-line';
import { codex } from './vendor-fixtures.vitest';

describe('incremental native tool activity', () => {
  it('retains Codex tool identity and bounded completion output', () => {
    const event = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed',
      item: { id: 'call-1', type: 'command_execution', command: 'git status', aggregated_output: 'one\ntwo\nthree\nfour' },
    }));
    expect(event).toEqual({ kind: 'tool-done', label: 'git status', id: 'call-1', output: ['one', 'two', 'three', '… 1 more line'] });
    // Summary plus the captured output: a row shows enough of the command's
    // result to recognise it without opening anything.
    expect(renderActivityLine(event!)).toHaveLength(5);
  });

  it('renders failed command completions as failures rather than green done events', () => {
    const event = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed',
      item: { id: 'call-failed', type: 'command_execution', command: 'pnpm test', exit_code: 1 },
    }));
    expect(event).toEqual({ kind: 'tool-error', label: 'pnpm test', id: 'call-failed' });
    expect(renderActivityLine(event!)[0]!.replace(/\u001b\[[0-9;]*m/g, '')).toContain('failed');
  });

  it('pairs Claude tool starts and partial results by tool-use id', () => {
    const start = parseNativeActivityEvent({ ...codex, command: 'claude' }, JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } }] },
    }));
    const done = parseNativeActivityEvent({ ...codex, command: 'claude' }, JSON.stringify({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'clean' }] },
    }));
    // The target belongs in the label: a bare `Bash` says nothing about what
    // ran, and the command is right there in the call's input.
    expect(start).toMatchObject({ kind: 'tool-start', label: 'Bash(git status)', id: 'tool-1' });
    expect(done).toEqual({ kind: 'tool-done', label: 'tool', id: 'tool-1', output: ['clean'] });
  });

  it('pairs generic structured tool events by their native item id', () => {
    const start = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.started', item: { id: 'call-2', type: 'mcp_tool_call', name: 'search' },
    }));
    const done = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed', item: { id: 'call-2', type: 'mcp_tool_call', name: 'search' },
    }));
    expect(start).toEqual({ kind: 'tool-start', label: 'search', category: 'search', id: 'call-2' });
    expect(done).toEqual({ kind: 'tool-done', label: 'search', category: 'search', id: 'call-2' });
  });

  it('pairs generic file changes instead of creating a detached completion row', () => {
    const start = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.started', item: { id: 'edit-1', type: 'file_change' },
    }));
    const done = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed', item: { id: 'edit-1', type: 'file_change' },
    }));
    expect(start).toEqual({ kind: 'tool-start', label: 'files updated', id: 'edit-1' });
    expect(done).toEqual({ kind: 'tool-done', label: 'files updated', id: 'edit-1' });
  });

  it('does not put raw structured command output into the human activity feed', () => {
    const event = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed',
      item: { id: 'call-3', type: 'command_execution', command: 'inspect', aggregated_output: '{"ok":true}' },
    }));
    expect(event).toEqual({ kind: 'tool-done', label: 'inspect', id: 'call-3' });
  });
});
