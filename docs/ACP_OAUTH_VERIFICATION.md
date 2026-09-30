# OAuth-capable ACP harness verification

Checked on Linux, 2026-09-30. The catalog declares 18 harnesses with both `oauth` in `localAuth` and an ACP entry point. All 18 installed ACP executables answered `initialize`; 15 also created a session. A complete live check means ClikCode sent a short prompt, received an actual answer, resumed the same conversation, and kept `nativeTransport: acp` with the same vendor session ID. An ACP handshake or a normal protocol stop with a quota notice is not a complete check.

| Harness | ACP startup | ClikCode turn and resume | Current blocker |
| --- | --- | --- | --- |
| OpenCode | Pass | Pass | None; tested with `opencode/big-pickle` |
| Claude Code | Pass | Pass | Official `claude-agent-acp` adapter auto-installed, tested with `haiku` |
| Cursor Agent | Pass | Pass | Native `cursor-agent acp`, tested with `default[]` |
| Grok Build | Pass | Pass | Native `grok agent stdio`, tested with `grok-4.6`; usage is a session total and is converted to a turn delta |
| Goose | Pass | Pass | None; tested with `codex/gpt-6-luna` and `claude-code/haiku`, including ACP provider/model selection and native resume |
| Kiro | Pass | Pass | None; tested with `auto` |
| Cline | Pass | Pass | None; tested with `anthropic/claude-sonnet-5` |
| Hermes | Pass | Pass | None; tested with `openai-codex:gpt-6-astra` |
| Auggie | Pass | Blocked | Vendor returned a usage exhaustion notice as assistant text; ClikCode now recognizes it as a quota failure |
| Copilot | Pass | Blocked | Local accounts are marked quota exhausted |
| Droid | Pass | Blocked | Local account is marked quota exhausted |
| Kilo | Pass | Blocked | Vendor turn exhausted the local account's quota |
| Gemini CLI | `initialize` passes; `session/new` rejects | Blocked | This individual account is ineligible for Gemini CLI; [Google says](https://github.com/google-gemini/gemini-cli/discussions/28017) individual Gemini CLI access ended, while enterprise licenses and API key access remain |
| Kimi | `initialize` and `session/new` pass | Blocked | `session/prompt` says this subscription lacks Kimi Code access |
| Qwen Code | `initialize` passes; `session/new` requires login | Blocked | Sign in through Qwen Code CLI |
| Devin | `initialize` and `session/new` pass | Blocked | `session/prompt` requests browser sign-in |
| Junie | `initialize` and `session/new` pass | Blocked | `session/prompt` requests Junie account sign-in |
| MiniMax Code | `initialize` passes; `session/new` requires login | Blocked | Run `mcode login` with a usable account |

ClikCode now prefers ACP for all 18. When an interactive turn receives an authentication refusal and the agent advertises exactly one agent-managed ACP method, ClikCode calls ACP `authenticate` and retries once. Terminal-only methods still use the vendor's terminal login. A new chat may use its CLI only for an ACP capability the agent does not offer; existing vendor threads stay on their original transport.

The three previously missing CLIs (Devin, Junie, MiniMax Code) are installed and pass `initialize`. Devin's official installer exits nonzero when its optional post-install login is canceled; ClikCode now accepts the install if the binary is present. These install and authentication checks do not claim that an unlicensed vendor account can complete a turn.

To finish the 10 blocked live checks, restore the vendor access named in the table, then repeat a ClikCode turn and resume in a temporary workspace and verify the saved `nativeTransport` and vendor session ID. Keep prompts read-only and short so the check tests the transport rather than tool behavior.
