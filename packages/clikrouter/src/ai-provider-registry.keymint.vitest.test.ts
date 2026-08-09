// Guard for the `keyMint` capability — the declared replacement for what used
// to be a provider-name branch in the admin UI
// (`provider === 'openrouter' && <Button>Get key</Button>`).
//
// The point of moving it into catalog data is that a SECOND provider can
// declare it without touching platform code. These assertions are what make
// that true: they fail if a new entry is half-declared in a way the shared
// credential card could not render.

import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDERS,
  AI_PROVIDERS_BY_CONNECT_PRIORITY,
  aiProviderConnectTier,
  type AiProviderSpec,
} from './ai-provider-registry';

const specs = AI_PROVIDERS as readonly AiProviderSpec[];
const minting = specs.filter((s) => s.keyMint);

describe('ai-provider-registry: keyMint', () => {
  it('still declares the flow that replaced the openrouter branch', () => {
    const openrouter = specs.find((s) => s.id === 'openrouter');
    expect(openrouter?.keyMint).toEqual({
      label: 'Connect',
      startEndpoint: '/api/admin/platform-connect/openrouter/start',
    });
  });

  it('every minting provider has somewhere to put the minted key', () => {
    // A mint flow writes a plain API key; without envKey there is no
    // PlatformSecret/env target and the result would be silently dropped.
    for (const spec of minting) {
      expect(spec.envKey, `${spec.id} declares keyMint but no envKey`).toBeTruthy();
    }
  });

  it('every keyMint is renderable — label plus a same-origin start endpoint', () => {
    for (const spec of minting) {
      expect(spec.keyMint!.label.trim(), `${spec.id} keyMint.label`).not.toBe('');
      expect(spec.keyMint!.startEndpoint, `${spec.id} keyMint.startEndpoint`).toMatch(
        /^\/api\/admin\//,
      );
    }
  });

  it('display order puts OAuth first, then key mints, then paste-only', () => {
    const tiers = AI_PROVIDERS_BY_CONNECT_PRIORITY.map(aiProviderConnectTier);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    // Every OAuth provider outranks every paste-only one.
    const lastOAuth = tiers.lastIndexOf(0);
    const firstPasteOnly = tiers.indexOf(2);
    expect(lastOAuth).toBeLessThan(firstPasteOnly);
  });

  it('reorders without dropping or duplicating a provider', () => {
    expect(AI_PROVIDERS_BY_CONNECT_PRIORITY).toHaveLength(specs.length);
    expect([...AI_PROVIDERS_BY_CONNECT_PRIORITY.map((p) => p.id)].sort()).toEqual(
      [...specs.map((p) => p.id)].sort(),
    );
  });

  it('preserves the curated order within a tier', () => {
    // The sort is stable, so declaration order still ranks providers that share
    // a tier — flagship before niche. Guards against a future switch to an
    // unstable comparator silently scrambling the list.
    for (const tier of [0, 1, 2] as const) {
      const declared = specs.filter((s) => aiProviderConnectTier(s) === tier).map((s) => s.id);
      const sorted = AI_PROVIDERS_BY_CONNECT_PRIORITY.filter(
        (s) => aiProviderConnectTier(s) === tier,
      ).map((s) => s.id);
      expect(sorted).toEqual(declared);
    }
  });

  it('keyMint and oauth stay distinct lanes', () => {
    // oauth ⇒ a PlatformAiConnection with refresh/disconnect.
    // keyMint ⇒ a bare key, nothing to refresh or disconnect.
    // OpenRouter is the reason both exist: a real PKCE flow whose result is
    // only a key, so `oauth` must stay false or the UI would offer a
    // Disconnect that has no connection row behind it.
    const openrouter = specs.find((s) => s.id === 'openrouter');
    expect(openrouter?.oauth ?? false).toBe(false);
  });
});
