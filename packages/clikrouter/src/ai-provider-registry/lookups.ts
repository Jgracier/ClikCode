// ============================================
// AI PROVIDER REGISTRY — lookups & modality helpers
// ============================================

import {
  AI_PROVIDER_CATEGORY_LABEL,
  AI_PROVIDER_CATEGORY_ORDER,
  type AiModality,
  type AiProviderCategory,
  type AiProviderSpec,
} from './types';
import {
  AI_PROVIDERS,
  AI_PROVIDER_IDS,
  type AiProviderId,
} from './providers';

/**
 * How much of the credential work the platform can do FOR the admin:
 *   0 — `oauth`   : full connect/reconnect/disconnect, nothing to paste
 *   1 — `keyMint` : one button mints the key, still a key underneath
 *   2 — neither   : paste a key from the vendor console
 *
 * Used purely for display ordering, so the surfaces that can be set up with a
 * click sort above the ones that need a trip to a vendor dashboard.
 */
export function aiProviderConnectTier(spec: AiProviderSpec): 0 | 1 | 2 {
  if (spec.oauth) return 0;
  if (spec.keyMint) return 1;
  return 2;
}

/**
 * Display order: connectable providers first, paste-only last.
 *
 * Deliberately NOT baked into the AI_PROVIDERS literal — that array's order is
 * the curated within-tier ranking (flagship providers before niche ones), and
 * re-sorting it by hand every time a provider gains OAuth would rot. Array#sort
 * is stable (ES2019+), so the curated order survives inside each tier and a
 * provider gaining `oauth` moves it to the top with no data edit.
 */
export const AI_PROVIDERS_BY_CONNECT_PRIORITY: readonly AiProviderSpec[] = [
  ...(AI_PROVIDERS as readonly AiProviderSpec[]),
].sort((a, b) => aiProviderConnectTier(a) - aiProviderConnectTier(b));

/** Ids in connect-priority display order — derived, do not hand-maintain. */
export const AI_PROVIDER_IDS_BY_CONNECT_PRIORITY = AI_PROVIDERS_BY_CONNECT_PRIORITY.map(
  (p) => p.id,
) as readonly AiProviderId[];

export function isAiProviderId(value: string): value is AiProviderId {
  return (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Look up a provider spec by id (undefined when unknown). */
export function getAiProvider(id: string): AiProviderSpec | undefined {
  return (AI_PROVIDERS as readonly AiProviderSpec[]).find((p) => p.id === id);
}

/** Look up the provider whose API-key env var is `envKey` (undefined when no
 *  provider claims it). */
export function getAiProviderByEnvKey(
  envKey: string,
): AiProviderSpec | undefined {
  return (AI_PROVIDERS as readonly AiProviderSpec[]).find(
    (p) => p.envKey === envKey,
  );
}

// ── MODALITY DERIVATIONS ─────────────────────────────────────────────────────────────────────────
// The console's grouping and the routers' filter are both DERIVED from `modalities`, so a provider
// declares its capabilities once. A second `category` field would be a second place to disagree.

/** Declared modalities, defaulted. Absent means text — what every pre-audio row is. */
export function providerModalities(spec: AiProviderSpec): readonly AiModality[] {
  return spec.modalities && spec.modalities.length > 0 ? spec.modalities : ["text"];
}

/**
 * Which console section a provider belongs under.
 *
 * Precedence is deliberate and total, because providers are not single-purpose: fal does image, video,
 * speech AND transcription. Text wins first (it is what routing uses), then visual, then audio — so
 * every provider lands in exactly one section and the sections stay stable as vendors add modalities.
 */
export function providerCategory(spec: AiProviderSpec): AiProviderCategory {
  const m = providerModalities(spec);
  if (m.includes("text") || m.includes("embedding")) return "text";
  if (m.includes("image") || m.includes("video")) return "visual";
  return "audio";
}

/**
 * THE ROUTING FILTER. Only these may be picked for a chat/completion lane.
 *
 * `embedding` does NOT qualify: Voyage sits in the Text section because embeddings are text-shaped,
 * but it cannot answer a completion, so grouping and routability are genuinely different questions.
 */
export function isTextRoutable(spec: AiProviderSpec): boolean {
  return providerModalities(spec).includes("text");
}

/** Provider ids any agent lane may route a chat request to. */
export function textRoutableProviders(): string[] {
  return AI_PROVIDERS.filter(isTextRoutable).map((p) => p.id);
}

/** Rows grouped for the admin console, in header order, skipping empty sections. */
export function providersByCategory(): Array<{
  category: AiProviderCategory;
  label: string;
  providers: readonly AiProviderSpec[];
}> {
  return AI_PROVIDER_CATEGORY_ORDER.map((category) => ({
    category,
    label: AI_PROVIDER_CATEGORY_LABEL[category],
    providers: AI_PROVIDERS.filter((p) => providerCategory(p) === category),
  })).filter((group) => group.providers.length > 0);
}
