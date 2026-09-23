import { describe, expect, it } from 'vitest';
import { allLocalHarnesses, harnessCanRunTurns } from '@clikcode/router/ai-local-harness';
import { getAiProvider } from '@clikcode/router/ai-provider-registry-public';

/** lazy-bridge's isDirectModelProvider, minus the bundle indirection: this
 *  suite runs from source, where dist/harness-catalog.cjs is not on disk (the
 *  very case lazy-bridge's withoutRuntime fallback exists for). Same registry,
 *  same answer. */
const isDirectModelProvider = (provider: string): boolean => Boolean(getAiProvider(provider));

/**
 * Every harness that offers an API key must have some way to actually serve a
 * turn with one.
 *
 * Seventeen harnesses advertise `api-key` in localAuth. Only five of them
 * name a provider that is a real model API (anthropic, openai, google, xai,
 * nous); the other twelve name THEMSELVES -- aider, cline, continue, goose,
 * kilo, kimi, kiro, opencode, openhands, pi, qwen, mistral-vibe -- and there
 * is no aider endpoint to POST to. drive.ts used to fork on
 * `authKind === 'vendor-cli'`, so those twelve fell through to a direct HTTP
 * turn and threw a raw `unknown AI provider: aider` from inside the registry,
 * reachable in a few keystrokes from the account picker.
 *
 * The invariant is not "every provider is in the registry" -- that would be
 * wrong, since a tool is legitimately not a model vendor. It is that every
 * api-key harness is reachable by AT LEAST ONE transport.
 */
describe('api-key auth has a usable transport on every harness that offers it', () => {
  const apiKeyHarnesses = allLocalHarnesses().filter((harness) => (harness.localAuth ?? []).includes('api-key'));

  it('offers api-key on a meaningful number of harnesses', () => {
    // Guards against the invariant below passing trivially because the
    // feature quietly disappeared from the catalog.
    expect(apiKeyHarnesses.length).toBeGreaterThanOrEqual(17);
  });

  it('can serve every api-key harness either directly or through its own CLI', () => {
    const unusable = apiKeyHarnesses
      .filter((harness) => !isDirectModelProvider(harness.provider) && !harnessCanRunTurns(harness))
      .map((harness) => `${harness.command} (provider ${harness.provider})`);
    expect(unusable, 'these advertise api-key with no way to run a turn').toEqual([]);
  });

  it('routes the tool-style harnesses through their CLI, not a direct HTTP turn', () => {
    // The twelve that produced the bug. Each must be turn-capable, because
    // that is the only path available to them.
    const toolStyle = apiKeyHarnesses.filter((harness) => !isDirectModelProvider(harness.provider));
    expect(toolStyle.length).toBeGreaterThanOrEqual(12);
    for (const harness of toolStyle) {
      expect(harnessCanRunTurns(harness), `${harness.command} has no CLI transport to fall back on`).toBe(true);
    }
  });

  it('still recognises the genuine model providers as directly addressable', () => {
    // The other half of the fork: these must NOT be pushed onto a CLI when a
    // real endpoint exists.
    for (const provider of ['anthropic', 'openai', 'google', 'xai', 'nous']) {
      expect(isDirectModelProvider(provider), `${provider} should be directly addressable`).toBe(true);
    }
    for (const tool of ['aider', 'goose', 'opencode', 'kiro', 'qwen']) {
      expect(isDirectModelProvider(tool), `${tool} is a tool, not a model API`).toBe(false);
    }
  });
});
