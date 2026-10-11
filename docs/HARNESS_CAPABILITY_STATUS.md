# Harness capability status

Checked against the ClikCode catalog on 2026-10-10 (rows changed that day: Codex, Amp, Droid, Qwen Code, Cline, Hermes, Command Code, Deep Agents Code, Devin). A listed control is a ClikCode integration, not proof that every vendor account or model accepts it. `ACP` model discovery means ClikCode asks the agent's session for models when it offers them; an empty or refused response cannot become a complete list. Server-sourced model lists refresh after five minutes, with the last list shown while a picker refreshes.

| Harness | Model source | Effort | Permissions | Free-plan models | Account usage |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Installed vendor model table | Yes | Ask, bypass, auto | - | Direct probe, and its turn stream |
| Grok Build | Vendor CLI | Yes (minimal to max) | Ask, bypass, auto | Plan's own list | Direct probe (ACP extension call) |
| Gemini CLI | ACP when available | No declared control | Ask, bypass, auto | - | Learned after refusals |
| Codex | Vendor model cache (the server's `model/list` is declared, not yet read) | Yes, per model | Ask, bypass, auto | Plan's own list | Direct probe |
| OpenCode | Vendor CLI | Yes | Ask, bypass; plan mode | Zero-price models in its list | Learned after refusals |
| Copilot | Its own server, for this account (`models.list`); public models.dev catalog only when that fails | Yes, over ACP (levels from `copilot --help`) | Ask, bypass | Plan's own list | Direct probe (`account.getQuota`) |
| Aider | Configured providers and their caches | No declared control | Ask, bypass | `:free` models | Learned after refusals |
| Goose | Configured providers and ACP | Yes, over ACP (levels from its `thinking_effort` option) | Ask, bypass, auto | `:free` models | Learned after refusals |
| Amp | No model selector; `--mode low/medium/high/ultra` is an option row (model tier) | No declared control | None: Inert (see below) | - | Credit balance (`amp usage`) |
| Antigravity | Vendor CLI | No declared control | Ask, bypass | Plan's own list | Direct probe (quota pools) |
| Pi | Vendor CLI | Yes | No declared modes | `:free` models | Learned after refusals |
| Droid | ACP when available | Yes, from its session's `reasoning_effort` option (per model); static list is the union | Ask, bypass, auto, over ACP modes; plan mode (`spec`) | - | Learned after refusals |
| Kiro | ACP when available | Yes | Ask, bypass | Plan's own list | Direct probe (its `/usage` over ACP) |
| Qwen Code | ACP when available | Yes, from its session's `reasoning_effort` option (per model) | Ask, bypass, auto, over ACP; plan mode | - | Learned after refusals |
| Cline | ACP when available | Yes (`--thinking`; its ACP session has no effort option) | Ask, bypass (its ACP modes are plan and act); plan mode | `:free` models | Credit balance, advisory (`:free` models still run when it is spent) |
| Kilo | Vendor CLI | Yes | Ask, auto; plan mode | `:free` models, and the ones its list marks free | Credit balance (`kilo profile`) |
| Cursor Agent | ACP when available | No declared control | Ask, bypass, auto | Auto (the models it does not count as named) | Direct probe |
| Hermes | Provider inventory and cache; chosen over ACP | Yes, but only on a one-shot CLI turn: `hermes acp` has no effort control | Ask, bypass (`--yolo`) | `:free` models | Direct probe (Nous Portal credits) |
| OpenClaw | Vendor configuration and provider inventory | Yes | No declared modes | - | Learned after refusals |
| Command Code | Vendor CLI list (ACP lists the same 84) | Yes, per model over ACP | Ask, bypass, auto over ACP modes; plan mode | - | Direct probe |
| Kimi CLI | ACP when available | No declared control | Ask, bypass, auto | - | Direct probe |
| Auggie | Vendor CLI | Yes | No declared modes | - | Credit balance (`auggie account status`) |
| Mistral Vibe | ACP when available | No declared control | Ask, bypass, auto | - | Direct probe (a key whose plan allows no requests reads spent) |
| OpenHands | ACP when available | No declared control | Bypass, auto | - | Learned after refusals |
| Continue | Saved account models (no `--model`: `cn --model` adds a hub model) | No declared control | Ask, bypass | - | Learned after refusals |
| Deep Agents Code | ACP when available | No declared control | Ask, auto (`-y`) | - | Learned after refusals |
| Devin CLI | ACP when available | No declared control | Ask, auto (Smart), bypass over ACP modes; plan mode | Plan's own list | Direct probe (daily and weekly) |
| Junie CLI | ACP when available | Yes | No declared modes | - | Learned after refusals |
| MiniMax Code | ACP when available | No declared control | No declared modes | - | Learned after refusals |

`Plan's own list` means the vendor lists only what the account's plan runs, so on a plan the vendor itself calls free every listed model is a free one; the plan comes from the account's usage reading. `:free` is OpenRouter's free-model suffix, which those harnesses route through. A credit balance is shown as a label, not a window: it never marks an account spent by itself.

## Modes and ACP sessions, read from the installed vendors on 2026-10-10

`(live)` means a signed-in `session/new` run under `scripts/vendor-sandbox.mjs`; `(source)` means read from the installed package.

- Command Code 1.74.3 now runs over `cmdc acp` (live and source): modes `default`, `auto-accept`, `plan`, `dont-ask`, `bypass`; config options `model` (84 ids, the same as `--list-models`) and `effort` (values depend on the model). Asks for permission over `session/request_permission`. ClikCode maps ask/auto/bypass to `default`/`auto-accept`/`bypass`. The `--print` turn remains for what ACP cannot take. Not verified: that an ACP session id and `--resume` name one store, so `sharedSessions` is not claimed and a chat stays on the transport that started it.
- Qwen Code 0.25.0 (live and source): config option `mode` = `plan`, `default`, `auto-edit`, `auto`, `yolo` (`--approval-mode`); `reasoning_effort` (this account's model offered only `none`/`default`). Declared: ask=`default`, auto=`auto`, bypass=`yolo`, plan=`plan`. `auto-edit` has no ClikCode equivalent.
- Cline 3.0.70 (live): `modes` are `plan` and `act`, plus a boolean `auto_approve` option; no effort option. Its modes are not permission levels, so ask and bypass both map to `act` (which also leaves plan); bypass is `--auto-approve true` at launch. Plan mode is `plan`.
- Droid 0.223.0 (live and its `--help`): `exec --output-format acp` validates and ignores `-m`, `--auto` and `-r`; the session is set over the protocol. Modes `normal`, `spec`, `auto-low`, `auto-medium`, `auto-high` map to ask, plan, auto, and (`auto-high`) bypass; `reasoning_effort` options depend on the selected model. `auto-medium` is unmapped.
- Hermes 0.20.5 (source): `hermes acp` accepts none of `--model`, `--provider`, `--reasoning`; the model is set with `session/set_model`. It builds the agent with no reasoning config, so an ACP turn cannot honour effort: a non-default effort moves a new chat to `hermes chat --quiet --reasoning`, and an existing ACP chat runs that turn at the vendor default with a notice. `--yolo` is the one flag that works. Its modes (`default`, `accept-edits`, `dont-ask`) are edit-approval policies, not mapped.
- Codex 0.155.1 (generated protocol schema): `turn/start` takes `approvalPolicy`, `sandboxPolicy`, `approvalsReviewer`, `effort`, `model`, `summary` per turn; `thread/compact/start`, `model/list` and `thread/list` exist. The catalog declares them (`nativeOperations`) and `src/harness/transport/codex-native-methods.ts` holds the helpers; the transport still restarts on a permission change, and `/compact` uses the native call only once the transport exposes `compactThread`.
- Antigravity: `--mode accept-edits|plan` shares one flag with its Plan mode row, so accept-edits is not mapped to Auto; effort is in the model id (`agy` rejects `--effort`).

### Inert: the vendor offers no per-run control ClikCode can use

Ask and Bypass do nothing for these, and ClikCode does not offer the control: Amp (`--mode` is a model tier; `amp.dangerouslyAllowAll` is a settings-file key reachable only with `--settings-file`), Pi (its `--mode` is output format; it has no approval prompts), OpenClaw (approvals are a gateway policy, `openclaw approvals`), Auggie (`--ask` is read-only retrieval; `--permission` is per-tool rules), Junie (`--plan` and `--brave` are interactive-only), MiniMax Code (no mode flag). Unverified because sign-in or a build blocked a live session: Auggie, Junie and MiniMax Code ACP `modes`.

### Left

- Claude ACP also advertises `additionalDirectories`, `fork`, `list`, `delete` and `providers`. `/add-dir` on Claude currently refuses the turn (its ACP command takes no CLI options) instead of sending `additionalDirectories` with `session/new|load|resume`; that needs a field on the ACP turn input.
- Droid and Command Code efforts come from the session of the default model; the picker reads the vendor's list only for harnesses without an effort flag, so the per-model list is not shown yet.

Effort levels come from the vendor wherever it states them: Codex's model cache per model, a harness's `--help` for its effort flag, or Goose's ACP session. The catalog's list is the fallback for harnesses that publish none.

`Learned after refusals` is an estimate from the selected account's turn history. It is withheld until enough quota failures make it meaningful. It cannot supply an exact vendor balance or reset time. Turn token usage is separate from account quota and appears only when the vendor sends it. ACP itself does not require any agent to expose an account balance or an effort picker.

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
