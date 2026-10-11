# TUI display suite

The real TUI in a pty against a fake vendor (`fake-grok.mjs`), the
emulated screen snapshotted after every chunk, then asserted. Isolation is
load-bearing: each scenario has its own HOME, CLIKCODE_HOME and a PATH of the
fake bin + node + `/usr/bin` + `/bin` (never `/usr/local/bin`, where a real
`cursor-agent` lives). No real vendor turn is ever made (see AGENTS.md).

```
node scripts/build.mjs
systemd-run --user --scope -q -p MemoryMax=4G timeout 300 \
  uv run --quiet --with pyte scripts/tui-e2e/run.py --only NAME --keep
```

One scenario at a time with `--only`; never the whole suite at once.
`--expect-fail` lists the scenarios that are expected to fail on this branch
(and the stream that makes each pass) and exits.

## What every scenario is held to

* `watch` phrases never vanish once shown and are on screen once at the end;
* **no non-trivial transcript row (>= 12 visible characters, not a
  spinner/status/closing row) is on screen twice** -- on the final screen, and
  on any complete (synchronized-update) frame. The failure names the row and
  the frame. `dup_ok: [substrings]` lists rows a scenario repeats on purpose;
  the fake's own stub call (`git log -1 --oneline` between blocks) is allowed
  once per block gap. `no_dup_check: 'reason'` turns it off;
* order/state checks over complete frames: `always_order`, `ever_together`,
  `never_after`, `status_always`, `table_aligned`, `final_rows_match`.

## The fake vendor's script mode

A turn may be `{ emits: [...] }` (plus `blocks`, played after): `text`,
`thought` (heading + body), `sleep`, `tool-start`/`tool-end` (ids, parent),
`tool`, `agent-start`/`agent-end`, `child-start`/`child-end`, `permission`
(answer lands in `{answers}` of a later block), `usage`, `plan`. See the
header comment in `fake-grok.mjs`.

## Acceptance scenarios and who makes them pass

`expect_fail: '<stream>'` marks a scenario that fails on this branch on
purpose. The runner prints `XFAIL` for it (not a failure) and `XPASS` once it
passes -- exit status 1, so the mark is removed in the commit that fixes it.
Streams are the lead's names; the mapping below is the suite author's reading
of docs/TURN_FLOW_STANDARD.md and may be re-assigned by editing one line.

| scenario | on this branch | stream that fixes it | section | fails because |
|---|---|---|---|---|
| `send-queued-now` | passes (was FAIL: S1) | this stream (src fix) | 1.5 | a steer mid-block truncated the block and the saved turn drew it twice |
| `steer-order` | passes | this stream (order of rows is already right) | 1.5 | -- (failed only through the same S1 duplicate) |
| `mid-turn-resize-while-streaming` | passes | -- (regression guard) | 3 | -- |
| `parallel-order` | XFAIL | order | 1.4 | settled rows follow completion order (`echo Y` above `sleep 2`) |
| `child-order` | XFAIL | order (+ core for child slots) | 1.3, 5 | the agent row is drawn after text begun under it; one child slot per parent |
| `table-stream` | XFAIL | order (transcript retire) | 3 | rows retired at the width of the rows so far |
| `thought-after-text` | XFAIL | core (durable thought rows) | 4 | `Thought for Ns` has no heading |
| `approval-denied-row` | XFAIL | core | 8 | a declined approval leaves a failed call row, no `denied` outcome |
| `status-writing` | XFAIL | motion | 9 | `thinking` returns after a pause mid-answer |

## Baseline at the base commit (08de2733), with the duplicate check on

110 pre-existing scenarios, each run alone under `MemoryMax=4G`; the tail of
the list was run twice (two runners overlapped) and agreed every time.
101 pass, 9 fail. Regressions are attributable against this list.

| scenario | at base | why |
|---|---|---|
| `send-queued-now` | FAIL | S1: `› then do this` and `Step two of the long job.` on screen twice (fixed on this branch) |
| `steer-at-next-pause` | FAIL | S1, same cause: `› also run the linter` twice; the old checks counted only `Steered in:` and passed (fixed on this branch) |
| `generic-json-two-blocks` | FAIL | stale: command-code now starts `acp`, which the fake does not speak (`Error: command ACP exited 0`) |
| `wait-for-reset` | FAIL | never shows `Wait for reset (` -- pre-existing, not investigated |
| `esc-on-resume-in-gives-message-back` | FAIL | same (`Wait for reset (` never shown) |
| `new-message-stops-reset-wait-line-first` | FAIL | same; also `· Second answer arrives here.` is on screen twice at the end |
| `settings-default-saves-shown-value` | FAIL | never shows `Make default for every harness` -- pre-existing, not investigated |
| `settings-inline-row-steady` | FAIL | `enter next` hint missing -- pre-existing, not investigated |
| `failover-switch-is-said-and-kept` | FAIL | `Switched to ` / `is out of usage` never shown -- pre-existing, not investigated |

The seven non-S1 failures fail identically on this branch (they are not
caused by the S1 change). The other 101 are unchanged.
