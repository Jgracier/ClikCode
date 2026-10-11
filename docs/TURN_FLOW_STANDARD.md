# The turn-flow standard

One order, one set of states, one set of animations, for every harness, in the
CLI and in the VS Code extension. A harness adapter's job is to produce these
events; a surface's job is to draw them. Neither gets to improvise.

This is the contract the renderer, the journal and the adapters are held to.
Where the code and this file disagree, the code is the bug.

## 1. Identity and order

1. Every row of a turn (a thought, a block of answer text, a tool call, an
   explore group, a sub-agent, a plan, a notice, a steer, an approval) has a
   stable `id`.
2. Every row has an **emission sequence** `seq`, assigned **once**, by the
   worker, when ClikCode first sees the row. It strictly increases within a
   turn. Clients never assign it and never renumber it.
3. A row's position is `(responseOffset, seq)`. `responseOffset` is the length
   of the answer text emitted when the row began. Ties go to `seq`.
4. **Completion order never decides position.** Parallel calls keep the order
   they started in, whichever finishes first. A row does not move once placed,
   except by merging into an earlier row with the same id.
5. A steer's `seq` is the moment it was acknowledged. Rows that began before
   it sort before it; rows that began after sort after it.
6. When the answer text is `replace`d, every row that began after the replaced
   prefix is rebased by the same remap the journal uses -- live rows and
   journaled rows alike, so a late joiner and a reopened chat agree.

## 2. States

`pending` (start frame, name only) -> `running` (arguments known) -> `done` |
`error` | `stopped`.

- Frames merge by `id`. A later frame fills fields; it never reopens a
  finished row. `error` and `stopped` are sticky: a late `done` does not
  overwrite them.
- A frame with no id merges into the single open call of the same label, else
  is its own row. It is never dropped.
- A call still open when the turn ends is closed `stopped`, and says so on
  replay.

## 3. Answer text

Append-only per answer. Blocks settle structurally (a closed block can no
longer change). A table or an open code fence is not drawn wider than it will
end up: a block whose layout depends on later rows is held in the live region
until it closes. Streaming text is never re-wrapped above rows already placed.

## 4. Thinking

A row like any other. Live: one dim row under the status line, newest words.
Settled: `Thought for Ns` (plus the model's own `**heading**` when it wrote
one) at its place in order. **The settled row is durable**: it is in the
journal and appears on reopen exactly where it appeared live. Reasoning text
itself is capped; the heading and the duration are not optional.

## 5. Sub-agents

- One parent row (`agent: true`). Its children carry `parentId`.
- Children are nested under the parent, in the order they began among
  siblings, and **never above text that was emitted before them**.
- Every concurrent child has its own live slot. One child finishing never
  clears another's.
- "N tool uses" counts **unique child call ids**, never frames.
- Settled: the parent keeps `(N tool uses · tokens · duration)` as the harness
  reported them, else as counted; the children stay available on replay.
- A harness with no child activity is declared so in the catalog; the parent
  row is then the whole story and says nothing about children.

## 6. Explore runs

Adjacent read/search/list calls merge into one group row, in start order.
Membership is decided on the first frame that carries the category; a start
frame that cannot classify yet does not freeze the group.

## 7. Plan

One plan row per turn, updated in place, drawn at the offset it first
appeared. Finishing every step does not delete it. It is in the journal and on
reopen. A sub-agent's plan is not the turn's plan.

## 8. Approvals and questions

A pending approval or question is always visible: if the terminal is too short
for the whole block, the block degrades (fewer option rows), it is never
omitted while the status still says "waiting for you". A decision leaves a
settled row (`approved`, `denied`, `answered`) at its place in order.

## 9. Status and animation

One status line per turn, by priority: waiting for you > the open call's verb
> the reasoning heading > `writing` > `thinking`.

- `writing` holds for as long as answer text is arriving in this response and
  no call has started; it does not fall back to `thinking` on a pause.
- One spinner per running thing. A call that has its own spinning row does
  not also spin in the status line.
- Glyph cadence is at most 120 ms per step (Claude Code steps at 50-100 ms,
  Codex similarly); the label shimmer advances one cell per step. Reduced
  motion shows a static glyph. Nothing animates when nothing is happening
  (blocked on the user, bridge reconnecting, idle).
- Token meter: `↓ N tokens` in the status line while the turn runs, from the
  vendor's reported usage where it reports it, else response length / 4.
  Shown after 16 s or as soon as it is non-zero, as Claude Code does.
- Every running row spins, in every surface: calls, explore groups, agents and
  the plan's active step.

## 10. End of turn

One summary line, the same live and replayed: `Worked for 1m 2s · 2 files
changed`, `Stopped after 3s`, or `Waiting for N background agents`. Per-turn
usage (tokens, cost, context) is shown by every surface, not only the
extension.

## 11. Replay parity

Anything drawn live is drawn on reopen, in the same order: thought rows, the
plan, notices, steers, approvals' outcomes, the summary. The only things that
may differ are things that are about *now*: the spinner, the clock, a pending
approval.

## 12. What an adapter owes

For every tool call the vendor makes with an id: a start frame, any number of
progress frames, and exactly one `done` or `error` frame. `parentId` for a
sub-agent's calls. `agent: true` for the call that spawns one. Thinking
whenever the vendor exposes it. Plan updates whenever the vendor emits them.
Usage whenever the vendor reports it. A vendor that cannot supply one of these
is marked in the harness catalog (`src/harness/catalog`), and the surfaces
degrade to nothing -- never to a wrong row, never to a guessed one.
