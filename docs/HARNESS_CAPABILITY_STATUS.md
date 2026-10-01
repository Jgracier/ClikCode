# Harness capability status

Checked against the ClikCode catalog on 2026-09-30. A listed control is a ClikCode integration, not proof that every vendor account or model accepts it. `ACP` model discovery means ClikCode asks the agent's session for models when it offers them; an empty or refused response cannot become a complete list. Server-sourced model lists refresh after five minutes, with the last list shown while a picker refreshes.

| Harness | Model source | Effort | Permissions | Account usage |
| --- | --- | --- | --- | --- |
| Claude Code | Installed vendor model table | Yes | Ask, bypass, auto | Direct probe |
| Grok Build | Vendor CLI | Yes | Ask, bypass, auto | Direct probe |
| Gemini CLI | ACP when available | No declared control | Ask, bypass, auto | Learned after refusals |
| Codex | Vendor model cache | Yes | Ask, bypass, auto | Direct probe |
| OpenCode | Vendor CLI | Yes | Ask, bypass | Learned after refusals |
| Copilot | Public models.dev catalog; account eligibility checked by vendor | No declared control | Ask, bypass | Direct probe |
| Aider | Configured providers and their caches | No declared control | Ask, bypass | Learned after refusals |
| Goose | Configured providers and ACP | No declared control | Ask, bypass, auto | Learned after refusals |
| Amp | Configured or saved account models | No declared control | No declared modes | Direct probe |
| Antigravity | Vendor CLI | No declared control | Ask, bypass | Learned after refusals |
| Pi | Vendor CLI | Yes | No declared modes | Learned after refusals |
| Droid | ACP when available | Yes | Ask, bypass, auto | Learned after refusals |
| Kiro | ACP when available | Yes | Ask, bypass | Learned after refusals |
| Qwen Code | ACP when available | No declared control | Ask, bypass, auto | Learned after refusals |
| Cline | ACP when available | Yes | Ask, bypass | Learned after refusals |
| Kilo | Vendor CLI | Yes | Ask, auto | Direct probe |
| Cursor Agent | ACP when available | No declared control | Ask, bypass, auto | Learned after refusals |
| Hermes | Provider inventory and cache | Yes | Ask, bypass | Learned after refusals |
| OpenClaw | Vendor configuration and provider inventory | Yes | No declared modes | Learned after refusals |
| Command Code | Vendor CLI | Yes | Ask, bypass, auto | Learned after refusals |
| Kimi CLI | ACP when available | No declared control | Ask, bypass, auto | Direct probe |
| Auggie | Vendor CLI | Yes | No declared modes | Direct probe |
| Mistral Vibe | ACP when available | No declared control | Ask, bypass, auto | Learned after refusals |
| OpenHands | ACP when available | No declared control | Bypass, auto | Learned after refusals |
| Continue | Configured or saved account models | No declared control | Ask, bypass | Learned after refusals |
| Deep Agents Code | ACP when available | No declared control | No declared modes | Learned after refusals |
| Devin CLI | ACP when available | No declared control | No declared modes | Learned after refusals |
| Junie CLI | ACP when available | Yes | No declared modes | Learned after refusals |
| MiniMax Code | ACP when available | No declared control | No declared modes | Learned after refusals |

`Learned after refusals` is an estimate from the selected account's turn history. It is withheld until enough quota failures make it meaningful. It cannot supply an exact vendor balance or reset time. Turn token usage is separate from account quota and appears only when the vendor sends it. ACP itself does not require any agent to expose an account balance or an effort picker.

ClikCode keeps model and usage data keyed to the selected account or its isolated vendor profile. The model picker and account picker now refresh server lists and share current usage readings between ClikCode processes. This does not create multiple simultaneous vendor logins where a vendor refuses them.

For live ACP turn and resume evidence, see [ACP_OAUTH_VERIFICATION.md](ACP_OAUTH_VERIFICATION.md). Eight of the eighteen OAuth-capable ACP harnesses passed with available accounts. Ten remain blocked by sign-in, quota, subscription, or account eligibility. A handshake alone is not counted as a completed integration check.
