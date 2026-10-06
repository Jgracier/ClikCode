# Harness capability status

Checked against the ClikCode catalog on 2026-10-06. A listed control is a ClikCode integration, not proof that every vendor account or model accepts it. `ACP` model discovery means ClikCode asks the agent's session for models when it offers them; an empty or refused response cannot become a complete list. Server-sourced model lists refresh after five minutes, with the last list shown while a picker refreshes.

| Harness | Model source | Effort | Permissions | Free-plan models | Account usage |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Installed vendor model table | Yes | Ask, bypass, auto | - | Direct probe, and its turn stream |
| Grok Build | Vendor CLI | Yes | Ask, bypass, auto | Plan's own list | Direct probe (ACP extension call) |
| Gemini CLI | ACP when available | No declared control | Ask, bypass, auto | - | Learned after refusals |
| Codex | Vendor model cache | Yes, per model | Ask, bypass, auto | Plan's own list | Direct probe |
| OpenCode | Vendor CLI | Yes | Ask, bypass | Zero-price models in its list | Learned after refusals |
| Copilot | Its own server, for this account (`models.list`); public models.dev catalog only when that fails | Yes, over ACP (levels from `copilot --help`) | Ask, bypass | Plan's own list | Direct probe (`account.getQuota`) |
| Aider | Configured providers and their caches | No declared control | Ask, bypass | `:free` models | Learned after refusals |
| Goose | Configured providers and ACP | Yes, over ACP (levels from its `thinking_effort` option) | Ask, bypass, auto | `:free` models | Learned after refusals |
| Amp | No model selector | No declared control | No declared modes | - | Credit balance (`amp usage`) |
| Antigravity | Vendor CLI | No declared control | Ask, bypass | Plan's own list | Direct probe (quota pools) |
| Pi | Vendor CLI | Yes | No declared modes | `:free` models | Learned after refusals |
| Droid | ACP when available | Yes | Ask, bypass, auto | - | Learned after refusals |
| Kiro | ACP when available | Yes | Ask, bypass | Plan's own list | Direct probe (its `/usage` over ACP) |
| Qwen Code | ACP when available | No declared control | Ask, bypass, auto | - | Learned after refusals |
| Cline | ACP when available | Yes | Ask, bypass | `:free` models | Credit balance, advisory (`:free` models still run when it is spent) |
| Kilo | Vendor CLI | Yes | Ask, auto | `:free` models, and the ones its list marks free | Credit balance (`kilo profile`) |
| Cursor Agent | ACP when available | No declared control | Ask, bypass, auto | Auto (the models it does not count as named) | Direct probe |
| Hermes | Provider inventory and cache | Yes | Ask, bypass | `:free` models | Direct probe (Nous Portal credits) |
| OpenClaw | Vendor configuration and provider inventory | Yes | No declared modes | - | Learned after refusals |
| Command Code | Vendor CLI | Yes | Ask, bypass, auto | - | Direct probe |
| Kimi CLI | ACP when available | No declared control | Ask, bypass, auto | - | Direct probe |
| Auggie | Vendor CLI | Yes | No declared modes | - | Credit balance (`auggie account status`) |
| Mistral Vibe | ACP when available | No declared control | Ask, bypass, auto | - | Direct probe (a key whose plan allows no requests reads spent) |
| OpenHands | ACP when available | No declared control | Bypass, auto | - | Learned after refusals |
| Continue | Configured or saved account models | No declared control | Ask, bypass | - | Learned after refusals |
| Deep Agents Code | ACP when available | No declared control | No declared modes | - | Learned after refusals |
| Devin CLI | ACP when available | No declared control | No declared modes | Plan's own list | Direct probe (daily and weekly) |
| Junie CLI | ACP when available | Yes | No declared modes | - | Learned after refusals |
| MiniMax Code | ACP when available | No declared control | No declared modes | - | Learned after refusals |

`Plan's own list` means the vendor lists only what the account's plan runs, so on a plan the vendor itself calls free every listed model is a free one; the plan comes from the account's usage reading. `:free` is OpenRouter's free-model suffix, which those harnesses route through. A credit balance is shown as a label, not a window: it never marks an account spent by itself.

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
