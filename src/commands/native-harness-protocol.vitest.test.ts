import { describe, expect, it } from 'vitest';
import { nativeProfileEnvironment, nativeResponseUpdate, nativeSessionIds, nativeTurnResult, parseNativeActivityEvent, renderActivityLine } from './native-harness-protocol';
import type { AiLocalHarnessDefinition } from './types';

const codex = {
  command: 'codex',
  provider: 'codex',
  displayName: 'Codex',
  surface: 'terminal',
  localAuth: ['vendor-cli'],
  binary: 'codex',
  turn: {
    startArgv: [],
    output: 'json-lines',
    responseFields: ['text'],
  },
} satisfies AiLocalHarnessDefinition;

describe('native profile environments', () => {
  it('isolates HOME-based profiles through USERPROFILE on native Windows', () => {
    const profile = { env: 'HOME', path: 'C:\\profiles\\one', extraEnv: { TOKEN: 'x' } };
    expect(nativeProfileEnvironment(profile, 'win32')).toEqual({
      HOME: 'C:\\profiles\\one', USERPROFILE: 'C:\\profiles\\one', TOKEN: 'x',
    });
    expect(nativeProfileEnvironment(profile, 'darwin')).toEqual({ HOME: 'C:\\profiles\\one', TOKEN: 'x' });
  });
});

describe('native harness turn results', () => {
  it('keeps a valid final answer successful after a failed internal sub-command', () => {
    const stdout = [
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'exit 1', status: 'failed', exit_code: 1 } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'The complete answer.' } }),
    ].join('\n');

    const result = nativeTurnResult(codex, stdout);

    expect(result.text).toBe('The complete answer.');
    expect(result.isError).toBeUndefined();
  });

  it('still treats a bare vendor error with no assistant answer as a failure', () => {
    const result = nativeTurnResult(codex, JSON.stringify({ error: 'authentication required' }));

    expect(result).toMatchObject({ text: 'authentication required', isError: true });
  });

  it('honors an explicit terminal failed status', () => {
    const result = nativeTurnResult(codex, JSON.stringify({ type: 'turn.failed', status: 'failed', error: 'quota exhausted' }));

    expect(result).toMatchObject({ text: 'quota exhausted', isError: true });
  });


  it('accepts Cline say snapshots as assistant output', () => {
    const cline = { ...codex, command: 'cline', displayName: 'Cline', turn: { ...codex.turn, responseFields: ['text'] } };
    expect(nativeTurnResult(cline, JSON.stringify({ type: 'say', text: 'Finished.', partial: false })).text).toBe('Finished.');
  });

  it('reassembles Goose assistant message chunks', () => {
    const goose = { ...codex, command: 'goose', displayName: 'Goose', turn: { ...codex.turn, responseFields: ['text'] } };
    const stdout = [
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello ' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'world.' }] } },
      { type: 'complete' },
    ].map(JSON.stringify).join('\n');
    expect(nativeTurnResult(goose, stdout).text).toBe('Hello world.');
  });

  it('extracts final answers from every structured envelope family', () => {
    const cases: Array<[string, 'json' | 'json-lines', unknown]> = [
      ['claude', 'json-lines', { type: 'result', result: 'done' }],
      ['codex', 'json-lines', { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }],
      ['opencode', 'json-lines', { type: 'text', part: { text: 'done' } }],
      ['antigravity', 'json-lines', { status: 'SUCCESS', response: 'done' }],
      ['pi', 'json-lines', { type: 'result', result: 'done' }],
      ['droid', 'json', { type: 'result', result: 'done', session_id: 'droid-session' }],
      ['kiro', 'json-lines', { type: 'result', result: 'done' }],
      ['qwen', 'json-lines', { type: 'result', result: 'done' }],
      ['cline', 'json-lines', { type: 'say', text: 'done', partial: false }],
      ['kilo', 'json-lines', { type: 'text', part: { text: 'done' } }],
      ['cursor', 'json-lines', { type: 'result', result: 'done' }],
      ['command', 'json-lines', { type: 'result', result: 'done' }],
    ];
    for (const [command, output, envelope] of cases) {
      const candidate = { ...codex, command, displayName: command, turn: { ...codex.turn, output, responseFields: ['result', 'response', 'text', 'content'] } };
      expect(nativeTurnResult(candidate, JSON.stringify(envelope)).text, command).toBe('done');
    }
  });
});

describe('native harness response streams', () => {
  const harness = (command: string): AiLocalHarnessDefinition => ({ ...codex, command, displayName: command });

  it('extracts documented Antigravity deltas and conversation ids', () => {
    const line = JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c3b66b04-872b-4fbe-a3a4-058a026ef20a', step_type: 'agent_response', text_delta: 'chunk' } });
    expect(nativeResponseUpdate(harness('antigravity'), line)).toEqual({ text: 'chunk', mode: 'append' });
    expect([...nativeSessionIds(line, 'json-lines')]).toContain('c3b66b04-872b-4fbe-a3a4-058a026ef20a');
  });

  it('prioritizes explicit thread identities over nested item ids', () => {
    const output = [
      JSON.stringify({ type: 'item.completed', item: { id: 'item-first', type: 'reasoning' } }),
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-source' }),
    ].join('\n');
    expect([...nativeSessionIds(output, 'json-lines')][0]).toBe('thread-source');
  });

  it('extracts Claude/Qwen stream events, Cursor deltas, and Cline snapshots', () => {
    const streamEvent = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } } });
    expect(nativeResponseUpdate(harness('claude'), streamEvent)).toEqual({ text: 'A', mode: 'append' });
    expect(nativeResponseUpdate(harness('qwen'), streamEvent)).toEqual({ text: 'A', mode: 'append' });
    expect(nativeResponseUpdate(harness('cursor'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'C' }] } })))
      .toEqual({ text: 'C', mode: 'append' });
    expect(nativeResponseUpdate(harness('cline'), JSON.stringify({ type: 'say', text: 'Current', partial: true })))
      .toEqual({ text: 'Current', mode: 'replace' });
    expect(nativeResponseUpdate(harness('pi'), JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'D' } })))
      .toEqual({ text: 'D', mode: 'append' });
    expect(nativeResponseUpdate(harness('goose'), JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'E' }] } })))
      .toEqual({ text: 'E', mode: 'append' });
    const openCodeText = JSON.stringify({ type: 'text', part: { text: 'F' } });
    expect(nativeResponseUpdate(harness('opencode'), openCodeText)).toEqual({ text: 'F', mode: 'append' });
    expect(nativeResponseUpdate(harness('kilo'), openCodeText)).toEqual({ text: 'F', mode: 'append' });
  });

  it('shows Codex agent messages as they arrive without rendering tool JSON as response text', () => {
    expect(nativeResponseUpdate(harness('codex'), JSON.stringify({
      type: 'item.completed', item: { type: 'agent_message', text: 'I am checking that now.' },
    }))).toEqual({ text: 'I am checking that now.\n\n', mode: 'append' });
    expect(nativeResponseUpdate(harness('codex'), JSON.stringify({
      type: 'item.completed', item: { type: 'mcp_tool_call', name: 'search', arguments: { query: 'test' } },
    }))).toBeUndefined();
  });
});

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
