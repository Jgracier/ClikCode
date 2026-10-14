# Look audit: how each harness path becomes a row

Scope: every producer of a `HarnessActivityEvent`, and every place a surface
draws one. Written before the unification work (`activity-normalize.ts`,
`look.ts`); the "Before" column is what the code did then, the last section is
what changed.

## Producers

| Path | Source | `category` | Label | Lifecycle (start/done/error/stopped) | output / diff / exit / duration | Thought | Sub-agent |
|---|---|---|---|---|---|---|---|
| Claude Code, Qwen, Grok, Gemini, Amp (stream-json, `claudeShaped`) | `activity-events.ts` `claudeShapedActivity`, `events/claude-stream.ts` | `toolFacts` (name table + input shape + Edit diff) | `formatToolRow` via `toolLabel` (`$ cmd`, `Read path`) | start from `tool_use`, done/error from `tool_result.is_error` (label `tool`, merged by id); stopped by the turn | output head (not tail) capped 60; diff from input; no exit/duration; sub-agent totals from `tool_use_result` | text streamed (`thoughtLabel`, 240 chars), id `thinking:<msg>` | `agent` from tool name / `subagent_type`; children by `parent_tool_use_id` |
| Claude Code via ACP (claude-agent-acp), Copilot, Cursor ACP, Kimi, Qwen ACP, Hermes, OpenCode ACP ... | `transport/acp-client.ts` `acpActivityEvent` | ACP `kind` map, else `command`/name | `toolLabel` from `rawInput`; else the agent's own **title sentence** (`Read config`, `` `npm test` ``) or `tool` | start/update/completed/failed; completed-with-nonzero-exit stays `tool-done` | output **tail**, diff from `content[type=diff]`, exit from `_meta.terminal_exit`, duration from `rawOutput` | `agent_thought_chunk`, last 160 chars (not `thoughtLabel`) | `_meta` parent keys; `agent` from name/title |
| Codex app-server | `transport/codex-app-server.ts` `codexActivityForItem` | fixed per item type; MCP via `categoryOf(..,'codex')`; `collab` -> agent (no category) | `formatToolRow('shell', cmd)`, `fileChangeActivity` paths, `toolLabel` | start/completed, declined -> error | tail output, per-file unified diff, exit + duration | `reasoning` summary via `thoughtLabel`, keyed by item id | collab calls, children by `parentId` |
| Codex exec JSON, OpenCode/Kilo (`opencodeShaped`), Cursor stream-json, Antigravity, Command Code, Pi, Goose, Cline | `activity-events.ts` `singleActivityEvent`/`gooseActivity`, `events/cline.ts` | `toolFacts` or a fixed `run`/`edit` | `formatToolRow` | Cursor/opencode/Pi: done+error; Pi without ids: always `tool-start`; Cline: settled by the next message | head output (Codex exec/opencode/Pi), tail (Cursor/Cline); exit for Codex/Cursor | **different cuts**: `visibleSlice(..,140)` (Codex exec, Goose), raw text (Cursor), `thoughtLabel` (others) | `collab_agent`, `agent` by name |
| ClikDeploy Gateway agent, ClikCode Local (`agent/*`, `gateway/harness.ts`) | `agent/turn-tools.ts`, `turn-model-step.ts`, `turn-notifications.ts` | `categoryForTool` (name, then tool class); **none** for MCP/`todo_write`/notification rows | each tool's own `label()` (mostly `formatToolRow`; others free text: `Wait for ..`, `Output of sh1`, `Kill sh1`) | start (+ progress start frames), done/error, notification rows are synthetic `tool-done` | output head (`eventOutputPreview`), diff, exit, duration | `reasoning` text via `thoughtLabel` | `agent: true` for Task |
| Worker / observer / journal | `worker/broadcast-observer.ts`, `turn/turn-output.ts` `turnSink`, `turn/turn-activities.ts` | passed through | passed through | merges by id (`mergeActivity`), stopped on turn end | bounded at save (`boundEvent`) only | `stepThought` | `withChildTool` |

## Where rendering differed

1. **Missing `category` meant no glyph and no colour** (`activity-line.ts`: `style ? ... : ''`). MCP tools, Gateway free-text rows and unknown ACP tools were bare rows; the same call from Claude had a `‣`.
2. **Per-category colour in the terminal**: `status-line.ts statusColour` (read blue / edit magenta / run yellow / search cyan / fetch green), `waiting.ts runningChatLine` (same table, `dim` when unknown). The tool-row glyph itself was already one colour.
3. **Per-category colour in the webview**: `.tone-blue/.tone-magenta/...` in `styles.css`, picked in `flow.ts workingStatus` and `activity-rows.tsx toneOf`; per-category codicons (`file`, `edit`, `terminal`, `search`, `globe`) instead of `‣`; a codicon `lightbulb` instead of `✻` for thoughts; a sub-agent always cyan.
4. **Thought rows**: `renderActivityLine` drew `thinking <text>` in cyan; the call-group rows and settled rows drew `✻ Thought for Ns` dim-italic; the webview drew a lightbulb row in the theme foreground.
5. **Label shape**: ACP agents that send no input fall back to the agent's own title (`Read config`, `` `npm test` ``); `Bash(cmd)`-style labels from any adapter that echoes the vendor's string; Gateway tools with free-text labels.
6. **Thought text length**: 140 / 160 / 240 characters / raw, depending on the adapter.
7. **Lifecycle**: ACP `completed` with a non-zero `exit_code` stayed `tool-done`; a run's output was head-bounded by some adapters and tail-bounded by others.
8. **Vendor checks in the renderers**: none by name. `claudeShaped`/`opencodeShaped` are only in `activity-events.ts` (parse), `activity-line.ts nativeActivityPhaseFromValue` (the "generating response" phase), `events/adapters.ts` and `turn-result.ts` (text), none in `src/tui/render` or the webview. `session.nativeHarness` is read in `protocol/labels.ts` and the pickers, for names, not rows. The drift was in the adapters' facts and in the two surfaces' own palettes.

## What changed

- `protocol/activity-normalize.ts`: one pure, idempotent `normalizeActivityEvent`, applied in `turnSink.activity` (saved turn + observer), `BroadcastObserver.activityEvent` (both surfaces, every producer incl. the Gateway's direct prompter call) and `readTurnActivities` (old saved turns). See the file header for the rules.
- `protocol/look.ts`: the design tokens; terminal painters in `protocol/tool-category-style.ts`; webview variables set from the same tokens (`webview/look.ts`).
- Conformance + guard tests: `protocol/look-conformance.vitest.test.ts`, `protocol/look-guard.vitest.test.ts`.
