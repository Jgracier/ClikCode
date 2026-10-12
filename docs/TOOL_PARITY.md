# Tool parity: ClikCode's own agent vs Claude Code and Codex

ClikCode's own agent is the one the Gateway and ClikCode Local routes run (`src/agent`). Schemas and semantics
below come from Claude Code 2.1.296 (recorded sessions in `~/.claude/projects`, strings of its binary) and Codex
0.155.1 (rollouts in `~/.codex/sessions`). Nothing here is guessed.

## Decisions

| Their tool | Decision | ClikCode tool | Reason |
| --- | --- | --- | --- |
| Claude `EnterPlanMode` `{}` | implement | `enter_plan_mode` | Pairs with `exit_plan_mode`; asks the user first (as Claude's "Enter plan mode?" dialog), then the turn and the chat stay in plan mode (`onPlanModeEnter`, `session.planMode`). Hidden while planning. |
| Claude `ListAgents` `{}`; Codex `list_agents` | implement | `list_agents` | Read-only over `BackgroundAgents.list()`: this turn's background agents and whether their result was delivered. Claude's lists peer sessions too; ClikCode has no peer-session messaging, so only its own agents. |
| Claude `Monitor` `{command, description, timeout_ms, persistent}` | implement (command form) | `monitor` | A background shell whose stdout lines are delivered as messages (batched 250 ms, 40 lines/4000 chars a message), reusing the shell notification path. Bounded: 5 min default / 1 h max deadline, `persistent` lifts it, stopped after 500 lines; each ending is reported. Exec class, gated and hard-deny-checked like `bash`. Not built: the `ws` (WebSocket) source, `allowed_domains`. |
| Claude `ScheduleWakeup` `{delaySeconds, prompt, reason, noop, stop}` | implement, with a stated limit | `schedule_wakeup` | Delay clamped to 60..3600 s as Claude does; `stop` cancels. The timer lives in the conversation's worker, which is held up while one is pending and delivers it as a follow-up turn. It is NOT durable: a worker that stops first (shutdown, crash) cannot fire it, so it is recorded as lost and the model is told next time (`disposeSessionState`). Dropped: `noop` (a UI streak counter) and the `/loop` skill sentinel. |
| Claude `ToolSearch` | not applicable | `load_mcp_tools` | ClikCode loads every built-in schema each turn; only MCP tools are deferred, and `load_mcp_tools` (`mcp/deferred.ts`) is that mechanism. |
| Claude `TaskStop` `{task_id}` | alias | `kill_bash` | Stops a background shell, including a monitor. A background agent cannot be stopped separately: it ends with the turn (cancellation). |
| Claude `TaskOutput` `{task_id, block, timeout}` | alias | `bash_output`, `agent_wait`, `wait` | Shell output so far; an agent's result with a timeout; blocking on a shell's exit or output. |
| Claude `CronCreate/Delete/List` | not built | `schedule_wakeup` | A cron needs a scheduler that survives the worker; workers exit when idle (`IDLE_EXIT_MS`) and nothing in `src/daemon` fires work for a conversation. Doing it honestly needs a durable scheduler, not a timer in a process that may stop. |
| Claude `ReportFindings` | not applicable | none | Renders code-review findings in Claude's own host UI; ClikCode has no such surface. |
| Claude `Workflow` `{scriptPath, args}` | not applicable | none | Launches Claude's `.claude/workflows/*.mjs` scripts in its own runtime. |
| Claude `SendMessage`, Codex `send_message` / `followup_task` | already covered | `agent_send` | |
| Codex `spawn_agent`, `wait_agent` | already covered | `agent` (`background`), `agent_wait` | |
| Codex `exec`, `wait` | already covered | `bash`, `wait` | |

## Permission classes

`list_agents` is `read` (concurrent). `enter_plan_mode` is `meta`: asked in ask and auto mode, allowed under bypass,
never offered in plan mode. `monitor` and `schedule_wakeup` are `exec`: asked like `bash`, refused in plan mode,
and absent from sub-agents (`subagent.ts`).

## Not built

Cron tools, `ws` monitors, peer-session listing, stopping a single background agent, and a durable `schedule_wakeup`.
