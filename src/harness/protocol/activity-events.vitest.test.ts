import { changed } from '../../agent/line-diff.test-support.js';
import { describe, expect, it } from 'vitest';
import { parseNativeActivityEventsFromValue } from './activity-events';
import type { AiLocalHarnessDefinition } from '../definition';
import { renderActivityLine } from './activity-line';
import { codex } from './vendor-fixtures.vitest';

/** The first activity one stdout line describes. */
const parseNativeActivityEvent = (harness: AiLocalHarnessDefinition, line: string) => parseNativeActivityEventsFromValue(harness, JSON.parse(line))[0];

describe('incremental native tool activity', () => {
  it('retains Codex tool identity and bounded completion output', () => {
    const event = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed',
      item: { id: 'call-1', type: 'command_execution', command: 'git status', aggregated_output: 'one\ntwo\nthree\nfour' },
    }));
    // The whole output is carried (it is short); the row decides what shows.
    expect(event).toEqual({ kind: 'tool-done', label: '$ git status', category: 'run', id: 'call-1', output: ['one', 'two', 'three', 'four'] });
    // A command shows its LAST lines, the earlier ones counted above them --
    // the result of a command is at its end.
    const rows = renderActivityLine(event!).map((row) => row.replace(/\u001b\[[0-9;]*m/g, '').trim());
    expect(rows.slice(1)).toEqual(['… 1 earlier line', 'two', 'three', 'four']);
  });

  it('renders failed command completions as failures rather than green done events', () => {
    const event = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed',
      item: { id: 'call-failed', type: 'command_execution', command: 'pnpm test', exit_code: 1 },
    }));
    expect(event).toEqual({ kind: 'tool-error', label: '$ pnpm test', category: 'run', id: 'call-failed', exitCode: 1 });
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
    expect(start).toMatchObject({ kind: 'tool-start', label: '$ git status', id: 'tool-1' });
    expect(done).toEqual({ kind: 'tool-done', label: 'tool', id: 'tool-1', output: ['clean'] });
  });

  it('pairs generic structured tool events by their native item id', () => {
    const start = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.started', item: { id: 'call-2', type: 'mcp_tool_call', name: 'search' },
    }));
    const done = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed', item: { id: 'call-2', type: 'mcp_tool_call', name: 'search' },
    }));
    expect(start).toEqual({ kind: 'tool-start', label: 'Search', category: 'search', id: 'call-2' });
    expect(done).toEqual({ kind: 'tool-done', label: 'Search', category: 'search', id: 'call-2' });
  });

  it('pairs generic file changes instead of creating a detached completion row', () => {
    const start = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.started', item: { id: 'edit-1', type: 'file_change' },
    }));
    const done = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed', item: { id: 'edit-1', type: 'file_change' },
    }));
    expect(start).toEqual({ kind: 'tool-start', label: 'Edit files', category: 'edit', id: 'edit-1' });
    expect(done).toEqual({ kind: 'tool-done', label: 'Edit files', category: 'edit', id: 'edit-1' });
  });

  it('does not put raw structured command output into the human activity feed', () => {
    const event = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed',
      item: { id: 'call-3', type: 'command_execution', command: 'inspect', aggregated_output: '{"ok":true}' },
    }));
    expect(event).toEqual({ kind: 'tool-done', label: '$ inspect', category: 'run', id: 'call-3' });
  });

  it('treats a Codex collab call as a sub-agent rather than an unnamed tool', () => {
    const event = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.started',
      item: { id: 'agent-1', type: 'collab_agent_tool_call', tool: 'followup_task', prompt: 'check the build' },
    }));
    expect(event).toEqual({ kind: 'tool-start', label: 'Agent check the build', agent: true, id: 'agent-1' });
  });

  it('shows the paths and the diff of a file change', () => {
    const event = parseNativeActivityEvent(codex, JSON.stringify({
      type: 'item.completed',
      item: { id: 'edit-2', type: 'file_change', changes: [{ path: 'src/a.ts', diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old line\n+new line\n' }, { path: 'src/b.ts' }] },
    }));
    expect(event).toMatchObject({ kind: 'tool-done', label: 'Edit src/a.ts, src/b.ts', category: 'edit', id: 'edit-2' });
    expect(event!.diff).toEqual([{ path: 'src/a.ts', additions: 1, removals: 1, lines: [{ kind: 'removed', text: 'old line', line: 1 }, { kind: 'added', text: 'new line', line: 1 }] }]);
  });

  it('renders a Claude edit as the lines that changed, not both texts whole', () => {
    const event = parseNativeActivityEvent({ ...codex, command: 'claude' }, JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: 'a.ts', old_string: 'one\ntwo\nthree', new_string: 'one\n2\nthree' } }] },
    }));
    expect(event).toMatchObject({ label: 'Edit a.ts' });
    expect(changed(event!.diff)).toEqual({ removed: ['two'], added: ['2'] });
  });
});
