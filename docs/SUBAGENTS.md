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
| amp | yes (C: Amp docs describe sub-agents) | yes (V: conformance fixture) | live frames, async rows stay active until `subagent_finished` | no direct child steer | `frames` / `none` |
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
- Vendor steer: Claude Code only, as a relay through the main agent. Not exercised
  against a real Claude Code (no quota-spending probe was made); the
  `steer-subagent` command, the relay text and the refusal lines are unit
  tested. Other vendors remain read-only; ClikCode's own background agents accept direct messages.
- A background sub-agent's row now stays running until the vendor says the agent ended, where the vendor says so: Claude Code (stream-json `task_started`/`task_progress`/`task_notification`, and over claude-agent-acp the same frames as `_claude/sdkMessage`), Cursor (`subagent_spawned`/`subagent_state_update`), Codex (`subAgentActivity` and the child thread's `turn/completed`), Amp (`Task` with `mode: "async"`, then `subagent_finished`), the own agent (`continuesAs`). `events/background-agent-rows.ts`; `subagent-lifecycle-conformance.vitest.test.ts`.
- The conversation worker now owns subagent reads for both clients. Codex uses
  `thread/read` on its existing app-server, with saved child prose and captured
  activity as the fallback after it closes. Claude reads the selected account's
  transcript; other adapters expose the frames they actually publish.
- VS Code agent rows have a view on live and finished calls. It polls only while
  open and running, and stops when closed or unmounted. Messaging is offered only
  for a declared relay or ClikCode's own direct background-agent session.
- `/agents view [id]` lists or reads recorded subagents in a reopened terminal
  conversation. ClikCode's own background agents are also reachable from the live
  terminal view and the VS Code view through `BackgroundAgents.send`.
- The webview does receive `call.input`: the worker broadcasts the whole
  normalized event, `asActivity` spreads it, `Activity` picks `call`, and
  model-patch is a structural diff with no field filter (read, not run).

## What ends a sub-agent (the lifetime guarantees)

The rule: **nothing interrupts a sub-agent except the user explicitly stopping
it.** A message typed mid-turn steers; it never cancels. What each kind of
sub-agent can honestly promise:

### ClikCode's own agent (`agent` tool, `background: true`)

Owned by the **session** (the conversation's worker), not by the turn
(`src/agent/background-agents.ts`). Each has its own abort signal that only an
explicit stop fires.

| Event | Effect on a running background agent |
|---|---|
| Esc / Ctrl+C / the editor's Stop on the turn | none: the turn ends, the agent runs on, its result is queued as a notification and a follow-up turn delivers it |
| a window closes, resizes, detaches | none (the worker owns the agent, not a window) |
| model or account switch | none (the turn waits for agents before switching; the agent keeps its own model client) |
| a newer ClikCode build | none: the worker declines to retire (`retireBlocker`: "background agents are running") and steps down once they finish and the model has been told |
| `/agents stop <id>` or `/agents stop all`, then `confirm` (editor: "Stop Background Agents", modal naming them) | stops them; their work is committed to their branch |
| the worker must go anyway (SIGTERM, its home removed, power) | graceful: stopped, work committed to branch, the next turn is told "interrupted" |
| the worker is killed hard (SIGKILL, OOM, crash) | not survivable in-process. The on-disk record (`<state>/agent-registry/<session>.json`) lets the next worker commit the abandoned worktree to its branch and report the agent interrupted (`reconcileAgents`) |

Honest limit: the agents run **inside the worker process**, not as detached
processes of their own. A hard kill of the worker ends them; no work is lost
(committed on the next start) but they do not keep running. Approvals an agent
needs are asked through the worker's windows; with none attached the request
waits like any other.

`list_agents` and `/agents` show them, including ones an earlier worker ran.

### Vendor harnesses (Claude, Codex, Cursor, ...)

ClikCode does not own these sub-agents; the vendor does. Claude's ACP adapter
cancels its sub-agents when the turn is cancelled (`session/cancel`; each
transcript ends `[Request interrupted by user for tool use]`). So:

- A plain Esc, Ctrl+C or editor Stop while the vendor reports an open
  sub-agent call is **held**: ClikCode says it is running N sub-agents and that
  stopping would end them; a second Esc/Ctrl+C within 30 s confirms. Nothing is
  sent to the vendor for the first. (A script's abort signal is a decision
  already made and stops at once.) Every Stop is logged with its origin:
  `worker.cancel {client, clientPid, trigger}`.
- A vendor's sub-agents die if the vendor process dies (worker retirement is
  already held while the vendor runs background work, `persistentWorkRunning`).
  ClikCode cannot make a vendor keep them across its own exit.
- Steers: an ACP agent takes a steer only when no tool call is open
  (`steerSafe`); otherwise it is held. ClikCode itself answers at once ("Steer
  received ... held until <call> pauses"), repeats every minute while held, and
  says when it was delivered or that it will run as the next message. It cannot
  make a vendor read a message sooner than the vendor allows.

#### When a vendor's agent dies because the account is out

One path for every transport, because the conversation is ClikCode's, not the process's.

1. **The transport reports the end, with why, as fields.** Each transport has a small adapter from its
   own frames to `FailureEvidence` (`harness/transport/handoff-work.ts`): status code, error type,
   rate-limit status, whether the text is the vendor's own error, and the words as detail.
   | Transport | What the adapter reads |
   |---|---|
   | Claude over ACP, Claude stream-json | `task_notification`: status, the summary's API-error envelope (`error type rate_limit, HTTP 429`), and the agent's saved transcript flags (`isApiErrorMessage`, `error: 'rate_limit'`). A terminal `task_updated` patch ends nothing by itself: the notification that follows carries the reason. |
   | Codex app-server | a sub-agent thread's failed `turn/completed` error: `codexErrorInfo` and status (`codexErrorKind`) |
   | Amp stream-json | `subagent_finished` status and error, or the Task call's failed result |
   | Direct API | the response status (`agentTurnFailureKind`); it has no background vendor process |
2. **One ledger** (`turn/vendor-process.ts reportEndedWork`) takes every report, from a live process or one
   the conversation left, and counts a repeat once.
3. **One observer** (`turn/account-evidence.ts`) classifies the evidence the same way as a main turn's
   failure (`classifyAccountFailure` is the only place that reads wording). When it says the account is out of
   usage: the account is marked spent once, the conversation moves to the next usable account at once (a turn
   running on the spent account fails over by itself, standby included), and the cut-off work is queued for
   that account.
4. **The cut-off work is taken up again from what ClikCode has**: its task, the progress it made and its saved
   transcript, on every harness. Claude's own resume (`SendMessage` to the agent id) is used only when the
   agent's history could be carried to the new account.

Before a turn, a conversation also leaves an account whose usage reading shows the turn will not fit
(`turn/account-burn.ts`): the margin is the account's measured burn per turn, the reading must be current, and
the new account must have more room by that margin. A stale reading never moves a chat.

### Steering ClikCode's own loop

A message typed while a call runs is held, acknowledged by ClikCode, and the
long-waiting calls return early so the model hears it within seconds:
`agent_wait` and `wait` return; a foreground shell command is moved to a
background shell (it keeps running; nothing is killed).

### Install check

`npx vitest run src/worker/agents-survive.vitest.test.ts`: cancel the turn,
worker replacement, window closed: the agent still finishes; a dead worker's
agent is committed to its branch and reported. Also run
`src/agent/subagent.vitest.test.ts` (turn cancel leaves the agent running;
explicit stop commits its work) and `src/worker/worker-agents.vitest.test.ts`.
