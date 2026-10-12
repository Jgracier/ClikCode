# ClikCode through the Gateway, against Claude Code and Codex

What was run, what it showed, and what was not compared. Everything here was measured on 2026-10-12; nothing is
inferred from reading code unless it says so.

## Real tasks, same prompt, real tools

Real Claude Code 2.1.296 (Sonnet 5.5), real Codex 0.155.1 (gpt-5.5) and ClikCode's own agent over the
ClikDeploy Gateway (Sonnet 5.5, served by Anthropic), each inside `scripts/vendor-sandbox.mjs` so nothing landed
in a real vendor history. Each task is a small Node repo; the pass/fail check is a hidden test the harness never saw,
applied afterwards, identical for all three. Cell: passes / runs · mean wall time · mean tool calls.

| Task | Claude Code | Codex | ClikCode (Gateway) |
|---|---|---|---|
| Bugfix (2 bugs, 1 latent) | 2/2 · 9 s · 3 calls | 2/2 · 34 s · 10 calls | 2/2 · 14 s · 3 calls |
| Rename across 8 files | 2/2 · 9 s · 2 calls | 2/2 · 44 s · 13 calls | 2/2 · 8 s · 2 calls |
| Add util by repo convention | 2/2 · 14 s · 3 calls | 2/2 · 55 s · 14 calls | 2/2 · 14 s · 12 calls |
| Review 4 modules with sub-agents | 1/1 · 28 s · 16 calls | 1/1 · 82 s · 24 calls | 1/1 · 22 s · 7 calls |
| Debug 3 root causes | 1/1 · 16 s · 3 calls | 1/1 · 62 s · 17 calls | 1/1 · 11 s · 3 calls |
| Destructive command nobody can approve | 1/1 · 6 s · 1 calls | 1/1 · 10 s · 1 calls | 1/1 · 7 s · 1 calls |
| CLI feature across 6 files | 1/1 · 20 s · 3 calls | 1/1 · 68 s · 18 calls | 1/1 · 18 s · 5 calls |
| Debug 4 root causes, misleading symptoms | 1/1 · 12 s · 3 calls | 1/1 · 49 s · 17 calls | 1/1 · 22 s · 3 calls |
| Callbacks to promises across 9 files | 1/1 · 18 s · 3 calls | 1/1 · 115 s · 25 calls | 1/1 · 23 s · 3 calls |

All 36 runs passed their checks (12 per harness). No harness edited a test it was told not to touch or left a stray file.

- **Speed:** ClikCode and Claude Code run the same model through the same provider and finish in the same time
  (14.1 s against 14.2 s on the feature task). Codex runs a different model and is slower on every task; that is not
  a like-for-like comparison.
- **Style:** ClikCode uses its dedicated read, glob and edit tools one call at a time (12 calls on the convention task);
  Claude Code does the same work in a few shell commands (3 calls). The outcome and the wall time are the same.
- **Sub-agents:** asked for one sub-agent per module, Claude Code spawned 4, ClikCode 4, Codex 10.
- **An approval nobody can answer:** all three refused to delete the file and said so. Claude Code and ClikCode
  reported the refusal; Codex reported a read-only filesystem error. ClikCode's wording was wrong ("your approval prompt was
  declined" when no prompt was shown); it now says the action was not approved (declined, or no one available).
- **A long run:** a chain of 75 files that each name the next forces more than 60 sequential steps. The old ClikCode
  stopped at "Stopped after 60 steps"; the current build read all 75 and returned the answer ($0.30, one run each).

## What a turn shows, on the terminal

The same scripted turn (a reasoning heading, text, two parallel reads, closing text, usage) was run through ClikCode's own
agent against a loopback fake Gateway and through a native harness against its fake vendor, in the pty rig, and the screens
compared. These are fakes, not real Claude or Codex streams.

| | Own agent over the Gateway | Native harness |
|---|---|---|
| Reasoning row with its heading | `Thought for 1s · Planning` | same |
| Parallel reads | one grouped `Read 2 files` row, each file under it | same |
| End line | `Worked for 1s · ↑ 4.4k ↓ 100 tokens · $0.0052` | `Worked for 1s · $0.0052` (the fake sends no token counts) |
| Transient 503 | retried, the turn completes | retried, the turn completes |
| Esc mid-turn | `Stopped` | `Stopped` |
| Steer mid-turn | the steer is a row and the reply follows it | the steer is a row |
| Out of credit (402) | the Gateway's message and `All accounts exhausted` | not compared |
| Credit / usage, upper right of the composer | `$12.50 credit left`, `Unlimited credit` | the vendor's plan window |

## Not compared, so not claimed

- Real Claude Code and Codex *streams* inside ClikCode (only fakes), and long-horizon work beyond a few minutes.
- Plan mode, interrupting a run in the real tools, MCP, and approvals with a person answering.
- The compaction notice, a route change to another provider, and the plan card on the Gateway path.
- Cron tools (not built: nothing keeps running after a conversation's worker exits) and Antigravity thinking.
