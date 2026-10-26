# Harness capability status

Checked against the ClikCode catalog on 2026-10-23. The Model source, Effort, Permissions, Free-plan and Account usage columns were last reviewed on 2026-10-10 (rows changed that day: Codex, Amp, Droid, Qwen Code, Cline, Hermes, Command Code, Deep Agents Code, Devin; the Codex model source corrected 2026-10-20). The Steering, Resume, Plan mode and Sub-agents columns were added on 2026-10-23 from the catalog's own flags (`packages/clikrouter/src/ai-local-harness.ts`: `acp.steering`, `acp.sharedSessions`, `acp.planModeId`, `planMode`, `turn`/`session` resume fields, `subagents`, `capabilities`); they say what the code is wired to do, not that it was run live. Steering carries its VERIFIED or CLAIMED status from `docs/STEERING.md`; every other cell in them is not run live by this table. The catalog has 29 harnesses (counted from `AI_LOCAL_HARNESSES` on 2026-10-23): 22 run over ACP, Codex over its own app-server, and six as one-shot CLIs (Aider, Amp, Antigravity, Pi, OpenClaw, Continue). A listed control is a ClikCode integration, not proof that every vendor account or model accepts it. `ACP` model discovery means ClikCode asks the agent's session for models when it offers them; an empty or refused response cannot become a complete list. Server-sourced model lists refresh after five minutes, with the last list shown while a picker refreshes.

| Harness | Model source | Effort | Permissions | Free-plan models | Account usage | Steering | Resume | Plan mode | Sub-agents |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | Installed vendor model table | Yes | Ask, bypass, auto | - | Direct probe, and its turn stream | ACP `_session/steering` (VERIFIED) | CLI resume id; ACP session, shared store with the CLI | ACP mode `plan`; plan card | reads transcript, steers relay, child activity, background agents |
| Grok Build | Vendor CLI | Yes (minimal to max) | Ask, bypass, auto | Plan's own list | Direct probe (ACP extension call) | None (queues) | CLI resume id; ACP session, shared store with the CLI | - | - |
| Gemini CLI | ACP when available | No declared control | Ask, bypass, auto | - | No direct quota probe | None (queues) | CLI resume id; ACP session | - | - |
| Codex | The running app-server's `model/list`, for this account (`models_cache.json` when no server is live) | Yes, per model | Ask, bypass, auto | Plan's own list | Direct probe | app-server `turn/steer` (CLAIMED) | CLI resume id | plan card | reads thread, child activity |
| OpenCode | Vendor CLI | Yes | Ask (`OPENCODE_PERMISSION` edit/bash = ask), bypass; plan mode | Zero-price models in its list | No direct quota probe | None (queues) | CLI resume id; ACP session, shared store with the CLI | ACP mode `plan` | - |
| Copilot | Its own server, for this account (`models.list`); public models.dev catalog only when that fails | Yes, over ACP (levels from `copilot --help`) | Ask, bypass | Plan's own list | Direct probe (`account.getQuota`) | None (queues) | CLI resume id; ACP session, shared store with the CLI | option `plan` | - |
| Aider | Configured providers and their caches | No declared control | Bypass only (`--yes-always`); no ask (see below) | `:free` models | No direct quota probe | None found (queues) | CLI resume id; history file | - | - |
| Goose | Configured providers and ACP | Yes, over ACP (levels from its `thinking_effort` option) | Ask, bypass, auto | `:free` models | No direct quota probe | None (queues) | CLI resume id; ACP session, shared store with the CLI | - | - |
| Amp | No model selector; `--mode low/medium/high/ultra` is an option row (model tier) | No declared control | None: Inert (see below) | - | Credit balance (`amp usage`) | stream-json `steer` line (VERIFIED 2026-10-25) | CLI resume id | plan card | reads frames, child activity |
| Antigravity | Vendor CLI | No declared control | Ask, bypass | Plan's own list | Direct probe (quota pools) | None found (queues) | CLI resume id | option `mode` | - |
| Pi | Vendor CLI | Yes | No declared modes | `:free` models | No direct quota probe | RPC `steer` (VERIFIED against pi 0.87.0) | CLI resume id | - | - |
| Droid | ACP when available | Yes, from its session's `reasoning_effort` option (per model); static list is the union | Ask, bypass, auto, over ACP modes; plan mode (`spec`) | - | No direct quota probe | None (queues) | CLI resume id; ACP session | ACP mode `spec`; option `spec-mode` | - |
| Kiro | ACP when available | Yes | Ask, bypass | Plan's own list | Direct probe (its `/usage` over ACP) | Unknown (needs a sign-in to probe); queues | CLI resume id; ACP session | - | - |
| Qwen Code | ACP when available | Yes, from its session's `reasoning_effort` option (per model) | Ask, bypass, auto, over ACP; plan mode | - | No direct quota probe | None (queues) | CLI resume id; ACP session | ACP mode `plan`; plan card | reads frames, child activity |
| Cline | ACP when available | Yes (`--thinking`; its ACP session has no effort option) | Ask, bypass (its ACP modes are plan and act); plan mode | `:free` models | Credit balance, advisory (`:free` models still run when it is spent) | None (queues) | CLI resume id; ACP session | ACP mode `plan`; option `plan` | - |
| Kilo | Vendor CLI | Yes | Ask (`KILO_PERMISSION` edit/bash = ask), auto; plan mode | `:free` models, and the ones its list marks free | Credit balance (`kilo profile`) | None (queues) | CLI resume id; ACP session, shared store with the CLI | ACP mode `plan` | - |
| Cursor Agent | ACP when available | No declared control | Ask, bypass, auto | Auto (the models it does not count as named) | Direct probe | None (queues) | CLI resume id; ACP session | ACP mode `plan`; option `mode`; plan card | reads frames, child activity |
| Hermes | Provider inventory and cache; chosen over ACP | Yes, but only on a one-shot CLI turn: `hermes acp` has no effort control | Ask, bypass (`--yolo`) | `:free` models | Direct probe (Nous Portal credits) | None (queues) | CLI resume id; ACP session | - | - |
| OpenClaw | Vendor configuration and provider inventory | Yes | No declared modes | - | No direct quota probe | None found (queues) | CLI resume id | - | - |
| Command Code | Vendor CLI list (ACP lists the same 84) | Yes, per model over ACP | Ask, bypass, auto over ACP modes; plan mode | - | Direct probe | None (queues) | CLI resume id; ACP session | ACP mode `plan`; option `plan` | - |
| Kimi CLI | ACP when available | No declared control | Ask, bypass, auto | - | Direct probe | None (queues) | ACP session | ACP mode `plan`; option `plan`; plan card | - |
| Auggie | Vendor CLI | Yes (not sent for haiku4.5, which answers HTTP 400) | No declared modes | - | Credit balance (`auggie account status`) | None (queues) | CLI resume id; ACP session | option `ask`; plan card | - |
| Mistral Vibe | ACP when available | No declared control | Ask, bypass, auto | - | Direct probe (a key whose plan allows no requests reads spent) | None (queues) | ACP session | - | - |
| OpenHands | ACP when available | No declared control | Bypass, auto | - | No direct quota probe | None (queues) | ACP session | - | - |
| Continue | Saved account models (no `--model`: `cn --model` adds a hub model) | No declared control | Ask, bypass | - | No direct quota probe | None found (queues) | None: the transcript is carried | option `readonly` | - |
| Deep Agents Code | ACP when available | No declared control | Ask, auto (`-y`) | - | No direct quota probe | Unknown (needs a sign-in to probe); queues | ACP session | - | - |
| Devin CLI | ACP when available | No declared control | Ask, auto (Smart), bypass over ACP modes; plan mode | Plan's own list | Direct probe (daily and weekly) | None (queues) | ACP session | ACP mode `plan` | - |
| Junie CLI | ACP when available | Yes | No declared modes | - | No direct quota probe | None usable: advertised, not answered (`acp.steering: false`; VERIFIED on 26.9.22) | ACP session | ACP mode `plan` | - |
| MiniMax Code | ACP when available | No declared control | No declared modes | - | No direct quota probe | ACP `mcode/session/steer` (CLAIMED) | ACP session | - | - |

`Plan's own list` means the vendor lists only what the account's plan runs, so on a plan the vendor itself calls free every listed model is a free one; the plan comes from the account's usage reading. `:free` is OpenRouter's free-model suffix, which those harnesses route through. A credit balance is shown as a label, not a window: it never marks an account spent by itself.

## Modes and ACP sessions, read from the installed vendors on 2026-10-10

`(live)` means a signed-in `session/new` run under `scripts/vendor-sandbox.mjs`; `(source)` means read from the installed package.

- Command Code 1.74.3 now runs over `cmdc acp` (live and source): modes `default`, `auto-accept`, `plan`, `dont-ask`, `bypass`; config options `model` (84 ids, the same as `--list-models`) and `effort` (values depend on the model). Asks for permission over `session/request_permission`. ClikCode maps ask/auto/bypass to `default`/`auto-accept`/`bypass`. The `--print` turn remains for what ACP cannot take. Not verified: that an ACP session id and `--resume` name one store, so `sharedSessions` is not claimed and a chat stays on the transport that started it.
- Qwen Code 0.25.0 (live and source): config option `mode` = `plan`, `default`, `auto-edit`, `auto`, `yolo` (`--approval-mode`); `reasoning_effort` (this account's model offered only `none`/`default`). Declared: ask=`default`, auto=`auto`, bypass=`yolo`, plan=`plan`. `auto-edit` has no ClikCode equivalent.
- Cline 3.0.70 (live): `modes` are `plan` and `act`, plus a boolean `auto_approve` option; no effort option. Its modes are not permission levels, so ask and bypass both map to `act` (which also leaves plan); bypass is `--auto-approve true` at launch. Plan mode is `plan`.
- Droid 0.223.0 (live and its `--help`): `exec --output-format acp` validates and ignores `-m`, `--auto` and `-r`; the session is set over the protocol. Modes `normal`, `spec`, `auto-low`, `auto-medium`, `auto-high` map to ask, plan, auto, and (`auto-high`) bypass; `reasoning_effort` options depend on the selected model. `auto-medium` is unmapped.
- Hermes 0.20.5 (source): `hermes acp` accepts none of `--model`, `--provider`, `--reasoning`; the model is set with `session/set_model`. It builds the agent with no reasoning config, so an ACP turn cannot honour effort: a non-default effort moves a new chat to `hermes chat --quiet --reasoning`, and an existing ACP chat runs that turn at the vendor default with a notice. `--yolo` is the one flag that works. Its modes (`default`, `accept-edits`, `dont-ask`) are edit-approval policies, not mapped.
- Codex 0.155.1 (generated protocol schema): `turn/start` takes `approvalPolicy`, `sandboxPolicy`, `approvalsReviewer`, `effort`, `model`, `summary` per turn; `thread/compact/start`, `model/list` and `thread/list` exist. The catalog declares them (`nativeOperations`) and `src/harness/transport/codex-native-methods.ts` holds the helpers; the transport sends the permission mode with every `turn/start` (a change restarts nothing), `/compact` calls `compactThread` on the live app-server and waits for `thread/compacted` (summary path when no server is live), and the model list comes from `model/list` of the running server with `models_cache.json` as the fallback. Not run live. `thread/list` does not replace the on-disk thread scan (it needs a running server per profile).
- Antigravity: `--mode accept-edits|plan` shares one flag with its Plan mode row, so accept-edits is not mapped to Auto; effort is in the model id (`agy` rejects `--effort`).

### Ask, checked live on 2026-10-10

- OpenCode 1.18.32 and Kilo 7.7.6 write files and run shell without asking when nothing is configured (`hello.txt` was created). Their own `permission` config is the control, carried by the environment: `OPENCODE_PERMISSION` / `KILO_PERMISSION` = `{"edit":"ask","bash":"ask"}`. With it the same prompt stopped at "permission requested: edit ...; auto-rejecting" under `run`; over ACP the request is a `session/request_permission` ClikCode answers. Declared as `permissionEnv.ask`.
- Aider 0.86.2 has no ask. It applies edits to files in the chat without a question, and its only confirmations (create a file, run a command) read stdin, which on EOF answers the default `y` (`io.py` `confirm_ask`). `--yes-always` is the one flag, so only Bypass is offered and `--permissions ask` is refused.
- Amp offers none (above): its `permissions` live in a settings file, so ClikCode declares no modes and refuses `--permissions ask`.
- Command Code `dont-ask` has no ClikCode equivalent (ClikCode's modes are ask, auto, bypass) and is left unmapped.

### Inert: the vendor offers no per-run control ClikCode can use

Ask and Bypass do nothing for these, and ClikCode does not offer the control: Amp (`--mode` is a model tier; `amp.dangerouslyAllowAll` is a settings-file key reachable only with `--settings-file`), Pi (its `--mode` is output format; it has no approval prompts), OpenClaw (approvals are a gateway policy, `openclaw approvals`), Auggie (`--ask` is read-only retrieval; `--permission` is per-tool rules), Junie (`--plan` and `--brave` are interactive-only), MiniMax Code (no mode flag). Unverified because sign-in or a build blocked a live session: Auggie, Junie and MiniMax Code ACP `modes`.

### Left

- Claude ACP `additionalDirectories` is sent with `session/new|load|resume` for `/add-dir` (agents that advertise `sessionCapabilities.additionalDirectories`; others refuse the turn naming it). Not run live. `fork`, `list`, `delete` and `providers` are still unused.
- Droid and Command Code efforts are asked of the agent per model (`session/set_config_option` model, then the effort option) on a temporary discovery session; `--help` is the fallback. Command Code's open ACP session also reports its model list (`liveModelList`), so no agent is started for it. Not run live.

Effort levels come from the vendor wherever it states them: Codex's model cache per model, a harness's `--help` for its effort flag, or Goose's ACP session. The catalog's list is the fallback for harnesses that publish none.

`No direct quota probe` means no numeric account balance or reset is inferred.
Vendor refusals still drive account failover. Turn tokens and costs are separate
and appear only when the vendor supplies them.

ClikCode keeps model and usage data keyed to the selected account or its isolated vendor profile. The model picker and account picker now refresh server lists and share current usage readings between ClikCode processes. This does not create multiple simultaneous vendor logins where a vendor refuses them.

For live ACP turn and resume evidence, see [ACP_OAUTH_VERIFICATION.md](ACP_OAUTH_VERIFICATION.md). Eight of the eighteen OAuth-capable ACP harnesses passed with available accounts. Ten remain blocked by sign-in, quota, subscription, or account eligibility. A handshake alone is not counted as a completed integration check.

## Turn usage over ACP, checked live on 2026-09-30

Each was a real signed-in two-turn session in `scripts/vendor-sandbox.mjs`, comparing every usage-bearing frame the agent sent with what ClikCode recorded.

| Harness | What the agent sends | ClikCode records |
| --- | --- | --- |
| Claude Code | Prompt `usage`, `usage_update` cost and context | Tokens, cache, cost, context |
| Grok Build | Per-turn `_meta.usage` with `costUsdTicks`; `_meta.totalTokens`; model `totalContextTokens` | Tokens, reasoning, cost, context |
| OpenCode | Prompt `usage`, `usage_update` | Tokens, cache, cost, context |
| Goose | Prompt `usage`, session-total `usage_update` cost | Tokens, each turn's share of cost, context |
| Cline | Nothing over ACP; its session file | Tokens, cache, cost (from the file) |
| Kiro | `_kiro.dev/metadata`: context percentage, credits per turn | Context %, credits |
| Cursor Agent | Only `stopReason` | Nothing: Cursor's ACP sends no usage, and its session store keeps none |

Hermes was not re-checked: its model provider returned HTTP 429. The other ACP harnesses could not run a turn (see the verification table).

## Global MCP servers: which harness gets them, 2026-10-20

The servers recorded for ClikCode (`<state dir>/mcp.json`, `clikcode mcp add`), and ClikCode's built-in `clikcode` server while computer use is on, are handed to a harness per run; nothing is written into a vendor's own config (`src/harness/transport/acp-mcp-servers.ts`). A server already named in the harness's own config (the catalog's `managers.mcp.serverFiles`, read from the account's profile when it has one) is left out, so it never runs twice. A remote server ClikCode holds an OAuth sign-in for goes with `Authorization: Bearer <token>`, read and refreshed by `src/agent/mcp/oauth.ts` when the session or process is opened; one recorded as needing a sign-in is left out (a vendor handed it would start a browser sign-in of its own).

| Harness | How the servers reach it | What it takes |
| --- | --- | --- |
| The 22 ACP harnesses | `mcpServers` of `session/new`, `session/load`, `session/resume` | Local (stdio) servers always; HTTP and SSE only when the agent's `initialize` advertises `mcpCapabilities.http` / `.sse`. Headers, a stored bearer included, travel in the request, not on a command line. |
| Codex | `-c mcp_servers.<name>.*` overrides on the `app-server --stdio` launch | Local servers (`command`, `args`, `env`) and streamable HTTP (`url`, `env_http_headers`). Header values go in the app-server's environment (`CLIKCODE_MCP_SECRET_<n>`), never on its command line. No SSE (Codex has none), and only names of letters, digits, `_` and `-`. A local server's `env` is on the command line, as for the built-in server. Read when the app-server starts: a change applies to the next one. |
| Amp | `--mcp-config <file>` (catalog `turn.mcpConfigArgv`), merged by Amp over its own settings | Local and HTTP servers, in a 0600 file in its own temporary directory, removed after the run. Servers that need ClikCode's stored sign-in are left out: their tokens are not written anywhere new. |
| Aider | None | Aider has no MCP client. |
| Pi | None | Pi has no MCP client; it is extended with its own extensions (`-e`). |
| Antigravity | None per run | Its MCP servers are its own configuration (`agy mcp`); no per-run flag or environment variable is known. |
| OpenClaw | None per run | Its MCP servers are its own configuration (`openclaw mcp`); no per-run flag is known. |
| Continue | None per run | `cn --mcp` takes Continue Hub slugs (`owner/package`, an option row), not a local server definition. |

MCP name deduplication reads the confirmed user and project config paths for Mistral Vibe, Deep Agents Code, Devin, Junie and MiniMax Code. OpenHands' effective MCP file location is not confirmed, so its own server may also be handed through ClikCode. Not verified live: Codex reading `env_http_headers` from the app-server's environment, and Amp's `--mcp-config` taking a file path (both from their published configuration, not a run). A token refreshed while a session or app-server is open is not handed to it; the next session or process gets the new one.

The one-time import into mcp.json (`src/agent/mcp/import.ts`) is kept. It is not the same job as the per-session dedupe: the dedupe stops a vendor getting a server twice, while the import gives ClikCode's own agent the servers the user configured in their vendors before `clikcode mcp add` wrote mcp.json -- without it those servers would be missing from ClikCode's agent and from the harnesses that have no config of their own.

## Implementation corrections, 2026-10-25

- History and unsent chats use the same full slash-command registry and dispatcher
  as the composer. Setup targets a fresh draft; closing it discards that draft.
- Metadata-only ACP queries have a bounded lifetime. Temporary sessions are deleted
  through an advertised protocol method or an observed store cleanup. A vendor
  without either is not given a background session; its live session/cached model
  list remains usable. There is no persistent discovery-session cache.
- Native transcript readers retain the full available record. An authoritative
  source containing the entire local cache can restore its missing older prefix.
  Known native startup envelopes are removed without dropping HTML/XML prompts.
- ACP session replay covers agents advertising `loadSession`, including custom
  ACP harnesses. Store/export readers handle Claude, Codex, OpenCode, Amp, Pi,
  Aider, Antigravity and OpenClaw. Unsupported store versions/encodings remain
  a failed optional import, never an invented transcript. Continue is stateless
  and receives ClikCode's canonical history on every invocation.
- ACP model, effort and mode changes use the agent's native controls while a turn
  runs. Rejections defer the selection without cancelling tools. Codex and other
  turn-scoped controls take effect at their supported vendor boundary. An account
  or provider switch cannot replace a credential inside an opaque vendor request.
- Failover standbys initialize only: no speculative thread copy or empty thread.
  The actual failover carries the flushed thread before resuming it.
- Silence does not mark a conversation stalled in either client, and animation
  minimums no longer delay completed operations.
- Cursor native history import passed a real model codeword recall on
  `2026.09.26-dd393fe` and is enabled for that exact build. Across accounts it
  rebuilds the thread through the proven native writer; no unverified encrypted
  store-copy branch remains.
- Amp native steering passed a live tool-and-steer run. The tool finished,
  Amp echoed the message, and the same run answered the steered instruction.
  Async Task rows now wait for `subagent_finished`, including resumed tasks.
  Multiple completed agents retain separate pending follow-ups; a child's
  terminal result cannot close the parent. Failed input writes return the
  unacknowledged message to the durable queue.
- Turning ACP plan mode off applies even when the stored off value is absent.
  Metadata probes use native deletion without first importing the local store
  registry; local cleanup loads only when needed.
