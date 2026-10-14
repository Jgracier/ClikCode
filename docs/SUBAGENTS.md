# Sub-agents: what each harness lets a client do

ClikCode is a conduit. Opening a sub-agent into its own full view (read it,
steer it, go back, open another) is offered **only where the vendor gives a
client the means**; nothing is invented. The declaration lives next to
`capabilities` on `AiLocalHarnessDefinition` (`subagents: { read, steer }`,
packages/clikrouter/src/ai-local-harness.ts) and is tied by
`src/harness/protocol/subagents-conformance.vitest.test.ts` to
`capabilities.childActivity`.

Evidence tags: **V** = verified (read in this repo's code, run against a local
binary or a real probe, or read from the vendor's shipped type definitions),
**C** = claimed (vendor documentation or a note we could not exercise),
`unknown` = no evidence either way. The 29 rows are
`AI_LOCAL_HARNESSES` (`node scripts/build.mjs`, then `dist/harness-catalog.cjs`).

`read`: `transcript` (a saved transcript a client can read, and live frames),
`thread` (the vendor's own read call on the child), `session` (a child
session), `frames` (only what arrives live), `none`.
`steer`: `session`/`thread` (a direct send), `relay` (a visible steer to the
main agent asking it to message the sub-agent), `none`.

| Harness | Has sub-agents | Child frames reach ClikCode | A client can READ one | A client can SEND to one | Declared read / steer |
|---|---|---|---|---|---|
| claude | yes (V: `Task`/`Agent` tool, `--agents`, `claude agents`) | yes (V: `parent_tool_use_id`, conformance fixture) | V: SDK `getSubagentMessages(sessionId, agentId)`; on disk `<profile>/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl` | no direct call (V: model tool `SendMessage{to:agentId}` only). Relay through the main agent works in principle; addressing by `SDKUserMessage.parent_tool_use_id` unverified | `transcript` / `relay` |
| codex | yes (V: probe, `spawn_agent`, multi-agent v2) | yes (V: probe, `subAgentActivity{agentThreadId}` and `collabAgentToolCall` arrive on the parent's connection; child `turn/completed` too) | V (probe): `thread/read {threadId, includeTurns}` returns the child, `parentThreadId` set, its `agentMessage` item present | **no** (V, probe): `turn/start` on the child is refused: `direct app-server input is not allowed for multi-agent v2 sub-agents`. `turn/steer` not tried; the server's message covers direct input | `thread` / `none` |
| cursor | yes (V: `subagent_spawned` with `subagentSessionId`, acp-client.ts) | yes (V: frames with parent keys) | live frames only (V). Reading the session by id: unknown | unknown: whether `session/prompt` to `subagentSessionId` steers was never tried | `frames` / `none` |
| qwen | yes (V: `--max-subagent-depth` in `qwen --help`) | yes (V: conformance fixture, `parent_tool_use_id`) | live frames only | unknown | `frames` / `none` |
| amp | yes (C: Amp docs describe sub-agents) | yes (V: conformance fixture) | live frames only | unknown | `frames` / `none` |
| grok | yes (V: `--agents`, `--no-subagents`, `Agent Dashboard` in `grok --help`) | no (V: counts at most) | the dashboard lists sub-agents as sessions (V: help text); no client route known | unknown | `none` / `none` |
| copilot | yes (V: `--fleet` in `copilot --help`) | no | unknown | unknown | `none` / `none` |
| opencode | yes (C: child sessions) | no | C: child sessions; `opencode export [sessionID]` exists (V: help) but ClikCode is never told a child's id | unknown | `none` / `none` |
| gemini | yes (C: documented experimental sub-agents) | no | unknown | unknown | `none` / `none` |
| kiro | yes (C: `session_created_reason: 'subagent'` seen in its session data) | no | unknown | unknown | `none` / `none` |
| devin | yes (C: `subagent_heads` table in its store) | no | unknown | unknown | `none` / `none` |
| auggie | yes (C: `subAgentCreditsUsed` in its result) | no (a credit count only) | unknown | unknown | `none` / `none` |
| hermes | yes (C: `delegate_task` tool) | no | unknown | unknown | `none` / `none` |
| cn (Continue) | yes, beta (V: `--beta-subagent-tool` in `cn --help`) | no | unknown | unknown | `none` / `none` |
| goose | unknown | no | unknown | unknown | `none` / `none` |
| cline | unknown | no | unknown | unknown | `none` / `none` |
| kilo | unknown (OpenCode fork; C: inherits child sessions) | no | unknown | unknown | `none` / `none` |
| pi | unknown | no | unknown | unknown | `none` / `none` |
| droid | unknown | no | unknown | unknown | `none` / `none` |
| kimi | unknown | no | unknown | unknown | `none` / `none` |
| vibe | unknown | no | unknown | unknown | `none` / `none` |
| openhands | unknown | no | unknown | unknown | `none` / `none` |
| dcode | unknown | no | unknown | unknown | `none` / `none` |
| junie | unknown | no | unknown | unknown | `none` / `none` |
| mcode | unknown | no | unknown | unknown | `none` / `none` |
| command (cmdc) | unknown | no | unknown | unknown | `none` / `none` |
| antigravity | unknown | no | unknown | unknown | `none` / `none` |
| openclaw | unknown (V: `fleet` in `openclaw --help` provisions tenant cells, not sub-agents) | no | unknown | unknown | `none` / `none` |
| aider | no known concept | no | no | no | `none` / `none` |

The own agent (ClikDeploy Gateway / ClikCode Local, `src/agent/subagent.ts`,
`background-agents.ts`) is not a catalog row: its sub-agents are ClikCode's own,
so both read and steer are ClikCode's to define (`session`/`session`).

A harness moves out of `none` only with evidence for the new cell, recorded here
first. A row that says `unknown` is not a promise it cannot be done.

## Probe log

- Codex 0.162.1, `codex app-server` over stdio in `scripts/vendor-sandbox.mjs
  --auth codex`, two tiny turns (one `spawn_agent` of a sub-agent that says OK):
  child id arrived as `subAgentActivity.agentThreadId`; `thread/read` of it
  succeeded; `turn/start {threadId: child}` returned error -32600 `direct
  app-server input is not allowed for multi-agent v2 sub-agents`.

## What ClikCode does today

Verified by unit tests and, for the terminal, by the pty scenario
`subagent-view` (a fake ACP vendor declared as Qwen): open from an expanded row
with Right, the read-only line, back with Left.

- Terminal, live turn, any harness with `read !== 'none'` (claude, codex,
  cursor, qwen, amp): open, watch the live frames (Claude: the transcript on
  disk when it is found), switch siblings, go back.
- Steer: Claude Code only, as a relay through the main agent. Not exercised
  against a real Claude Code (no quota-spending probe was made); the
  `steer-subagent` command, the relay text and the refusal lines are unit
  tested. Everything else is read-only with the line saying why.
- Not done: the VS Code panel; reopening a finished sub-agent in a reopened
  chat; reading a Codex child thread live in the view (the reader exists,
  `codexThreadRows`, but the view is not connected to `thread/read`); the own
  agent's sub-agents (Gateway `session` steer: `BackgroundAgents.send` exists
  but is not reachable from a window).
- The webview does receive `call.input`: the worker broadcasts the whole
  normalized event, `asActivity` spreads it, `Activity` picks `call`, and
  model-patch is a structural diff with no field filter (read, not run).
