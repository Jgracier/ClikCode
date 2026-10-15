# Steering: a message typed while a turn runs

## The rule

- `/send steer|queue` is one global setting (`globalSettings.sendMode`, `src/turn/send-mode.ts`). Absent means **steer**: a fresh install steers. The terminal's `/send` and the editor's `chat-settings` `send` read and write the same value, and the worker reads it as each message arrives, so a change mid-turn applies to the next message typed. No harness has its own override (`src/turn/send-mode-transports.vitest.test.ts`, `src/ide/queries.vitest.test.ts`).
- **Steer never interrupts.** A steer goes into the running turn only through a path the vendor itself offers for that (a message taken at the turn's next step). ClikCode never cancels and resends a turn to fake one.
- **A steer is delivered once.** It is either taken into the running turn, whose model can then answer it, or it is queued durably and runs as the next turn when this one ends. Nothing is accepted and then dropped: a refused, timed-out or too-late steer falls back to the queue (`LiveTurnInputBroker.submit`). ClikCode does not insert its own acknowledgement or reminder into the conversation.
- **A route that cannot steer queues, and the row says so**: `this turn can't take it`. A route that can steer but must wait for a quiet moment (no tool call open) queues the message as the fallback and the row says `sending at the next pause`; it becomes `steered` when it lands.
- `/send queue` never reaches any steer handler. Enter again with nothing typed (`send-queued`) is the user's explicit "put it into the chat now" and steers where the harness can.

## Per harness

VERIFIED = run for real against the vendor (or its real binary) by us. CLAIMED = from the vendor's source or docs, exercised only against a fake in tests. "Row" is what the user sees when the message cannot be steered.

| Harness | Steer path | Status | Notes |
| --- | --- | --- | --- |
| ClikCode agent (Gateway, ClikCode Local) | its own loop, before the next model step | VERIFIED (real turns against a fake OpenAI server, pty) | A steer typed while a tool call runs is held: row `sending at the next pause`, delivered when the last open call returns. The model cannot answer while a call runs. A steer typed during a foreground sub-agent's call goes to that sub-agent at once (it replies at its next step), and is also held for the main agent, which hears it when the call returns (`turn-runtime.ts` `foregroundSteers`; `subagent.vitest.test.ts`). |
| Claude Code | ACP `_session/steering` (agent advertises `_meta.steering.supported`) | VERIFIED | Held while a call is open: injected at once, it cancels the call (seen live). |
| Codex | app-server `turn/steer` | CLAIMED (protocol; tested against a fake app-server) | A refused steer (turn ended, compaction) queues. |
| Pi | `pi --mode rpc`, `steer` command: delivered after the running tool calls, before the next model call | VERIFIED against pi 0.87.0 with a local fake model server (a 6 s tool ran to its end, the next model request carried the message, the reply followed in the same run); ClikCode's one-shot turn over RPC ran once end to end (`clikcode send`). The steer wiring in the attempt is unit-tested, not driven against pi | Pi turns now run in RPC mode: images go inline (RPC refuses `@file`); stdin closes on `agent_settled` (15 s after `agent_end` for a pi that never sends it). |
| MiniMax Code (`mcode`) | ACP extension `mcode/session/steer` `{sessionId, text}` (listed in initialize `_meta['minimax-code/extensions'].methods`) | CLAIMED: read from mcode 0.5.10's source (refuses with an error when no prompt turn runs; its own TUI steers with Enter); not signed in here, so no real turn | Held like Claude's while a call is open (conservative: not known whether mcode's steer cuts a call). An error queues. |
| Amp | documented: `--stream-json-input` lines accept `"steer": true` ("handle a queued message at the next interruption point while the agent is busy", ampcode.com/docs/cli/streaming-json) | CLAIMED, **not implemented**: signed out here (`Session expired`), so neither the steer nor when `result` is emitted (it is printed once, after stdin closes) could be checked | Queues; row `this turn can't take it`. |
| Junie | advertises `_meta.steering.supported` but does not answer `_session/steering` (idle it answers `startedNewTurn`) | VERIFIED unusable on 26.9.22 (re-seen: same version, nothing newer) | Catalog `acp.steering: false`. Queues, row says so. |
| Grok, Gemini, OpenCode, Copilot, Goose, Droid, Qwen, Cline, Kilo, Cursor, Hermes, Command, Kimi, Auggie, Vibe, OpenHands, Devin | none: `initialize` lists no steering, queue or extension method (probed 2026-10-14) | VERIFIED absent from `initialize`; a mid-turn `session/prompt` is not a steer (ACP has none) | Queues; row says so. |
| Kiro, Deep Agents Code (`dcode`) | unknown: `initialize` is not answered without a sign-in (dcode: "No credentials configured") | unknown | Queues; row says so. |
| Antigravity | none found: `--input-format stream-json` runs one turn per stdin line, it does not take a line into a running one | read from `agy --help` only | Queues. |
| OpenClaw | none found in `--help` (`agent --local` is one-shot) | read only | Queues. |
| Aider, Continue (`cn`) | none: text CLIs, one-shot | read only | Queues. |

Where nothing could be probed for real (no sign-in), the table says CLAIMED or unknown rather than inventing vendor behaviour.
