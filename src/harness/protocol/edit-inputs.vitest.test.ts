/** Any harness's edit or write, read from its tool's own input fields. */
import { describe, expect, it } from 'vitest';
import { editDiffFromInput, parseNativeActivityEventsFromValue } from './activity-events.js';
import { changed } from '../../agent/line-diff.test-support.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

describe('an edit read from its input, whatever the fields are called', () => {
  it.each([
    ['Claude', { file_path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2' }],
    ['Amp', { path: 'a.ts', old_str: 'x = 1', new_str: 'x = 2' }],
    ['Pi', { path: 'a.ts', oldText: 'x = 1', newText: 'x = 2' }],
  ])('%s', (_vendor, input) => {
    const diff = editDiffFromInput(input)!;
    expect(diff[0]!.path).toBe('a.ts');
    expect(changed(diff)).toEqual({ removed: ['x = 1'], added: ['x = 2'] });
    expect(diff[0]!.lines.every((line) => line.line === undefined)).toBe(true); // a fragment: no line numbers
  });

  it('reads every edit of a multi-edit, and a write as the whole new file, numbered', () => {
    expect(changed(editDiffFromInput({ file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b', new_string: 'B' }] })))
      .toEqual({ removed: ['a', 'b'], added: ['A', 'B'] });
    const write = editDiffFromInput({ path: 'n.ts', file_text: 'one\ntwo\n' })!;
    expect(write[0]).toMatchObject({ path: 'n.ts', change: 'add', additions: 2 });
    expect(write[0]!.lines.map((line) => line.line)).toEqual([1, 2]);
  });

  it('says nothing for an input that is not a change', () => {
    expect(editDiffFromInput({ command: 'ls' })).toBeUndefined();
    expect(editDiffFromInput({ content: 'no path to write it to' })).toBeUndefined();
  });
});

it("gives OpenCode's and Pi's edit rows their diff, as Claude's", () => {
  const harness = (command: string) => ({ command, provider: command, displayName: command } as AiLocalHarnessDefinition);
  const opencode = parseNativeActivityEventsFromValue(harness('opencode'), {
    type: 'tool_use', part: { tool: 'edit', callID: 'e1', state: { status: 'running', input: { filePath: 'a.ts', oldString: 'q', newString: 'Q' } } },
  })[0]!;
  expect(changed(opencode.diff)).toEqual({ removed: ['q'], added: ['Q'] });
  const pi = parseNativeActivityEventsFromValue(harness('pi'), { type: 'tool_execution_start', toolCallId: 'p1', toolName: 'edit', args: { path: 'a.ts', oldText: 'r', newText: 'R' } })[0]!;
  expect(changed(pi.diff)).toEqual({ removed: ['r'], added: ['R'] });
});
