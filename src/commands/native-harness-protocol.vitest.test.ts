import { describe, expect, it } from 'vitest';
import { nativeTurnResult } from './native-harness-protocol';
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
});
