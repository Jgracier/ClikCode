// The Responses surface is what OpenAI requires for function tools on reasoning models
// (chat/completions rejects tools+reasoning). Locks request shape and both extractors.
import { describe, it, expect } from 'vitest';
import { buildAiChatRequest, extractChatText, extractToolCalls } from './ai-provider-http';

const TOOLS = [{ name: 'set_app_env', description: 'set env', parameters: { type: 'object', properties: {} } }];
// Typed as the builder's own input shape rather than `as never`: `never` is not spreadable, so the
// three `{ ...base }` sites below were TS2698 errors even though the runtime behavior was correct.
const base = {
  provider: 'openai',
  model: 'gpt-5.6-luna',
  apiKey: 'k',
  credentialSource: 'env' as const,
};

describe('openai responses dialect', () => {
  it('routes to /responses ONLY when tools are supplied', () => {
    const withTools = buildAiChatRequest({ ...base, messages: [{ role: 'user', content: 'hi' }], tools: TOOLS } as never);
    expect(withTools.url).toBe('https://api.openai.com/v1/responses');
    expect(withTools.dialect).toBe('openai-responses');

    const noTools = buildAiChatRequest({ ...base, messages: [{ role: 'user', content: 'hi' }] } as never);
    expect(noTools.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(noTools.dialect).toBe('openai-chat');
  });

  it('uses max_output_tokens, flat tools, and instructions for system', () => {
    const b = buildAiChatRequest({
      ...base, system: 'be careful', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, maxTokens: 2048,
    } as never);
    const body = b.body as Record<string, unknown>;
    expect(body.max_output_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body.instructions).toBe('be careful');
    // flat, NOT nested under `function`
    expect(body.tools).toEqual([{ type: 'function', name: 'set_app_env', description: 'set env', parameters: TOOLS[0].parameters }]);
  });

  it('extracts tool calls from the output array, ignoring reasoning items', () => {
    const payload = { output: [
      { type: 'reasoning', summary: [] },
      { type: 'function_call', name: 'set_app_env', arguments: '{"key":"PORT","value":"8080"}' },
    ] };
    expect(extractToolCalls('openai-responses', payload)).toEqual([
      { name: 'set_app_env', args: { key: 'PORT', value: '8080' } },
    ]);
  });

  it('skips malformed argument JSON instead of throwing away the turn', () => {
    const payload = { output: [
      { type: 'function_call', name: 'bad', arguments: '{not json' },
      { type: 'function_call', name: 'good', arguments: '{"a":1}' },
    ] };
    expect(extractToolCalls('openai-responses', payload)).toEqual([{ name: 'good', args: { a: 1 } }]);
  });

  it('extracts assistant prose from output_text parts', () => {
    const payload = { output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'Set PORT to 8080.' }] },
    ] };
    expect(extractChatText('openai-responses', payload)).toBe('Set PORT to 8080.');
  });

  it('returns empty rather than throwing on an unexpected body', () => {
    expect(extractToolCalls('openai-responses', {})).toEqual([]);
    expect(extractChatText('openai-responses', {})).toBe('');
  });
});
