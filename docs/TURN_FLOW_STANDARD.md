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
5. A steer's `seq` and `responseOffset` are the moment it was acknowledged.
   Rows that began before it sort before it; rows that began after sort after
   it. A steer that fell inside a block of answer text is drawn **after that
   block, whole** -- never through the middle of a sentence -- live, on replay
   and in the compat view older builds read.
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
one, `Thought for 3s · Planning the approach`) at its place in order. A
thought settles when answer text or a call begins; an id re-emitted after
that merges into the earlier row and keeps its place (it never takes the new
offset). **The settled row is durable**: it is in the journal and appears on
reopen exactly where it appeared live. Reasoning text itself is capped; the
heading and the duration are not optional. The shared function
(`thoughtRow` in `src/harness/protocol/turn-flow.ts`) returns the words only;
each surface draws its own glyph.

## 5. Sub-agents

- One parent row (`agent: true`). Its children carry `parentId`.
- Children are nested under the parent, in the order they began among
  siblings, and **never above text that was emitted before them**. A child
  that began after intervening text sits below that text, at its own offset.
- An open agent row holds the text after it like any call, **bounded**: past
  what the live region can show, the row is retired as a `· running` line
  (static glyph), the held text follows, one `✓ <label> (N tool uses ...)`
  row is appended where it settles, and live children sit under a `↳ <label>`
  line. A foreground agent normally never reaches the bound.
- Every concurrent child has its own live slot. One child finishing never
  clears another's.
- "N tool uses" counts **unique child call ids**, never frames.
- Settled: the parent keeps `(N tool uses · tokens · duration)` as the harness
  reported them, else as counted; the children stay available on replay.
- A harness with no child activity is declared so in the catalog; the parent
  row is then the whole story and says nothing about children.

## 6. Explore runs

Adjacent read/search/list calls (a listing is category `search`) merge into
one group row, in start order.
Membership is decided on the first frame that carries the category; a start
frame that cannot classify yet does not freeze the group.

## 7. Plan

One plan per turn, updated in place. While the turn runs it is a live band
(append-only scrollback cannot hold a row whose steps change); finishing every
step does not delete it: it is kept as a row at the offset it first appeared,
on reopen and for a window that joins mid-turn. It is in the journal. A
sub-agent's plan is not the turn's plan.

## 8. Approvals and questions

A pending approval or question is always visible: if the terminal is too short
for the whole block, the block degrades (fewer option rows), it is never
omitted while the status still says "waiting for you". A decision leaves a
settled outcome (`approved`, `denied`, `answered`, and `told`/`declined` where
the answering window knows them) at its place in order. **One event is one
row**: the decision carries the call id and settles that call's row; it
stands alone only when the vendor reports no call for it.

## 9. Status and animation

One status line per turn, by priority: waiting for you > the open call's verb
> the reasoning heading > `writing` > `thinking`.

- `writing` holds for as long as answer text is arriving in this response and
  no call has started; it does not fall back to `thinking` on a pause.
- The status line spins for the turn and each running row spins for itself
  (Claude Code draws both). They share ONE clock: every glyph in a frame is
  the same step, so nothing steps out of phase with its neighbour.
- Glyph cadence is at most 120 ms per step (Claude Code steps at 50-100 ms,
  Codex similarly); the label shimmer advances one cell per step. Reduced
  motion shows a static glyph. Nothing animates when nothing is happening
  (blocked on the user, bridge reconnecting, idle).
- Token meter: `↓ N tokens` in the status line while the turn runs, from the
  vendor's reported usage where it reports it, else response length / 4,
  smoothed (it steps up, never down within a turn). Shown once non-zero: a
  zero is unknown, not "0 tokens".
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
progress frames, and exactly one `done` or `error` frame (a late terminal frame may only fill
fields, e.g. an edit's diff arriving after its `done`). `parentId` for a
sub-agent's calls. `agent: true` for the call that spawns one. Thinking
whenever the vendor exposes it. Plan updates whenever the vendor emits them.
Usage whenever the vendor reports it. A vendor that cannot supply one of these
is marked in the harness catalog (`src/harness/catalog`), and the surfaces
degrade to nothing -- never to a wrong row, never to a guessed one.
