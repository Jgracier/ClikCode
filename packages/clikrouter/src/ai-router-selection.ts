// ============================================
// AI ROUTER SELECTION — the ranking logic behind every "auto/budget/frontier/explicit" choice.
// ============================================
// ONE ranking algorithm, used both by the persisted per-agent routing strategy
// (AiRoutingStrategy in ai-routing.ts — what automatic production routing actually does) and by
// the admin test-chat picker (previously a second, disconnected implementation that only lived in
// apps/web and used a cruder cost-only ranking for automatic modes) — so testing an agent's
// "Auto" mode and that agent's real automatic routing are provably the same computation, not two
// systems that happened to agree by coincidence.
//
// Pure and dependency-free on purpose: no db/redis/env access, so it is safe for both the server
// (ai-default-llm.ts) and — if a client ever needs it — a browser bundle.

/**
 * 'auto' / 'auto-budget' / 'auto-frontier' are the "auto family" — all three
 * blend intelligence, access tier, cost, and latency into ONE composite score
 * via `autoComposite` (see AUTO_COMPOSITE_WEIGHTS below for how the three
 * differ), and all three explore under-sampled candidates via
 * `applyExploration`. 'auto' is the balanced point among them and keeps its
 * EXACT pre-existing meaning/weights — nothing about its behavior changed
 * when the other two were added, so anything that already persisted the
 * literal string 'auto' keeps working unchanged.
 *
 * 'budget' / 'frontier' are a DELIBERATELY DIFFERENT, blunter pair: a rigid
 * lexicographic sort (cost-then-tiebreak, or intelligence-then-tiebreak — see
 * `compareScored`) with zero exploration, for a caller that wants an exact,
 * repeatable answer ("cheapest, period" / "strongest, period") rather than a
 * judgment call. They are not a lesser version of auto-budget/auto-frontier;
 * they answer a different question on purpose and are left untouched by the
 * auto-family additions.
 */
export type AiRoutingStrategy = 'auto' | 'auto-budget' | 'auto-frontier' | 'budget' | 'frontier' | 'explicit';

/** True for any of the three composite-blending, exploring modes — the
 *  grouping `compareScored`, `rankRouterCandidatesWithScores`, and
 *  `applyExploration` all key off of to decide "does this mode use the
 *  blended composite / explore" as opposed to a rigid lexicographic sort. */
function isAutoFamily(mode: AiRoutingStrategy): mode is 'auto' | 'auto-budget' | 'auto-frontier' {
  return mode === 'auto' || mode === 'auto-budget' || mode === 'auto-frontier';
}

export interface AiRouterCandidate {
  provider: string;
  model: string;
  /**
   * 'subscription' — an OAuth credential dispatched DIRECTLY over HTTP
   * (subscriptionTransport: 'direct' — Codex, Code Assist). 'subscription-
   * harness' — an OAuth credential spent through the vendor's own CLI
   * (subscriptionTransport: 'harness' — Anthropic → Claude Code). Both are
   * "you already have access, this is not metered spend" for ranking/cost
   * purposes (see ACCESS_RANK below), but kept as distinct literals so a
   * consumer can tell "plain HTTP call" apart from "runs a real subprocess"
   * by accessClass alone — the harness tier carries a materially bigger
   * trust surface that a user-facing dispatch mode must be able to exclude
   * without also excluding the direct one.
   */
  accessClass: 'subscription' | 'subscription-harness' | 'free-tier' | 'metered' | 'unknown';
  estimatedCostPerMTok: number | null;
  /**
   * Live exponential-moving-average response latency in ms (ai-model-latency.ts),
   * or null/absent when never observed. This file stays pure/dependency-free
   * (see the module comment), so it never reads Redis itself — the caller
   * (ai-router-candidates.ts) fetches it and attaches it here, the same way it
   * already does for accessClass/estimatedCostPerMTok.
   */
  avgLatencyMs?: number | null;
  /**
   * Real third-party agentic-capability score, 0-100 (ai-openrouter-
   * benchmarks.ts's `agentic_index`), when this exact (provider, model) pair
   * matched OpenRouter's public catalog — absent for the majority of pairs
   * (measured live: only ~10 of 43 providers even share a namespace with
   * OpenRouter, so most candidates never get this). Same caller-attaches
   * posture as avgLatencyMs; this file never fetches it itself.
   */
  agenticIndex?: number | null;
  /**
   * LMArena text-arena human-preference rating, percentile-scaled to 0-100
   * across the current leaderboard snapshot (platform-domains'
   * ai-quality-feed.ts) — a SECOND real intelligence source with much wider
   * coverage than agenticIndex, matched onto our model ids by conservative
   * name normalization (unambiguous matches only, never a guess). A
   * DIFFERENT measurement than agenticIndex (crowd preference on chat
   * answers vs. a measured agentic benchmark), so it is its own field:
   * `baseCapabilityScore` prefers agenticIndex where present and only fills
   * with this where agenticIndex is absent. Same caller-attaches posture as
   * avgLatencyMs; this file never fetches it itself.
   */
  arenaScore?: number | null;
  /**
   * Real observed success rate in [0, 1] from THIS platform's own routing
   * history (ai-model-track-record.ts), only present once there is enough of
   * it to trust (see that module's MIN_TRACK_RECORD_SAMPLES) — absent means
   * "no track record yet", never "confirmed unreliable". Same caller-attaches
   * posture as avgLatencyMs.
   */
  trackRecordSuccessRate?: number | null;
  /**
   * Trailing-14-day count of real observed "I don't have that capability"
   * hallucinations FROM THIS EXACT MODEL, despite a real tool being attached
   * to the call (ai-model-capability.ts's recordObservedCapabilityRefusal /
   * readCapabilityRefusalCounts — cross-provider, keyed by
   * normalizeModelKey). Absent or 0 means no observed refusals, never
   * "confirmed reliable". Same caller-attaches posture as avgLatencyMs.
   */
  capabilityRefusalCount?: number | null;
  /**
   * Real observed rate in [0, 1] of this (provider, model) pair FINISHING an
   * agent-loop turn with a real answer, vs. giving up mid-task
   * (ai-model-task-completion.ts's getModelSustainRates — see MIN_SUSTAIN_SAMPLES
   * for the trust floor). A DIFFERENT question than trackRecordSuccessRate:
   * that answers "did the dispatch call error", this answers "did the model
   * actually complete the multi-step task it was given" — the two are
   * independent (MEASURED: a model can dispatch cleanly on every individual
   * tool call and still never produce a final answer). Absent means "not
   * enough agent-loop samples yet", never "confirmed can't finish long
   * tasks" — same caller-attaches posture as avgLatencyMs.
   */
  sustainRate?: number | null;
  /** Sample size backing sustainRate, for callers that want their own trust
   *  threshold instead of relying on the read layer's MIN_SUSTAIN_SAMPLES gate. */
  sustainSampleSize?: number | null;
}

export interface AiRouterSelection {
  provider: string;
  model: string;
  reason: string;
}

/**
 * The scored breakdown behind ONE candidate's position in the ranking —
 * the terms `rankRouterCandidates`'s comparator uses, made visible instead of
 * being computed and discarded inside a sort callback. `compositeScore` is
 * only meaningful for auto-family modes ('auto' / 'auto-budget' /
 * 'auto-frontier' — the only modes that blend terms into one number); the
 * other modes rank lexicographically over these same terms in a fixed
 * priority order (see `compareScored`'s per-mode branches).
 */
export interface AiRouterCandidateScore {
  candidate: AiRouterCandidate;
  accessRank: number;
  cost: number;
  intelligence: number;
  latencyMs: number;
  compositeScore: number | null;
}

const ACCESS_RANK: Record<AiRouterCandidate['accessClass'], number> = {
  'free-tier': 0,
  subscription: 1,
  // Same rank as 'subscription' — both are non-metered included capacity;
  // the transport distinction matters for ELIGIBILITY (ai-router-candidates.ts),
  // not for how a harness-dispatched candidate should rank once it IS eligible.
  'subscription-harness': 1,
  metered: 2,
  unknown: 3,
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 50: the flat score for a candidate with NO real capability evidence at
 * all — no OpenRouter agentic_index match (ai-openrouter-benchmarks.ts) and
 * no track record yet (ai-model-track-record.ts). This file used to guess a
 * tier from the model's NAME via a regex (gpt-5/claude-opus/… → 110, "flash"/
 * "mini" → 60, anything else → 75) — a genuine guess dressed up as a score,
 * and it was actively winning against REAL data: an unbenchmarked model
 * defaulted to 110 while a real, measured flagship could score lower (Claude
 * Opus 5's actual agentic_index is 59.2), so the fabricated number was
 * outranking the true one. Removed entirely rather than kept as a fallback —
 * "never use unverified data for model intelligence" means exactly that, not
 * "prefer verified data when convenient".
 *
 * 50 sits in the middle of the plausible 0-100 agentic_index range on
 * purpose, not derived from a live-data snapshot (a hardcoded median would
 * just be a slower-moving version of the same guessing problem). It is
 * ABOVE real low scores this platform has actually observed (nvidia's
 * Nemotron-3-Nano measured 2, several others sit in the 20s-30s) and BELOW
 * real high scores (Claude Opus 5 at 59.2, Claude Fable 5 at 56.6) — a
 * measured LOW score is real negative evidence and must still rank below an
 * unknown-quality model, same as a measured HIGH score must still rank
 * above one. "Unknown" is genuinely neutral, never a synonym for "assume the
 * best" or "assume the worst".
 *
 * Coverage is currently thin — measured live 2026-08-09: only 17 of 629 real
 * routable (provider, model) pairs had a benchmark match at all. Most
 * candidates get this neutral default today, which means "frontier" mode
 * mostly stops differentiating on capability until real evidence (benchmark
 * coverage growing, or this platform's own track record accumulating
 * enough samples) exists to differentiate with — that is the honest state
 * of what is actually known, not a regression to fix by guessing again.
 */
const NEUTRAL_CAPABILITY_SCORE = 50;

/**
 * Real third-party capability data, in strict precedence order — never a
 * name-based guess:
 *   1. `agenticIndex` (ai-openrouter-benchmarks.ts's `agentic_index`) — a
 *      MEASURED agentic benchmark, the closest thing to what this router
 *      actually dispatches (tool-calling agent loops), used directly, not
 *      remapped through an invented conversion formula.
 *   2. `arenaScore` (platform-domains' ai-quality-feed.ts) — LMArena
 *      human-preference Elo, percentile-scaled to the same 0-100 range so
 *      the snapshot's median model lands at exactly NEUTRAL_CAPABILITY_SCORE
 *      (see that module's SCALING CHOICE header). Wider coverage, weaker
 *      task-fit (crowd chat preference ≠ agentic ability), so it only FILLS
 *      where the measured agentic number is absent — it never overrides it.
 *   3. NEUTRAL_CAPABILITY_SCORE when neither exists.
 */
function baseCapabilityScore(candidate: AiRouterCandidate): number {
  if (typeof candidate.agenticIndex === 'number' && Number.isFinite(candidate.agenticIndex)) {
    return candidate.agenticIndex;
  }
  if (typeof candidate.arenaScore === 'number' && Number.isFinite(candidate.arenaScore)) {
    return candidate.arenaScore;
  }
  return NEUTRAL_CAPABILITY_SCORE;
}

/**
 * Capability (above), discounted by real observed reliability on THIS
 * platform when there is enough of it to trust — a MULTIPLIER, not a
 * replacement: capability answers "how smart is this model" (a real
 * benchmark, or neutral when unknown), reliability answers "does it
 * actually deliver that for us" (from our own routing history), and those
 * are genuinely different questions. A model this platform has actually
 * seen succeed only 40% of the time is not delivering its benchmark
 * intelligence to real users regardless of how it scored on someone else's
 * eval, so its effective score here is crushed accordingly. Absent track
 * record (never routed to here yet, or too few recent samples — see
 * ai-model-track-record.ts) leaves capability unadjusted: "no track record
 * yet" must never be penalized the way "confirmed unreliable" is.
 */
function intelligenceWithReliability(candidate: AiRouterCandidate): number {
  let capability = baseCapabilityScore(candidate);
  if (
    typeof candidate.trackRecordSuccessRate === 'number' &&
    Number.isFinite(candidate.trackRecordSuccessRate)
  ) {
    capability *= candidate.trackRecordSuccessRate;
  }
  // A SECOND, independent multiplier — deliberately not folded into the
  // track-record one above: trackRecordSuccessRate answers "did the HTTP
  // call succeed", while this answers "did the model actually USE an
  // available tool instead of hallucinating a refusal" — a real model this
  // platform has caught doing that repeatedly gets discounted here even on
  // a call that "succeeded" by every other measure. A NUDGE, not a ban —
  // 15% off per observed refusal, floored at a 60% total cut, so a model
  // with real advantages elsewhere (free/subscription access, low latency)
  // can still win; it just has to actually earn it against a clean-record
  // alternative instead of coasting on being cheapest. See
  // ai-model-capability.ts's own header for why this is a decaying,
  // cross-provider, "nudge not ban" signal rather than the binary
  // vendor/tested/observed tool-calling-SUPPORT tiers above it.
  if (
    typeof candidate.capabilityRefusalCount === 'number' &&
    Number.isFinite(candidate.capabilityRefusalCount) &&
    candidate.capabilityRefusalCount > 0
  ) {
    const refusalFactor = Math.max(0.4, 1 - candidate.capabilityRefusalCount * 0.15);
    capability *= refusalFactor;
  }
  // A THIRD, independent multiplier, same "real evidence, no threshold
  // means unadjusted" shape as the two above. Diagnosed root cause of a real
  // production bug: NEUTRAL_CAPABILITY_SCORE collapses ~97% of candidates to
  // the same flat 50 (no OpenRouter benchmark match), so a tied score fell
  // through to "whichever model answers fastest" — a small, cheap model
  // that reliably gives up mid-task still won on latency alone, because
  // nothing measured whether it could actually FINISH a multi-step loop.
  // sustainRate is that missing measurement, sourced from this platform's
  // own agent-loop outcomes (ai-model-task-completion.ts), not a guess.
  // sustainSampleSize is read here (not just trusted from the read layer's
  // MIN_SUSTAIN_SAMPLES gate) so this file stays honest about its own
  // trust threshold rather than silently inheriting whatever the caller
  // happened to fetch with.
  if (
    typeof candidate.sustainRate === 'number' &&
    Number.isFinite(candidate.sustainRate) &&
    typeof candidate.sustainSampleSize === 'number' &&
    candidate.sustainSampleSize >= MIN_SUSTAIN_SAMPLES_TRUSTED
  ) {
    capability *= candidate.sustainRate;
  }
  return capability;
}

/** Mirrors ai-model-task-completion.ts's own MIN_SUSTAIN_SAMPLES — duplicated
 *  here (this file is deliberately dependency-free, see the module header)
 *  rather than imported, so a caller that fetched with a looser threshold
 *  can never leak an under-trusted rate into scoring. */
const MIN_SUSTAIN_SAMPLES_TRUSTED = 5;

/**
 * Catches a model that is almost certainly NOT chat-capable, from its id
 * alone — the router has nothing else to go on. `isTextRoutable`
 * (ai-provider-registry's lookups.ts) already excludes whole PROVIDERS whose
 * only modality is non-text (voyage, elevenlabs, fal, …), which is real data,
 * not a guess. This exists for the gap that leaves open: a provider that DOES
 * serve chat (Cloudflare, Groq, HuggingFace, Mistral, …) but ALSO lists
 * TTS/embedding/image/ASR/moderation models in the SAME catalog, with no
 * per-model modality field anywhere in the schema to check instead (verified:
 * AiDiscoveredModel carries only id/pricing/enabled). Observed live via
 * `clikdeploy admin ai chat --explain`: cloudflare/@cf/baai/bge-base-en-v1.5
 * (an embedding model) and groq/whisper-large-v3-turbo (speech-to-text) both
 * ranked as router candidates for a plain text chat request.
 *
 * Deliberately a DENYLIST, not an allowlist: an allowlist of "known chat
 * model name shapes" would silently exclude every future chat model whose
 * name doesn't match a pattern written today. A denylist only ever excludes
 * what it explicitly recognizes as non-chat, so an unrecognized new model
 * defaults to ELIGIBLE — the same "unknown is not confirmed bad" principle
 * `NEUTRAL_CAPABILITY_SCORE` above already applies to capability tier.
 *
 * False negatives (a genuine chat model this misses and wrongly excludes)
 * are the failure mode to watch for — a name containing "vision" or
 * "instruct" must never trip these patterns just because it also contains a
 * substring like "tts" or "embed" as part of an unrelated word.
 */
export function isLikelyChatModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const patterns: RegExp[] = [
    // Text-to-speech / audio generation.
    /\btts\b|-tts-|-tts$|text-to-speech|\bspeech-\d|melotts|\baura(-\d)?\b|\bsonic\b/,
    // Speech-to-text / transcription / audio-in chat.
    //
    // `voxtral` is Mistral's AUDIO family and is the reason this line was widened.
    // MEASURED 2026-08-10: with cliknet enabled, EVERY remediation run for the whole
    // 20-app fleet routed to mistral/voxtral-small-latest and voxtral-small-2507 —
    // an audio model handed tool definitions to propose code fixes. Mistral's catalog
    // publishes no per-model modality field, so `chatCapable` was undefined and this
    // heuristic was the only thing standing between an audio model and the agent lane;
    // it recognized no `voxtral` shape, so the model was treated as chat-eligible.
    // Confirmed against the live router state: no `ai:model-chat-capable:voxtral-*`
    // key exists, i.e. no vendor ever published a verdict for it.
    /whisper|paraformer|transcribe|nova-\d.*transcri|\basr\b|voxtral|\bqwen\d*-audio\b|-audio$|-audio-|audio-preview|\bseamless(m4t)?\b|\bwav2vec\b|\bmms-\d/,
    // Embeddings / reranking.
    /\bembed(ding)?s?\b|-embed-|bge-|gte-|(^|-)e5-|nomic-embed|embeddinggemma|\brerank(er)?\b/,
    // Image / video generation.
    /flux|stable-diffusion|\bsdxl\b|dall-e|gpt-image|\bimagen\b|dreamshaper|-image$|-image-|image-lightning|inpainting|img2img|\bveo\b|\bsora\b|^ray-|-video$|-video-|video-01|minimax-video|speech-02/,
    // Moderation / safety / guard classifiers — real models, never a chat
    // answer's source.
    /omni-moderation|llama-guard|nemoguard|-guard-|safeguard|content-safety|topic-control/,
    // Misc non-chat utility models observed in mixed catalogs.
    /\bocr\b|resnet|\bdetr\b|m2m100|\bnllb\b|indictrans/,
  ];
  return !patterns.some((re) => re.test(id));
}

/**
 * An ABSOLUTE veto, checked BEFORE any vendor `chatCapable` field — unlike
 * every other exclusion in this file, a real modality fact from the vendor
 * is deliberately NOT allowed to override this one.
 *
 * Fill-In-the-Middle (code-completion: prompt+suffix, not chat turns) is a
 * REQUEST-SHAPE incompatibility, not a modality question `chatCapable` was
 * designed to answer. MEASURED LIVE 2026-08-10: Mistral's catalog publishes
 * `capabilities.completion_chat: true` for mistral-code-fim-latest — almost
 * certainly meaning "reachable via our /v1/chat/completions endpoint" (true
 * for nearly every model Mistral hosts, FIM included), not "accepts
 * open-ended conversation". Routed to for a real user's AI_ASSISTANT_CHAT
 * turn, it produced exactly the unusable non-answer ("I don't have that
 * capability") a model built for prompt/suffix completion would, since this
 * platform only ever sends normal chat-turn requests, never FIM-shaped
 * (prompt/suffix) ones. A vendor field answering a different question than
 * the one being asked is not real evidence for THIS question, so it does
 * not get the usual "vendor beats heuristic" precedence here.
 */
export function isFillInMiddleModel(modelId: string): boolean {
  return /\bfim\b|-fim-|-fim$/i.test(modelId);
}

/**
 * A SECOND absolute veto, same precedence and same reasoning shape as
 * isFillInMiddleModel above — checked BEFORE any vendor `chatCapable` field,
 * never overridden by one.
 *
 * MEASURED LIVE 2026-08-11, cross-referenced against the full production
 * catalog: safety/moderation classifiers — Llama Guard (meta/llama-guard-*,
 * meta-llama/Llama-Guard-*), Llama Prompt Guard, NVIDIA's Nemoguard/
 * content-safety family, openai/gpt-oss-safeguard-20b — carry `chatCapable:
 * true` from SOME catalogs (HuggingFace and OpenRouter both publish
 * `architecture.output_modalities: ["text"]` for these, because the model
 * genuinely does emit text: a classification verdict, not a conversational
 * reply) while OTHER catalogs for the identical id publish no chatCapable
 * field at all. Either way the vendor field is answering "does this model
 * produce text output", not "does it hold a conversation" — the exact same
 * category error isFillInMiddleModel's own doc comment describes for
 * mistral-code-fim-latest. Routing a real chat turn to a safety classifier
 * would return a moderation verdict ("safe"/"unsafe" or similar), not an
 * answer to the user's question — a materially worse failure than the
 * FIM case, since nothing about the response would look like an error to
 * the caller.
 *
 * Deliberately name/id-pattern-based rather than trying to read a
 * capabilities.moderation-style field: no catalog in this platform's probe
 * coverage publishes one, so a name veto is the only real signal available,
 * same justification NEUTRAL_CAPABILITY_SCORE gives for why a heuristic is
 * sometimes the honest fallback rather than a fabricated field read.
 */
export function isSafetyClassifierModel(modelId: string): boolean {
  return /guard|nemoguard|safeguard|content-safety|topic-control|moderation/i.test(modelId);
}

/**
 * Whether a model is eligible for text chat routing, preferring real
 * evidence over a guess: a discovered model's `chatCapable` field (set at
 * catalog-parse time from the vendor's OWN per-model modality field —
 * OpenRouter/HuggingFace architecture.output_modalities, Cloudflare
 * task.name — see probe-adapters.ts's deriveChatCapable) is authoritative
 * when the vendor published one for this model. `isLikelyChatModel`'s name
 * heuristic is only the fallback for the (common) case where the vendor's
 * catalog carries no modality field at all. isFillInMiddleModel and
 * isSafetyClassifierModel are checked FIRST and override both — see their
 * own doc comments for why.
 */
export function resolveChatCapable(model: {
  id: string;
  chatCapable?: boolean;
}): boolean {
  if (isFillInMiddleModel(model.id) || isSafetyClassifierModel(model.id)) return false;
  return model.chatCapable !== undefined
    ? model.chatCapable
    : isLikelyChatModel(model.id);
}

function costScore(cost: number | null): number {
  if (typeof cost !== 'number' || Number.isNaN(cost) || !Number.isFinite(cost)) return 1_000_000;
  return cost;
}

/**
 * 3s: the neutral latency assumed for a candidate with no observed average
 * yet (never routed to, or its 24h window lapsed). Deliberately mid-pack —
 * a brand-new candidate should not outrank a PROVEN-fast one on the strength
 * of having no data (that would make "never tried" a strategy), but it also
 * must not be penalized as if it were confirmed slow, which would mean a
 * newly configured model can never win a ranking until routed to once by
 * some other means. Same "unknown is not confirmed bad" reasoning as
 * NEUTRAL_CAPABILITY_SCORE above.
 */
const NEUTRAL_LATENCY_MS = 3_000;

function latencyScore(avgLatencyMs: number | null | undefined): number {
  if (typeof avgLatencyMs !== 'number' || Number.isNaN(avgLatencyMs) || !Number.isFinite(avgLatencyMs)) {
    return NEUTRAL_LATENCY_MS;
  }
  return Math.max(0, avgLatencyMs);
}

/** The mode-level rationale shown to the admin — shared by selectRouterCandidate
 *  and by callers that pick from rankRouterCandidates themselves (e.g. a
 *  fallback loop) and need the same "why this mode chose this" text. */
export function reasonFor(mode: AiRoutingStrategy, normalizedPreferred?: string): string {
  if (mode === 'budget') {
    return 'Budget mode selected the cheapest access tier, then the cheapest priced model in it.';
  }
  if (mode === 'frontier') {
    return 'Frontier mode prioritized the strongest intelligence tier while keeping the cheapest option in that tier.';
  }
  if (mode === 'auto') {
    return 'Auto mode balanced intelligence versus cost and preferred free or low-cost coverage.';
  }
  if (mode === 'auto-budget') {
    return 'Auto-budget mode blended the same evidence as auto, tilted toward cheap and included access, while still letting capability decide between similarly-priced options.';
  }
  if (mode === 'auto-frontier') {
    return 'Auto-frontier mode blended the same evidence as auto, tilted toward the strongest capability, while still letting a nearly-as-capable free or low-cost option win over a needlessly expensive one.';
  }
  return normalizedPreferred
    ? 'Exact model preference resolved to the most suitable available provider and model.'
    : 'Explicit mode used the selected provider/model directly.';
}

/** Score every candidate on the four terms the comparator below reads, plus
 *  the single composite number 'auto' mode blends them into (null for every
 *  other mode, which ranks lexicographically over these terms instead of
 *  blending them — see `compareScored`). This is a pure function of ONE
 *  candidate; it does not know about `mode`'s tie-break ORDER, only about
 *  what each term IS. */
function scoreOne(candidate: AiRouterCandidate): Omit<AiRouterCandidateScore, 'candidate' | 'compositeScore'> {
  return {
    accessRank: ACCESS_RANK[candidate.accessClass],
    cost: costScore(candidate.estimatedCostPerMTok),
    intelligence: intelligenceWithReliability(candidate),
    latencyMs: latencyScore(candidate.avgLatencyMs),
  };
}

/**
 * The four coefficients `autoComposite` blends with — one named preset per
 * auto-family strategy. All three keep the exact same FORMULA SHAPE (a
 * linear blend of intelligence, accessRank, costPenalty, and latency — see
 * `autoComposite` below); only the weights move. That constraint matters:
 * a structurally different formula per preset would make "auto-budget" and
 * "auto-frontier" a genuinely different algorithm from 'auto' rather than
 * the same judgment tilted toward a different point on the cost↔capability
 * dial, which is the whole product ask.
 *
 * `balanced` is 'auto' — copied verbatim from the coefficients this file has
 * always used (intelligence×1.25, accessRank×10, costPenalty rate 0.01,
 * latency×2). NOT allowed to move: anything already relying on 'auto''s
 * exact ranking behavior must see zero change.
 *
 * `budgetLeaning` ('auto-budget') roughly HALVES the intelligence weight
 * (1.25 → 0.6) and roughly DOUBLES both the accessRank weight (10 → 16, a
 * ~60% bump) and the cost-penalty rate (0.01 → 0.02) relative to balanced —
 * cost and included-access-tier now dominate the blend the way they do for
 * literal 'budget' mode's primary sort key, but intelligence is still worth
 * real points, not reduced to a mere tiebreak: two similarly-cheap
 * candidates with a real capability gap (say, a 20-point agentic_index
 * difference) still separate by ~12 composite points at 0.6 weight — smaller
 * than balanced's ~25, but nowhere near zero, which is exactly what keeps
 * this a genuine blend instead of literal 'budget' mode's rigid cost-primary
 * sort (where intelligence only ever breaks an EXACT cost tie). Latency
 * weight is left unchanged: a budget-conscious caller still doesn't want a
 * dramatically slower model just because it's marginally cheaper, and
 * latency was never the axis this preset is meant to move.
 *
 * `frontierLeaning` ('auto-frontier') roughly DOUBLES the intelligence
 * weight (1.25 → 2.5) and roughly HALVES both the accessRank weight (10 → 6)
 * and the cost-penalty rate (0.01 → 0.005) relative to balanced —
 * capability now dominates the blend the way it does for literal 'frontier'
 * mode's primary sort key, but cost/access still meaningfully move the
 * score: at 0.005 per estimated-cost-per-MTok-dollar-cent-equivalent unit, a
 * free-tier or cheap candidate within a few intelligence points of a
 * needlessly expensive metered one can still come out ahead once the
 * expensive one's cost penalty and access-rank cost stack up — literal
 * 'frontier' mode would never let that happen, since cost there only ever
 * breaks an EXACT intelligence tie. Latency weight is left unchanged for the
 * same reason as budgetLeaning: it was never the axis either preset is
 * meant to move, and a big latency swing should keep mattering the same
 * amount no matter which end of the cost↔capability dial the caller leans
 * toward.
 */
const AUTO_COMPOSITE_WEIGHTS: Record<
  'auto' | 'auto-budget' | 'auto-frontier',
  { intelligence: number; accessRank: number; costPenaltyRate: number; latency: number }
> = {
  auto: { intelligence: 1.25, accessRank: 10, costPenaltyRate: 0.01, latency: 2 },
  'auto-budget': { intelligence: 0.6, accessRank: 16, costPenaltyRate: 0.02, latency: 2 },
  'auto-frontier': { intelligence: 2.5, accessRank: 6, costPenaltyRate: 0.005, latency: 2 },
};

/** The auto-family's blended composite — the ONE place this formula is
 *  written, parameterized by which of the three named weight presets
 *  (AUTO_COMPOSITE_WEIGHTS above) to blend with. Defaults to 'auto' (the
 *  balanced preset, i.e. this function's original pre-auto-family behavior)
 *  so existing call sites that never pass a mode keep working unchanged.
 *
 *  Latency in whole seconds so its weight is comparable to the other terms:
 *  at the shared latency×2 weight, a candidate answering 10s slower loses
 *  ~20 points, roughly one intelligence tier's worth of movement — enough to
 *  matter, not enough for a merely-average-latency frontier model to lose to
 *  a fast-but-weak one.
 *
 *  Cost only enters the blend for metered/unknown access — subscription and
 *  free-tier candidates cost the caller nothing PER CALL (the whole point of
 *  accessRank's negative spread already capturing that), so their own
 *  estimatedCostPerMTok is either the underlying metered-equivalent rate
 *  (irrelevant — not what gets billed) or absent entirely. `costScore`
 *  returns a sentinel 1_000_000 for "no price on file", which is correct as
 *  budget/frontier's TIEBREAK (sort by accessRank/intelligence first, so the
 *  sentinel only ever separates two already-tied candidates) but is fatal
 *  here: at balanced's 0.01 rate it is a flat -10,000, dwarfing every other
 *  term (and worse at budgetLeaning's steeper 0.02). Observed live:
 *  subscription flagships with no per-token price (OAuth plans simply don't
 *  have one — anthropic/claude-sonnet-4-5, openai/gpt-5.6) scored around
 *  -9,878 despite tier-110 intelligence, guaranteeing they lose to any
 *  priced free-tier candidate no matter the intelligence gap. */
function autoComposite(s: AiRouterCandidateScore, mode: 'auto' | 'auto-budget' | 'auto-frontier' = 'auto'): number {
  const weights = AUTO_COMPOSITE_WEIGHTS[mode];
  const costPenalty =
    s.candidate.accessClass === 'metered' || s.candidate.accessClass === 'unknown'
      ? s.cost * weights.costPenaltyRate
      : 0;
  return (
    s.intelligence * weights.intelligence -
    s.accessRank * weights.accessRank -
    costPenalty -
    (s.latencyMs / 1000) * weights.latency
  );
}

/** Best-first comparator over precomputed scores — the single source of
 *  truth both `rankRouterCandidates` (existing callers, unchanged shape) and
 *  `rankRouterCandidatesWithScores` (the new explain-everything caller) sort
 *  with, so the two can never silently disagree on order. */
function compareScored(mode: AiRoutingStrategy, a: AiRouterCandidateScore, b: AiRouterCandidateScore): number {
  if (mode === 'budget') {
    // Cheapest access tier first, then cheapest actual price — cost is
    // budget mode's whole point, so it has to be the primary key, not a
    // tiebreak. Intelligence, then live latency, decide ties at equal cost.
    if (a.accessRank !== b.accessRank) return a.accessRank - b.accessRank;
    if (a.cost !== b.cost) return a.cost - b.cost;
    return (
      b.intelligence - a.intelligence ||
      a.latencyMs - b.latencyMs ||
      a.candidate.model.localeCompare(b.candidate.model)
    );
  }

  if (mode === 'frontier') {
    if (a.intelligence !== b.intelligence) return b.intelligence - a.intelligence;
    if (a.accessRank !== b.accessRank) return a.accessRank - b.accessRank;
    return a.cost - b.cost || a.latencyMs - b.latencyMs || a.candidate.model.localeCompare(b.candidate.model);
  }

  if (isAutoFamily(mode)) {
    // 'auto' / 'auto-budget' / 'auto-frontier' all take this SAME blended-
    // composite path — only the weight preset `autoComposite` blends with
    // differs (see AUTO_COMPOSITE_WEIGHTS). This is the one place that
    // distinction is made: everything else about how the composite is used
    // to rank (best-first, cost/latency/name tiebreak on an exact tie) is
    // shared across all three.
    const aScore = a.compositeScore ?? autoComposite(a, mode);
    const bScore = b.compositeScore ?? autoComposite(b, mode);
    if (aScore !== bScore) return bScore - aScore;
    return a.cost - b.cost || a.latencyMs - b.latencyMs || a.candidate.model.localeCompare(b.candidate.model);
  }

  // 'explicit' as a FALLBACK-CHAIN ranking (not a single named model — that path never ranks at
  // all) means "no smart preference beyond cost", the same deterministic floor 'budget' uses as
  // its own tiebreak, so an admin-pinned model's own fallback list still lands somewhere sane.
  // Live latency breaks cost ties before the final alphabetical floor.
  return a.cost - b.cost || a.latencyMs - b.latencyMs || a.candidate.model.localeCompare(b.candidate.model);
}

function filterByPreference(
  candidates: AiRouterCandidate[],
  preferredModel: string | undefined,
): AiRouterCandidate[] {
  const normalizedPreferred = preferredModel?.trim().toLowerCase();
  if (!normalizedPreferred) return candidates;
  const filtered = candidates.filter((candidate) => normalize(candidate.model).includes(normalizedPreferred));
  return filtered.length > 0 ? filtered : candidates;
}

/**
 * Every eligible candidate, ranked best-first for `mode`, WITH the score
 * breakdown that put it there — the "why" a canned per-mode sentence cannot
 * express (which candidates were even considered, and by how much the winner
 * actually won). `rankRouterCandidates` below is a thin projection of this
 * for the many callers that only ever wanted the candidate list.
 */
export function rankRouterCandidatesWithScores(
  candidates: AiRouterCandidate[],
  mode: AiRoutingStrategy,
  preferredModel?: string,
): AiRouterCandidateScore[] {
  if (candidates.length === 0) return [];
  const pool = filterByPreference(candidates, preferredModel);
  const scored: AiRouterCandidateScore[] = pool.map((candidate) => {
    const base = scoreOne(candidate);
    const withCandidate = { candidate, ...base, compositeScore: null };
    return { ...withCandidate, compositeScore: isAutoFamily(mode) ? autoComposite(withCandidate, mode) : null };
  });
  return scored.sort((a, b) => compareScored(mode, a, b));
}

/**
 * Every eligible candidate, ranked best-first for `mode`. Callers that need
 * resilience (auto/budget/frontier) should walk this list and fall back to
 * the next entry on failure, rather than trusting the top pick to always be
 * reachable — a router mode's whole promise is "give me AN answer", not
 * "give me this one specific model or nothing". Only `explicit` mode, where
 * the caller named one exact model, should fail on that model's own error.
 */
export function rankRouterCandidates(
  candidates: AiRouterCandidate[],
  mode: AiRoutingStrategy,
  preferredModel?: string,
): AiRouterCandidate[] {
  return rankRouterCandidatesWithScores(candidates, mode, preferredModel).map((s) => s.candidate);
}

/** Top-ranked candidate only — explicit mode, tests, and any caller that
 *  doesn't need fallback. Prefer `rankRouterCandidates` for auto/budget/frontier
 *  call sites so a failed top pick doesn't dead-end the whole request. */
export function selectRouterCandidate(
  candidates: AiRouterCandidate[],
  mode: AiRoutingStrategy,
  preferredModel?: string,
): AiRouterSelection | null {
  const ranked = rankRouterCandidates(candidates, mode, preferredModel);
  const selected = ranked[0];
  if (!selected) return null;
  return {
    provider: selected.provider,
    model: selected.model,
    reason: reasonFor(mode, preferredModel?.trim().toLowerCase()),
  };
}

/**
 * Floor on the fraction of 'auto'-mode resolutions that deliberately pick an
 * under-sampled candidate instead of the top-ranked one. WHY THIS EXISTS:
 * every real-evidence signal in this file (trackRecordSuccessRate,
 * sustainRate, capabilityRefusalCount) only ever influences ranking once a
 * candidate has enough samples to trust — correct, per each signal's own
 * "absence is not evidence" contract, but it creates a cold-start trap on
 * its own: a candidate that starts out ranked low (say, on latency or cost
 * alone) gets picked rarely, and because it's picked rarely it never
 * accumulates the samples that could otherwise raise or confirm its
 * ranking. Rich-get-richer, purely from lack of chances — the model might
 * be perfectly fine. 5% is deliberately small: this trades a small, bounded
 * share of "best guess right now" for the platform's own ability to keep
 * learning, not a general randomization of routing.
 *
 * This is a FLOOR, not the whole story, because 5% was tuned against "a few
 * dozen" candidates. A flat rate spreads that same 5% budget across however
 * many under-explored candidates happen to be in the ranked list — with a
 * few dozen, each cold-start candidate gets picked every few requests; with
 * hundreds (this registry already lists 43 providers, and each can host many
 * models), the same 5% divided across a much bigger pool means any one
 * candidate's odds of getting an exploratory pick shrink toward
 * irrelevance — the exact starvation this mechanism exists to prevent, just
 * moved one level up. See `explorationRateFor` for how the effective rate
 * scales past this floor as the under-explored pool grows.
 */
export const EXPLORATION_RATE_FLOOR = 0.05;

/**
 * Ceiling on the effective exploration rate, regardless of how large the
 * under-explored pool gets. This is still live routing traffic for real user
 * requests — exploration must stay a small minority of it even at registry-
 * wide scale, or "learning about cold-start candidates" starts meaningfully
 * degrading normal-case answer quality, which defeats the purpose (a router
 * nobody trusts doesn't get to keep learning either). 3x the floor: enough
 * that a candidate in a huge pool gets meaningfully more frequent chances
 * than the diluted flat-5% baseline would give it, nowhere near "exploration
 * is now a routine fraction of traffic".
 */
export const EXPLORATION_RATE_CEILING = 0.15;

/**
 * Size of the under-explored pool that 5% (EXPLORATION_RATE_FLOOR) was
 * actually tuned against — "a few dozen" candidates, per the motivating case
 * above. Below this, the pool is the size the floor already accounts for, so
 * the rate stays flat at the floor: no reason to explore MORE aggressively
 * just because the pool is, say, 10 instead of 40 — small pools were never
 * the problem. Only past this reference point does dilution become real
 * enough to counteract.
 */
const UNDER_EXPLORED_REFERENCE_COUNT = 40;

/**
 * Effective exploration rate for a call with `underExploredCount`
 * under-explored candidates in its ranked list. Flat at the floor up to
 * `UNDER_EXPLORED_REFERENCE_COUNT`, then grows with the SQUARE ROOT of how
 * far past that reference the pool is — sublinear on purpose, so a huge
 * registry-wide pool (hundreds of models) pulls the rate up toward the
 * ceiling without a linear scale-up blowing past it almost immediately (a
 * linear "rate per candidate" term would need to be so small to respect the
 * ceiling at 300+ candidates that it would barely move at the 40-100
 * candidate range where the dilution first starts to bite). Clamped to
 * [EXPLORATION_RATE_FLOOR, EXPLORATION_RATE_CEILING] so neither bound is
 * ever crossed regardless of how the pool size moves.
 *
 * // example: 10 under-explored candidates  -> 5%    (below reference, floor)
 * // example: 40 under-explored candidates  -> 5%    (at reference, floor)
 * // example: 160 under-explored candidates -> ~10%  (4x reference -> sqrt(4)=2x floor)
 * // example: 360 under-explored candidates -> 15%   (9x reference -> sqrt(9)=3x floor, hits the ceiling)
 */
export function explorationRateFor(underExploredCount: number): number {
  if (underExploredCount <= UNDER_EXPLORED_REFERENCE_COUNT) return EXPLORATION_RATE_FLOOR;
  const scaled = EXPLORATION_RATE_FLOOR * Math.sqrt(underExploredCount / UNDER_EXPLORED_REFERENCE_COUNT);
  return Math.min(EXPLORATION_RATE_CEILING, scaled);
}

/**
 * A candidate this platform has real uncertainty about — no observed
 * dispatch track record AND no trusted sustain-rate sample (see
 * MIN_SUSTAIN_SAMPLES_TRUSTED). Both, not either: a candidate proven on one
 * axis but new on the other has SOME real evidence already and is not a
 * blank slate the way a candidate with neither is.
 */
function isUnderExplored(candidate: AiRouterCandidate): boolean {
  const noTrackRecord =
    candidate.trackRecordSuccessRate === undefined || candidate.trackRecordSuccessRate === null;
  const noSustainData =
    candidate.sustainSampleSize === undefined ||
    candidate.sustainSampleSize === null ||
    candidate.sustainSampleSize < MIN_SUSTAIN_SAMPLES_TRUSTED;
  return noTrackRecord && noSustainData;
}

/**
 * Given an already best-first ranked list, occasionally substitute the top
 * pick with the best-ranked UNDER-EXPLORED candidate instead of the actual
 * top pick — real exploration, not noise: among candidates this platform
 * has genuine uncertainty about, still take the one the REST of scoring
 * (cost, latency, access tier) likes best, so "let's learn about this one"
 * is never also "let's pick something obviously worse for no reason".
 *
 * Applies to any AUTO-FAMILY mode — 'auto', 'auto-budget', and
 * 'auto-frontier' alike. 'budget' and 'frontier' (the literal, blunt modes)
 * are an explicit user intent — cheapest, full stop; strongest, full stop —
 * and overriding either with an exploratory pick would violate the thing the
 * caller actually asked for: a repeatable, deterministic answer with zero
 * randomness involved. Every auto-family mode, by contrast, already means
 * "blend intelligence, cost, access, and latency into one judgment call",
 * just tilted toward a different point on the cost↔capability dial (see
 * AUTO_COMPOSITE_WEIGHTS) — exploration is a natural extension of that
 * judgment for all three, not a departure from it, so none of them are
 * exempted the way the literal modes are.
 *
 * Returns the ORIGINAL list, untouched, when: mode isn't an auto-family
 * mode, the roll misses, there is no under-explored candidate at all, or the
 * best under-explored candidate already IS the top pick (nothing to substitute).
 * When it does substitute, everyone else keeps their real relative order —
 * this is a promotion, not a re-sort, so a fallback chain behind the
 * exploratory pick is still the genuine ranking, not a shuffled one.
 *
 * `random` is injectable (default Math.random) so a caller can test this
 * deterministically instead of actually being nondeterministic in a test run.
 */
export function applyExploration<T extends AiRouterCandidate>(
  ranked: readonly T[],
  mode: AiRoutingStrategy,
  random: () => number = Math.random,
): { candidates: readonly T[]; explored: boolean } {
  if (!isAutoFamily(mode) || ranked.length <= 1) return { candidates: ranked, explored: false };
  const underExplored = ranked.filter((c) => isUnderExplored(c));
  if (underExplored.length === 0) return { candidates: ranked, explored: false };
  // Rate scales with THIS call's own under-explored pool, not the registry's
  // theoretical maximum — a request whose candidates happen to already be
  // well-sampled shouldn't get a scaled-up rate just because the platform
  // integrates many providers elsewhere. See explorationRateFor's doc for
  // the floor/ceiling reasoning.
  const rate = explorationRateFor(underExplored.length);
  if (random() >= rate) return { candidates: ranked, explored: false };
  const pick = underExplored[0];
  if (pick === ranked[0]) return { candidates: ranked, explored: false };
  const reordered = [pick, ...ranked.filter((c) => c !== pick)];
  return { candidates: reordered, explored: true };
}
