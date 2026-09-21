# @clikcode/router

Provider-agnostic AI request normalization and router-selection logic: one
dialect layer across 68 providers (registry, request building, response
extraction) plus the candidate-ranking algorithm.

## Scope — what lives here vs. what doesn't

This package has **zero storage, zero credentials, zero platform-specific
business logic**. Everything here is a pure function or pure data: given a
provider id and model id, build the right HTTP request for that provider's
dialect; given a raw response, extract text/tool-calls/usage/cost; given a
list of candidates with their live signals (latency, cost, success rate —
plain numbers, not database rows), rank them.

What deliberately does **not** live here, and stays in the calling
application instead:

- Reading/writing Redis or a database (live latency EWMAs, cost EWMAs,
  cooldowns, durable success/failure counters, credential resolution,
  billing attribution)
- Anything that knows what "ClikDeploy" is

See `@clikdeploy/platform-domains`'s `domains/connectors/` for this
platform's own wiring: it calls into this package's pure functions and
supplies the live signals from its own Redis/Postgres-backed stores.

## Contents

- `ai-provider-registry/` — the provider catalog (pure data): every known
  provider's id, base URL, auth shape, modality, context window, pricing
  metadata.
- `ai-provider-http.ts` — dialect normalization: build a chat request for
  any provider's wire format, extract text/tool-calls/stop-reason/cost from
  its response.
- `ai-provider-models.ts` — the AI SDK dispatch layer (`streamAiChatTurn`):
  resolves a provider+model pair to a real `LanguageModel` and streams a
  turn, uniformly across every first-party SDK package and the
  OpenAI-compatible fallback.
- `ai-router-selection.ts` — the candidate-ranking algorithm: given a list
  of eligible candidates and their live signals, produce a ranked
  selection with a human-readable reason. Six strategies: `auto` /
  `auto-budget` / `auto-frontier` (blend + explore), `budget` / `frontier`
  (lexicographic), `explicit` (pin). `ACCESS_RANK` prefers connected
  `subscription` / `subscription-harness` (0) over `free-tier` (1). The
  metered gate lives in `buildEligibleRouterCandidates` in platform-domains,
  not a deleted `filterAiRouteCandidatesByBilling`. Shipped agent-runtime
  task rows default `strategy: "auto"`, `allowMetered: false`,
  `allowOauth: true`.

## Renaming

If this package's identity changes (a different name, eventually
publishing it standalone), the only places that need to change are:
1. `name` in `package.json`
2. The `packages/clikrouter` directory name
3. Every tsconfig.json's `@clikcode/router` / `@clikcode/router/*`
   path-alias entries (grep the repo for `clikrouter` to find them all)

Nothing inside `src/` hardcodes the package name — imports within this
package are all relative (`./ai-provider-registry`, etc).
