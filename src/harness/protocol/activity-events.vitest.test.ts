import { changed } from '../../agent/line-diff.test-support.js';
import { describe, expect, it } from 'vitest';
import { activityOutput, parseNativeActivityEventsFromValue } from './activity-events';
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
    // Kept whole, short output shows whole; a long one shows its first lines
    // and its last -- what it set out to do and how it ended -- the middle
    // counted between them (Grok, Cursor).
    const plain = (rows: string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, '').trim());
    expect(plain(renderActivityLine(event!)).slice(1)).toEqual(['one', 'two', 'three', 'four']);
    const long = { ...event!, output: Array.from({ length: 9 }, (_, index) => `line ${index + 1}`) };
    expect(plain(renderActivityLine(long)).slice(1)).toEqual(['line 1', 'line 2', '… 4 lines hidden', 'line 7', 'line 8', 'line 9']);
    // Cut to its tail by the producer, its first kept line is mid-stream: the
    // end is shown, the earlier lines counted above it.
    expect(plain(renderActivityLine({ ...long, outputOmitted: 20, outputTail: true })).slice(1)).toEqual(['… 26 earlier lines', 'line 7', 'line 8', 'line 9']);
    // Unless the producer kept its head as well, as activityOutput does.
    const cut = { ...event!, ...activityOutput(Array.from({ length: 30 }, (_, index) => `step ${index + 1}`).join('\n'), { tail: true }) };
    expect(cut.outputHead).toEqual(['step 1', 'step 2']);
    expect(plain(renderActivityLine(cut)).slice(1)).toEqual(['step 1', 'step 2', '… 25 lines hidden', 'step 28', 'step 29', 'step 30']);
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
    const start = parseNativeActivityEvent({ ...codex, command: 'claude', parser: 'claude-stream-json' }, JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } }] },
    }));
    const done = parseNativeActivityEvent({ ...codex, command: 'claude', parser: 'claude-stream-json' }, JSON.stringify({
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
    const event = parseNativeActivityEvent({ ...codex, command: 'claude', parser: 'claude-stream-json' }, JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: 'a.ts', old_string: 'one\ntwo\nthree', new_string: 'one\n2\nthree' } }] },
    }));
    expect(event).toMatchObject({ label: 'Edit a.ts' });
    expect(changed(event!.diff)).toEqual({ removed: ['two'], added: ['2'] });
  });
});
