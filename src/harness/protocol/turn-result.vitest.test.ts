import { describe, expect, it } from 'vitest';
import { nativeTurnResult } from './turn-result';
import { codex } from './vendor-fixtures.vitest';

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

