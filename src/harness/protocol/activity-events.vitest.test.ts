import { changed } from '../../agent/line-diff.test-support.js';
import { describe, expect, it } from 'vitest';
import { activityOutput, fileChangeActivity, parseNativeActivityEventsFromValue } from './activity-events.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import { renderActivityLine } from './activity-line.js';
import { codex } from './vendor-fixtures.vitest.js';

/** The first activity one stdout line describes. */
const parseNativeActivityEvent = (harness: AiLocalHarnessDefinition, line: string) => parseNativeActivityEventsFromValue(harness, JSON.parse(line))[0];

describe('incremental native tool activity', () => {
  it('carries a command\'s whole output, and shows it only under a failed call', () => {
    const event = { kind: 'tool-done' as const, label: '$ git status', category: 'run' as const, id: 'call-1', output: ['one', 'two', 'three', 'four'] };
    // A successful call is one row; its output is in the saved turn, not under the call.
    const plain = (rows: string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, '').trim());
    expect(plain(renderActivityLine(event)).slice(1)).toEqual([]);
    // A failed one shows the last lines of its output: that is the error.
    const failed = { ...event, kind: 'tool-error' as const, exitCode: 1, output: Array.from({ length: 9 }, (_, index) => `line ${index + 1}`) };
    expect(plain(renderActivityLine(failed)).slice(1).at(-1)).toBe('line 9');
    expect(plain(renderActivityLine(failed)).slice(1).length).toBeLessThan(9);
    expect(renderActivityLine({ kind: 'tool-error', label: '$ pnpm test', category: 'run', id: 'call-failed', exitCode: 1 })[0]!.replace(/\u001b\[[0-9;]*m/g, '')).toContain('failed');
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

  it('shows the paths and the diff of a file change', () => {
    const event = fileChangeActivity([{ path: 'src/a.ts', diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old line\n+new line\n' }, { path: 'src/b.ts' }]);
    expect(event).toMatchObject({ label: 'Edit src/a.ts, src/b.ts', category: 'edit' });
    expect(event.diff).toEqual([{ path: 'src/a.ts', additions: 1, removals: 1, lines: [{ kind: 'removed', text: 'old line', line: 1 }, { kind: 'added', text: 'new line', line: 1 }] }]);
  });

  it('renders a Claude edit as the lines that changed, not both texts whole', () => {
    const event = parseNativeActivityEvent({ ...codex, command: 'claude', parser: 'claude-stream-json' }, JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: 'a.ts', old_string: 'one\ntwo\nthree', new_string: 'one\n2\nthree' } }] },
    }));
    expect(event).toMatchObject({ label: 'Edit a.ts' });
    expect(changed(event!.diff)).toEqual({ removed: ['two'], added: ['2'] });
  });
});

describe('a tool result that is JSON', () => {
  const claude = { ...codex, command: 'claude', parser: 'claude-stream-json' } as AiLocalHarnessDefinition;
  const result = (content: string) => parseNativeActivityEvent(claude, JSON.stringify({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
  }));

  it('never draws the raw envelope', () => {
    expect(result('{"status":"ok","code":0,"meta":{"a":1}}')?.output).toBeUndefined();
    expect(result('{"a":1}\n{"b":2}')?.output).toBeUndefined();
  });

  it('surfaces the human-meaningful string the JSON carries, so the row has a result line', () => {
    expect(result('{"stdout":"built 12 files","exit_code":0}')?.output).toEqual(['built 12 files']);
    expect(result('{"output":"a\\nb"}')?.output).toEqual(['a', 'b']);
    expect(result('{"message":"3 tests passed","ok":true}')?.output).toEqual(['3 tests passed']);
    expect(result('{"result":{"text":"found it"}}')?.output).toEqual(['found it']);
    expect(result('{"error":"ENOENT: no such file","code":2}')?.output).toEqual(['ENOENT: no such file']);
    expect(result('{"error":{"message":"denied"}}')?.output).toEqual(['denied']);
  });

  it('says how many where the JSON is a list', () => {
    expect(result('[{"path":"a"},{"path":"b"},{"path":"c"}]')?.output).toEqual(['3 items']);
    expect(result('{"files":["a","b"],"cwd":"/x"}')?.output).toEqual(['2 files']);
    expect(result('[]')?.output).toEqual(['0 items']);
  });

  it('reads goose and opencode results the same way', () => {
    const goose = { ...codex, command: 'goose', parser: 'goose' } as AiLocalHarnessDefinition;
    const response = parseNativeActivityEvent(goose, JSON.stringify({
      type: 'message', message: { role: 'user', content: [{ type: 'toolResponse', id: 'g1', toolResult: { status: 'success', value: [{ type: 'text', text: '{"stdout":"ok"}' }] } }] },
    }));
    expect(response?.output).toEqual(['ok']);
    const opencode = { ...codex, command: 'opencode', parser: 'opencode-json' } as AiLocalHarnessDefinition;
    const done = parseNativeActivityEvent(opencode, JSON.stringify({
      type: 'tool_use', part: { tool: 'bash', callID: 'o1', state: { status: 'completed', input: { command: 'ls' }, output: '{"output":"a.ts"}' } },
    }));
    expect(done?.output).toEqual(['a.ts']);
  });
});

describe('Pi tool results', () => {
  it('carry the result text on the completion', () => {
    const pi = { ...codex, command: 'pi', parser: 'pi-json' } as AiLocalHarnessDefinition;
    const done = parseNativeActivityEvent(pi, JSON.stringify({
      type: 'tool_execution_end', toolCallId: 'p1', toolName: 'bash', isError: false,
      result: { content: [{ type: 'text', text: 'a.ts\nb.ts' }] },
    }));
    expect(done).toMatchObject({ kind: 'tool-done', id: 'p1', output: ['a.ts', 'b.ts'] });
    const failed = parseNativeActivityEvent(pi, JSON.stringify({
      type: 'tool_execution_end', toolCallId: 'p2', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'command not found' }] },
    }));
    expect(failed).toMatchObject({ kind: 'tool-error', output: ['command not found'] });
  });
});
