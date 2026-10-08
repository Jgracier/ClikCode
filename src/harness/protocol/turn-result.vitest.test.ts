import { describe, expect, it } from 'vitest';
import { nativeTurnFailure, nativeTurnResult } from './turn-result';
import { classifyAccountFailure } from '../../turn/failover.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
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

  it('keeps an answer given after a failed step, and an error after the answer still fails', () => {
    const antigravity = localHarnessForCommand('antigravity')!;
    // A step marked {status:"ERROR"} with no reason, then the full answer, exit 0.
    const recovered = [JSON.stringify({ status: 'ERROR' }), JSON.stringify({ status: 'SUCCESS', response: 'The full answer.' })].join('\n');
    const result = nativeTurnResult(antigravity, recovered, { exitCode: 0 });
    expect(result.text).toBe('The full answer.');
    expect(result.isError).toBeUndefined();
    // Failing last is failing, and the answer is never given as the reason.
    const failed = [JSON.stringify({ status: 'SUCCESS', response: 'Partway.' }), JSON.stringify({ status: 'ERROR' })].join('\n');
    const last = nativeTurnResult(antigravity, failed, { exitCode: 0 });
    expect(last.isError).toBe(true);
    expect(nativeTurnFailure(antigravity, last).failure.message).toBe('Antigravity CLI: reported the turn failed without saying why');
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
    const goose = { ...codex, command: 'goose', displayName: 'Goose', parser: 'goose' as const, turn: { ...codex.turn, responseFields: ['text'] } };
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

  it('reads OpenClaw\'s answer, not its execution trace, and knows a CLI route keeps no history', () => {
    const openclaw = localHarnessForCommand('openclaw')!;
    // Real `openclaw agent --local --json` output (2026.9.6), trimmed. The
    // trace's `result: "success"` used to become the reply.
    const stdout = JSON.stringify({"payloads": [{"text": "Hello, Justin. Ready.", "mediaUrl": null}], "meta": {"durationMs": 3208, "finalAssistantVisibleText": "Hello, Justin. Ready.", "systemPromptReport": {"sessionId": "88a55c28-c093-49a8-a4b0-c39d1548d756", "sessionKey": "agent:main:main", "provider": "claude-cli", "model": "claude-haiku-4-5"}, "executionTrace": {"winnerProvider": "claude-cli", "winnerModel": "claude-haiku-4-5", "attempts": [{"provider": "claude-cli", "model": "claude-haiku-4-5", "result": "success"}], "fallbackUsed": false, "runner": "cli"}}});
    expect(nativeTurnResult(openclaw, stdout)).toEqual({
      text: 'Hello, Justin. Ready.', nativeSessionId: '88a55c28-c093-49a8-a4b0-c39d1548d756', nativeSessionStateless: true,
    });
    const failed = JSON.stringify({ ok: false, error: { type: 'cli_error', message: 'No API key found for provider "anthropic".' } });
    expect(nativeTurnResult(openclaw, failed)).toMatchObject({ isError: true, errorKind: 'cli_error', text: 'No API key found for provider "anthropic".' });
  });

  describe('only the assistant authors an answer', () => {
    // Recorded from cursor-agent 2026-09-26 on a free plan: the stream holds
    // the init record and the prompt echoed back, then the process exits 1
    // with the real reason on stderr. The echo used to be returned as the
    // reply, with the turn marked successful.
    const cursor = localHarnessForCommand('cursor')!;
    const echoed = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'f9b9da2b', model: 'Codex 5.3 Low' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly PONG' }] }, session_id: 'f9b9da2b' }),
    ].join('\n');

    it('never returns the prompt echoed back as the reply', () => {
      expect(() => nativeTurnResult(cursor, echoed)).toThrow(/no assistant text/);
    });

    it('fails with the reason the process gave on stderr', () => {
      const stderr = 'ActionRequiredError: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.\n';
      let failure: (Error & { stderrTail?: string; exitCode?: number }) | undefined;
      try { nativeTurnResult(cursor, echoed, { exitCode: 1, stderr }); } catch (error) { failure = error as typeof failure; }
      expect(failure?.message).toBe('Cursor Agent: ActionRequiredError: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.');
      expect(failure?.stderrTail).toContain('Named models unavailable');
      expect(failure?.exitCode).toBe(1);
    });

    it('still reads the assistant reply that follows an echoed prompt', () => {
      const stdout = `${echoed}\n${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'PONG' }] } })}`;
      expect(nativeTurnResult(cursor, stdout, { exitCode: 0 }).text).toBe('PONG');
    });

    it('ignores text in system and tool records wherever it sits', () => {
      const stdout = [
        JSON.stringify({ type: 'message', message: { role: 'system', content: 'You are a helpful agent.' } }),
        JSON.stringify({ type: 'message', message: { role: 'tool', content: 'file contents' } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'Done.' } }),
      ].join('\n');
      expect(nativeTurnResult(localHarnessForCommand('vibe')!, stdout).text).toBe('Done.');
    });
  });

  describe('plain-text output', () => {
    const continueCli = localHarnessForCommand('cn')!;

    it('treats a non-zero exit as the failure, explained by what the process printed', () => {
      let failure: (Error & { stderrTail?: string }) | undefined;
      try {
        nativeTurnResult(continueCli, 'Error: You have exceeded your monthly quota\n', { exitCode: 1, stderr: '' });
      } catch (error) { failure = error as typeof failure; }
      expect(failure?.message).toBe('Continue: Error: You have exceeded your monthly quota');
      // Not an answer, so it is safe to classify: failover reads it as quota.
      expect(failure?.stderrTail).toContain('exceeded your monthly quota');
    });

    it('returns the output as the answer on a clean exit', () => {
      expect(nativeTurnResult(continueCli, 'PONG\n', { exitCode: 0 }).text).toBe('PONG');
    });
  });
});

describe('the failure a failed turn is classified by', () => {
  const cursor = localHarnessForCommand('cursor')!;
  const claude = localHarnessForCommand('claude')!;
  const kind = (result: ReturnType<typeof nativeTurnResult>) => {
    const { failure, isResultError } = nativeTurnFailure(cursor, result);
    return classifyAccountFailure(failure, { isResultError });
  };

  it('never reads the model\'s own sentence as the vendor\'s refusal', () => {
    const stdout = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The test asserts "usage limit exceeded" when the cap is hit.' }] } },
      { type: 'result', subtype: 'error', is_error: true },
    ].map((record) => JSON.stringify(record)).join('\n');
    const result = nativeTurnResult(cursor, stdout);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBeUndefined();
    expect(kind(result)).toBe('other');
  });

  it('reads the reason the vendor declared on its failed result', () => {
    const stdout = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } },
      { type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1760000000' },
    ].map((record) => JSON.stringify(record)).join('\n');
    const result = nativeTurnResult(claude, stdout);
    expect(result.errorMessage).toBe('Claude AI usage limit reached|1760000000');
    expect(kind(result)).toBe('quota-exhausted');
  });
});
