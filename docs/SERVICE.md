# `clikcode service` — the accounts service

A hidden command that serves ClikCode's own multi-account machinery over HTTP,
for a platform that runs its **own** agents on subscriptions ClikCode signs in
to (ClikDeploy's `clikcode-accounts` container). It runs headless: no TTY, no
display, no browser. Every vendor sign-in is the vendor's own login, run by the
same code `clikcode accounts login` runs, and shown to the caller as a link, a
code, or a question to answer. Every turn is ClikCode's own turn
(`runSessionTurn`), pinned to the one account the caller chose.

Code: `src/commands/service.ts` (command), `src/service/*` (routes, login state
machine, turn stream, backend).

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLIKCODE_SERVICE_TOKEN` | — (required) | Bearer token every route but `/health` checks. At least 16 characters. The service refuses to start without one. |
| `CLIKCODE_SERVICE_PORT` | `4050` | Port to listen on. |
| `CLIKCODE_SERVICE_HOST` | `127.0.0.1` | Address to bind. Set `0.0.0.0` in a container. |
| `CLIKCODE_HOME` | `~/.clikcode` | ClikCode's home: the account registry, every account's profile (`profiles/<harness>/<accountId>/`, the vendor's credential files), the lifecycle log (`logs/`), and vendor CLIs ClikCode installs itself (`tools/npm`). **Put it on a volume.** |
| `HOME` | — | Must be writable. Vendor installers that are scripts (not npm) install under it (`~/.local/bin`), and ClikCode's settings file lives under `$XDG_CONFIG_HOME` / `~/.config/clikcode`. Put it on the same volume. |

The service deletes `DISPLAY`, `WAYLAND_DISPLAY` and
`CLIKDEPLOY_REMOTE_TERMINAL` from its own environment at start, so every vendor
picks its device or pasted-code sign-in (never a localhost browser callback).

Tokens, pasted codes, keys and credential contents are never logged or
returned: the request log is `METHOD path status ms` only, an answer typed into
a sign-in is handed to the vendor and scrubbed from any error the vendor prints,
and a 500 never carries an error's own text.

## API (version header `x-clikcode-service: 1`)

All JSON. Header `authorization: Bearer <token>` on every route but `/health`.
Errors: `{ "error": { "code", "message" } }` with a 4xx/5xx status.

- `GET /health` → `{ ok: true, version, commit }` (no auth).
- `GET /v1/providers` → `{ providers: [{ provider, harness, name, loginKinds, installed }] }` —
  every harness ClikCode can sign in to headlessly and run turns on. `loginKinds` ⊆
  `device` (a code approved anywhere), `url-code` (a link, maybe with a code pasted back),
  `api-key` (a key pasted instead). `installed`: its CLI is on PATH now (it is installed on
  demand at the first sign-in otherwise).
- `GET /v1/accounts` → `{ accounts: [Account] }`
  `Account = { id, provider, harness, label, status, detail?, checkedAt?, models?, usage?: { window?, remainingPct?, resetsAt? } }`,
  `status` ∈ `connected | needs-login | expired | revoked | limited | unknown`. `id` is
  ClikCode's account id (its profile directory name) and lasts as long as the account.
  `revoked`: the vendor refuses the account until it is verified (eligibility). `limited`:
  out of usage, `usage.resetsAt` when known. (`expired` is not produced today: an expired
  credential reads as `needs-login`.)
- `GET /v1/accounts/:id` → `Account` (added).
- `POST /v1/accounts/:id/check` → re-runs `accounts status` (credential on disk, the vendor's
  own status command, usage asked now) → `Account`.
- `DELETE /v1/accounts/:id` → the vendor's logout in the account's profile, then the account
  and its profile removed → `{ ok: true, removed: id }`.
- `POST /v1/logins` `{ provider, label?, accountId? }` → `201 { loginId }`. `provider` is a
  provider id (`anthropic`) or a harness command (`claude`). `accountId`: Reconnect that
  account — the same sign-in, named for it; the vendor's identity decides, so the same person
  lands back on the same `id` (a different person becomes a new account).
- `GET /v1/logins/:loginId` →
  `{ loginId, provider, state, verificationUrl?, userCode?, prompt?, choices?, secret?, acceptsInput?, accountId?, error? }`
  - `starting` → `installing` (the vendor CLI is being installed) → …
  - `awaiting-user`: open `verificationUrl`, enter `userCode` if given, approve. With
    `acceptsInput: true` a key may be pasted instead (POST input) — `prompt` says so.
  - `awaiting-input`: the vendor wants something typed back (Claude's authorization code,
    a key, a menu choice). `choices` (added) is a menu: answer with its number (from 1) or its
    text. `secret` (added): the answer is a key.
  - `connected` (with `accountId`), `failed` (with `error`; `cancelled` after DELETE), `timeout`
    (15 minutes without finishing).
  A finished login is kept for an hour.
- `POST /v1/logins/:loginId/input` `{ value }` → same shape as GET. `409 not-awaiting-input`
  when the vendor is not waiting on anything; `400 invalid-choice` for a menu answer that is not
  one of its choices. The value is never logged.
- `DELETE /v1/logins/:loginId` → cancels (the vendor's login is stopped) → same shape as GET.
- `POST /v1/turns` `{ accountId, model?, system?, messages: [{ role, content }], mcp?: { url, headers }, maxTurns?, timeoutMs? }`
  → `application/x-ndjson`, one event per line:
  - `{ type: 'text', text, replace? }` — appended text; `replace: true` (added) means the answer so
    far is replaced by `text`.
  - `{ type: 'tool', name, status: 'started' | 'done' | 'error' }`
  - `{ type: 'usage', inputTokens, outputTokens, costUsd?, cacheReadTokens?, cacheWriteTokens? }` (tokens as the vendor counts them)
  - `{ type: 'done', stopReason }` (`completed | max-tokens | max-turns | refusal | stopped | failed`)
  - `{ type: 'error', reason, message, retryAfterSec? }`, `reason` ∈
    `needs-login | revoked | limited | not-entitled | model-unavailable | timeout | crashed`
    (ClikCode's own refusal classification, `turn/failover.ts`). `retryAfterSec` with `limited`
    when the vendor or the usage reading says when the account is back.

  A body that is not a turn is `400` and an unknown account `404` before the stream starts.
  The turn runs on that account only: a refusal ends it with its reason, it never moves to
  another account. The account's state is updated as ClikCode updates it in a chat (a refusal
  marks it limited, an auth failure marks it `needs-login`), so `GET /v1/accounts` reflects it.
  `messages` before the last are sent as the conversation, `system` as instructions, in one
  request; the conversation is not kept afterwards. `mcp` is the turn's only MCP server (named
  `platform`, HTTP transport, `headers` sent with every request); without it the turn has none.
  `timeoutMs` defaults to 10 minutes, at most 60. `maxTurns` is accepted but not enforced:
  the vendors share no per-run step limit (bound a run with `timeoutMs`). The turn runs in Bypass (Auto where the vendor
  refuses Bypass, e.g. Claude Code as root) in an empty temporary folder. Closing the connection
  stops the turn.

## Running it in a container

- **Node** 22.12 or newer (`node:22-bookworm-slim` or `node:24-bookworm-slim`).
- **System packages**: `ca-certificates`, `git`, `curl`, `bash`, and `script(1)` (Debian's
  `bsdutils`, already in the base image) — vendor sign-ins run down a pty through `script`.
- **Build** (builder stage, from the repo at the wanted commit):

  ```sh
  corepack enable
  pnpm install --frozen-lockfile
  pnpm build              # node scripts/build.mjs -> dist/
  npm pack                # clikcode-<version>.tgz (prepack builds dist again)
  ```

  Runtime stage: `npm install -g ./clikcode-*.tgz` (pulls its four runtime dependencies), then
  the command is `clikcode service`.
- **Vendor CLIs**: ClikCode installs a vendor's CLI itself the first time it is needed (a
  sign-in shows `installing`): `npm install --global`, falling back to
  `$CLIKCODE_HOME/tools/npm` when the global prefix is not writable — which it is not for an
  unprivileged user, so on-demand installs land on the volume and survive recreates. Vendors
  with a script installer install under `$HOME`. To skip the wait, install the ones you use at
  build time (as root, before switching user):

  ```sh
  npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp \
    @openai/codex @github/copilot @google/gemini-cli @xai-official/grok
  ```

  ClikCode refreshes `claude-agent-acp` itself from time to time; with a read-only global prefix
  the newer copy goes to `$CLIKCODE_HOME/tools/npm`, which is searched too.
- **User and volume**: run as an unprivileged uid with one volume for its home, e.g.

  ```yaml
  environment:
    CLIKCODE_SERVICE_TOKEN: ${CLIKCODE_SERVICE_TOKEN}
    CLIKCODE_SERVICE_HOST: 0.0.0.0
    HOME: /data
    CLIKCODE_HOME: /data/.clikcode
    NODE_ENV: production
  volumes: [clikcode-accounts:/data]
  command: ["clikcode", "service"]
  healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4050/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"] }
  ```

  The service needs outbound internet (vendor APIs, npm) and whatever `mcp.url` points at.
  `cap_drop: ALL` and `no-new-privileges` are fine.
