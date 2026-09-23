// What `cachePrompt: true` is actually allowed to do at the dispatch layer.
//
// The caller (an agent, acting on its task policy) can only express INTENT:
// "this run resends the same prefix, so paying to cache it is worth it." It
// cannot know whether the selected provider takes a cache parameter, because
// routing may have landed on any of ~20 vendors. Only this layer holds the
// catalog, so only this layer decides whether the intent turns into a
// breakpoint on the wire.
//
// Getting that wrong is not cosmetic: sending Anthropic's providerOptions to a
// vendor that caches automatically means sending a field it never asked for,
// while dropping it on Anthropic means silently paying full input price on
// every cached token.

import { describe, expect, it, vi } from 'vitest';

/** Capture what streamText was handed, and settle every consumable emptily. */
function mockStreamTextCapturing(captured: { opts?: Record<string, unknown> }) {
  vi.doMock('ai', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
      ...actual,
      streamText: (opts: Record<string, unknown>) => {
        captured.opts = opts;
        return {
          textStream: (async function* () {})(),
          toolCalls: Promise.resolve([]),
          totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
          response: Promise.resolve({ modelId: 'm', messages: [] }),
          finishReason: Promise.resolve('stop'),
          providerMetadata: Promise.resolve(undefined),
        };
      },
    };
  });
}

async function dispatch(input: Record<string, unknown>) {
  const captured: { opts?: Record<string, unknown> } = {};
  mockStreamTextCapturing(captured);
  vi.resetModules();
  const { streamAiChatTurn } = await import('./ai-provider-models');
  await streamAiChatTurn(input as never).catch(() => {});
  vi.doUnmock('ai');
  vi.resetModules();
  return captured.opts ?? {};
}

const SYSTEM = 'You are a careful engineer.';
const BASE = {
  apiKey: 'k',
  system: SYSTEM,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('cachePrompt on an EXPLICIT-caching provider', () => {
  it('promotes the system prompt to a message carrying a cache breakpoint', async () => {
    const opts = await dispatch({
      ...BASE,
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      cachePrompt: true,
    });
    expect(opts.system).toEqual({
      role: 'system',
      content: SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } },
    });
  });

  it('requests the 5m TTL, not the 1h one', async () => {
    // The 1h TTL costs roughly double to write. Nothing here re-sends a prefix
    // an hour later, so buying that window would be paying for reuse that
    // never happens — and the pricing scrape reads the 5m column to match.
    const opts = await dispatch({
      ...BASE,
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      cachePrompt: true,
    });
    const po = (opts.system as { providerOptions: { anthropic: { cacheControl: { ttl: string } } } })
      .providerOptions;
    expect(po.anthropic.cacheControl.ttl).toBe('5m');
  });
});

describe('cachePrompt on an AUTOMATIC-caching provider', () => {
  it('passes the system prompt through as a plain string', async () => {
    // OpenAI caches a stable >=1024-token prefix with no parameter at all.
    // The intent is honoured — by doing nothing, which is the correct wire
    // shape — rather than by inventing a field.
    const opts = await dispatch({
      ...BASE,
      provider: 'openai',
      model: 'gpt-5.6-sol',
      cachePrompt: true,
    });
    expect(opts.system).toBe(SYSTEM);
  });
});

describe('without cachePrompt', () => {
  it('never attaches a breakpoint, even on Anthropic', async () => {
    // A cache WRITE is billed at ~1.25x. An agent whose policy says no must
    // not be charged it because the provider happens to support caching.
    const opts = await dispatch({
      ...BASE,
      provider: 'anthropic',
      model: 'claude-opus-4-5',
    });
    expect(opts.system).toBe(SYSTEM);
  });
});
