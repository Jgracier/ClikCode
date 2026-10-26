# Steering: a message typed while a turn runs

## The rule

ClikCode is the conduit, not the driver. It passes a message to the vendor through the way the vendor gives for it, and never decides for the vendor or cuts anything to get a message in.

- **One place.** A message typed while a turn runs lives in exactly one place at a time: the saved queue (`session.queuedTurns`) or the turn. Each queue entry has one flag, `steer`: it is to go into the running turn, not wait for the next. There is no second, in-memory copy to reconcile.
- **`/send steer|queue`** is one global setting (`globalSettings.sendMode`, `src/turn/send-mode.ts`). Absent means **steer**. Steer sets the flag when the message is typed; queue does not. The terminal's `/send` and the editor's `chat-settings` `send` read and write the same value, and no harness has its own override (`src/turn/send-mode-transports.vitest.test.ts`).
- **The turn offers, the vendor takes.** A running turn publishes a *steer port* (`SteerPort`, `src/turn/live-input.ts`): `offer(text)` takes the message in now (true) or says this is not a moment it can be taken without interrupting something (false). The broker offers the oldest flagged message when it is typed and again each time the port says an opening began (`onWindow`). When the port takes it, the message is recorded on the turn and leaves the queue in one write.
- **Steer never interrupts.** A port refuses while a call is open (Claude Code's `_session/steering` pre-empts at once and cancels the call; Amp likewise) and takes the message at the next opening. Codex, Pi and Claude-shaped streams take it at any moment, the vendor deciding what to do with it. The ClikCode agent takes it at once: the model hears it at its next step (a wait returns early). ClikCode never cancels and resends a turn to fake a steer, and Enter again never cuts a call.
- **Nothing is dropped.** A refused, failed or too-late offer leaves the message in the queue, and it runs as the next turn when this one ends, in the order typed. A turn that was stopped or failed hands the messages that were to go into it back to the composer.
- **A turn that cannot steer** (no port: an agent with no steering) leaves everything queued for the turn to end. The turn tells every window whether it can (`steerable` on the live snapshot and as an event), so the composer says "queue a message for after this turn" and offers no Enter-again.
- **Queue mode** never offers a message to the turn on its own. Enter again with nothing typed marks the oldest queued message to go in and offers it to the turn now; if the vendor cannot take it yet it goes in at the next opening. It is not forced and no call is cut. Esc still stops the whole turn; Esc on a waiting message takes it back (refused only for the message being put into the turn that moment).
- **The window names the message.** The terminal and the editor give a message its id when it is typed, so the live row and the saved copy are one thing by identity; nothing is matched by words.

## Per harness

VERIFIED = run for real against the vendor (or its real binary) by us. CLAIMED = from the vendor's source or docs, exercised only against a fake in tests. "Row" is what the user sees when the message cannot be steered.

| Harness | Steer path | Status | Notes |
| --- | --- | --- | --- |
| ClikCode agent (Gateway, ClikCode Local) | its own loop, before the next model step | VERIFIED (real turns against a fake OpenAI server, pty) | A steer is in the turn at once; the model hears it at its next step, and a wait-type call returns early for it (`steerAlert`). A steer typed during a foreground sub-agent's call also goes to that sub-agent (it replies at its next step) (`turn-runtime.ts` `foregroundSteers`; `subagent.vitest.test.ts`). |
| Claude Code | ACP `_session/steering` (agent advertises `_meta.steering.supported`) | VERIFIED | Offered only while no call or approval is open: injected at once, it would cancel the call (seen live); otherwise it waits in the queue for the next opening. |
| Codex | app-server `turn/steer` | CLAIMED (protocol; tested against a fake app-server) | A refused steer (turn ended, compaction) queues. |
| Pi | `pi --mode rpc`, `steer` command: delivered after the running tool calls, before the next model call | VERIFIED against pi 0.87.0 with a local fake model server (a 6 s tool ran to its end, the next model request carried the message, the reply followed in the same run); ClikCode's one-shot turn over RPC ran once end to end (`clikcode send`). The steer wiring in the attempt is unit-tested, not driven against pi | Pi turns now run in RPC mode: images go inline (RPC refuses `@file`); stdin closes on `agent_settled` (15 s after `agent_end` for a pi that never sends it). |
| MiniMax Code (`mcode`) | ACP extension `mcode/session/steer` `{sessionId, text}` (listed in initialize `_meta['minimax-code/extensions'].methods`) | CLAIMED: read from mcode 0.5.10's source (refuses with an error when no prompt turn runs; its own TUI steers with Enter); not signed in here, so no real turn | Offered like Claude's only while no call is open (conservative: not known whether mcode's steer cuts a call). A refusal queues. |
| Amp | Native `--stream-json-input`, `steer: true` | VERIFIED 2026-10-25 with the real CLI and account (`scripts/verify-amp-steering.mjs`) | Offered only while no tool or subagent runs. Amp's echoed user message acknowledges delivery. stdin closes after the main reply and background follow-up; the final `result` follows EOF. No cancel/restart. |
| Junie | advertises `_meta.steering.supported` but does not answer `_session/steering` (idle it answers `startedNewTurn`) | VERIFIED unusable on 26.9.22 (re-seen: same version, nothing newer) | Catalog `acp.steering: false`. Queues, row says so. |
| Grok, Gemini, OpenCode, Copilot, Goose, Droid, Qwen, Cline, Kilo, Cursor, Hermes, Command, Kimi, Auggie, Vibe, OpenHands, Devin | none: `initialize` lists no steering, queue or extension method (probed 2026-10-14) | VERIFIED absent from `initialize`; a mid-turn `session/prompt` is not a steer (ACP has none) | Queues; row says so. |
| Kiro, Deep Agents Code (`dcode`) | unknown: `initialize` is not answered without a sign-in (dcode: "No credentials configured") | unknown | Queues; row says so. |
| Antigravity | none found: `--input-format stream-json` runs one turn per stdin line, it does not take a line into a running one | read from `agy --help` only | Queues. |
| OpenClaw | none found in `--help` (`agent --local` is one-shot) | read only | Queues. |
| Aider, Continue (`cn`) | none: text CLIs, one-shot | read only | Queues. |

Where nothing could be probed for real (no sign-in), the table says CLAIMED or unknown rather than inventing vendor behaviour.
