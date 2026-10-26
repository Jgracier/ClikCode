/** A turn's tool calls, thoughts and decisions as rows. */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { activityOutcome, commandOutputPreview, diffPreview, diffTotals, DIFF_PREVIEW_LINES, LIVE_OUTPUT_LINES, liveWaitKind, outputPreview, previewLinesFor, toolUses } from '../../../../src/harness/protocol/activity-view';
import { activityResult, decisionRow, exploreRuns, exploreSummary, reasoningBody, reasoningHeading, tensedLabel, thoughtRow } from '../../../../src/harness/protocol/turn-flow';
import { LOOK } from './look';
import { useNow } from './clock';
import { formatElapsed } from '../../../../src/harness/protocol/format';
import { liveChildren, type Activity, type DecisionEntry, type LiveChild, type ThoughtEntry } from '../model';
import type { FileDiff } from '../protocol';
import { post } from './bus';
import { SubagentBody, SubagentPanel } from './subagent-panel';
import { pathIn, relative } from './format';
import { Icon, Spinner } from './ui';
import { activityMore, decisionBadge, foldedSummary, runGroupSummary, runGroupView, runItemKey, runItemStandsAlone, type RunItem } from './flow';

/** The mark at a row's start: the terminal's own glyphs (look.ts), one for every
 * tool whatever its category and whichever harness made it. A running row
 * spins (the callers draw a Spinner); a failure keeps the glyph in red, a
 * stopped call is the stop mark in yellow. */
export function ActivityGlyph({ status }: { status: 'done' | 'error' | 'stopped' }): JSX.Element {
  return <span class="tool-glyph" aria-hidden="true">{status === 'stopped' ? LOOK.glyph.stopped : LOOK.glyph.tool}</span>;
}

/** The glyph's colour role: the same blue for every tool, red for a failure,
 * yellow once stopped. */
export function toneOf(status: 'running' | 'done' | 'error' | 'stopped'): string {
  return status === 'error' ? 'tone-failed' : status === 'stopped' ? 'tone-stopped' : status === 'running' ? 'tone-accent' : 'tone-tool';
}


/** A tool label with the path in it made a link to the file. */
export function ActivityLabel({ label, workspace }: { label: string; workspace?: string }): JSX.Element {
  const found = pathIn(label);
  if (!found) return <span class="activity-text" title={label}>{relative(label, workspace)}</span>;
  const before = relative(label.slice(0, found.index), workspace);
  const written = found.path + (found.line ? `:${found.line}` : '');
  const after = relative(label.slice(found.index + written.length), workspace);
  // Shown relative to the workspace, opened by the path the tool used.
  const shown = relative(found.path, workspace) + (found.line ? `:${found.line}` : '');
  return (
    <span class="activity-text" title={label}>
      {before}
      <a href="#" class="file-link" data-file={found.path} data-line={found.line} title={`Open ${found.path}`}>{shown}</a>
      {after}
    </span>
  );
}

/** An edit as the terminal shows it: per file (named when there are
 * several), hunks with line numbers where they are real, removed and added
 * on tinted rows, context dim, ⋮ between hunks. `budget` lines across at
 * most four files, the rest counted (activity-view.ts); none: all of it. */
export function DiffView({ files, budget }: { files: readonly FileDiff[]; budget?: number }): JSX.Element {
  const preview = diffPreview(files, budget ?? Number.MAX_SAFE_INTEGER);
  const shown = budget === undefined ? files.map((file) => ({ file, lines: file.lines })) : preview.files;
  const width = preview.gutter;
  const notes = budget === undefined ? [] : [
    ...(preview.hiddenLines > 0 ? [`${preview.hiddenLines} more line${preview.hiddenLines === 1 ? '' : 's'}`] : []),
    ...(preview.moreFiles > 0 ? [`${preview.moreFiles} more file${preview.moreFiles === 1 ? '' : 's'}`] : []),
  ];
  return (
    <div class="activity-output diff" role="group" aria-label="Change">
      {shown.map(({ file, lines }, fileIndex) => (
        <div key={`f${fileIndex}`}>
          {files.length > 1 ? (
            <div class="file">{file.path ?? 'file'}{file.change === 'add' ? ' (new)' : file.change === 'delete' ? ' (deleted)' : ''} <Counts additions={file.additions} removals={file.removals} /></div>
          ) : null}
          {lines.map((line, index) => {
            const number = width ? String(line.line ?? '').padStart(width) : '';
            if (line.kind === 'gap') return <div key={index} class="gap"><span class="num">{''.padStart(width)}</span>⋮</div>;
            const mark = line.kind === 'removed' ? '-' : line.kind === 'added' ? '+' : ' ';
            return <div key={index} class={line.kind === 'removed' ? 'del' : line.kind === 'added' ? 'add' : 'same'}><span class="num">{number}</span><span class="mark">{mark}</span>{line.text}</div>;
          })}
          {budget === undefined && file.omitted ? <div class="gap">… {file.omitted} more line{file.omitted === 1 ? '' : 's'}</div> : null}
        </div>
      ))}
      {notes.length ? <div class="gap">… {notes.join(', ')}</div> : null}
    </div>
  );
}

export function Counts({ additions, removals }: { additions: number; removals: number }): JSX.Element {
  return <>{additions ? <span class="add">+{additions}</span> : null}{additions && removals ? ' ' : ''}{removals ? <span class="del">-{removals}</span> : null}</>;
}

/** A tool's output as the terminal budgets it: a command's last lines, the
 * earlier ones counted above; anything else its first, the rest below. */
export function OutputView({ activity, budget }: { activity: Activity; budget: number }): JSX.Element | null {
  const { lines, hidden, fromEnd } = outputPreview(activity, budget);
  if (!lines.length) return null;
  const note = hidden > 0 ? <div class="gap">… {hidden} {fromEnd ? 'earlier' : 'more'} line{hidden === 1 ? '' : 's'}</div> : null;
  if (activity.label === 'Hand browser to user') {
    const url = lines.join('\n').match(/https:\/\/[^\s]+\/computer\/handoff\/[A-Za-z0-9_-]{32}#key=[A-Za-z0-9_-]{43}/)?.[0];
    if (url) return <div class="activity-output"><span>Open on your phone: </span><a href={url} data-href={url}>handoff link</a>{' '}
      <button type="button" onClick={() => void navigator.clipboard.writeText(url)}>Copy link</button></div>;
  }
  return <pre class="activity-output">{fromEnd ? note : null}{lines.join('\n')}{fromEnd ? null : note}</pre>;
}

/** A finished command's output: its first lines and its last, the middle
 * counted (commandOutputPreview, the terminal's rule). */
export function CommandOutput({ ends }: { ends: NonNullable<ReturnType<typeof commandOutputPreview>> }): JSX.Element {
  return (
    <pre class="activity-output">
      {ends.head.join('\n')}
      {ends.hidden ? <div class="gap">… {ends.hidden} line{ends.hidden === 1 ? '' : 's'} hidden</div> : null}
      {ends.tail.join('\n')}
    </pre>
  );
}

/** Which rows are open, kept across the live turn becoming its trace and
 * across a redraw: a row is its call (key) at the moment it was first seen. */
export const openRows = new Set<string>();
export const rowId = (activity: Activity): string => `${activity.key}@${activity.startedAt ?? ''}`;

/** The seconds a running call has taken, ticking on its own so the rest of
 * the turn is not redrawn every second. */
export function Clock({ since }: { since: number }): JSX.Element | null {
  const now = useNow();
  return now - since >= 1000 ? <span class="activity-outcome">{formatElapsed(now - since)}</span> : null;
}

/** One running child of a sub-agent, on its own line under the agent's row
 * (still: the agent's row is the one animation); the newest carries the
 * parent's count (as the terminal's row does). Live while the agent runs,
 * since running rows are drawn in the live flow. */
export function ChildLine({ live }: { live: LiveChild }): JSX.Element {
  const uses = live.newest ? live.parent.childTools : undefined;
  return (
    <div class="activity-child" title={live.child.label}>
      <ActivityGlyph status="done" /><span>{tensedLabel(live.child.label, true)}</span>{uses ? <span class="muted">{toolUses(uses)}</span> : null}
    </div>
  );
}

/** The elapsed time in a slot that is always there and always as wide, so the line does not shift as it ticks. */
function AgentClock({ since }: { since: number }): JSX.Element {
  const now = useNow();
  return <span class="activity-outcome agent-clock">{now - since >= 1000 ? formatElapsed(now - since) : ''}</span>;
}

/** A running subagent as one line, the terminal's: its spinner, its name, how long it has run and
 * how many tools it has used, and under it the call it is running right now. That slot is always
 * one line tall and its text swaps in place, so the line never hops as the agent moves between
 * calls. The chevron opens what it did and a field to message it. */
export function AgentLine({ activity, workspace }: { activity: Activity; workspace?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const now = liveChildren(activity, 1)[0]?.child.label ?? activity.child;
  const uses = activity.childTools;
  return (
    <div class="agent-line">
      <div class="activity-line">
        <span class="activity-status tone-accent" aria-label="running"><Spinner tone="tone-accent" agent /></span>
        <ActivityLabel label={tensedLabel(activity.label, true)} workspace={workspace} />
        {activity.startedAt ? <AgentClock since={activity.startedAt} /> : null}
        {uses ? <span class="activity-outcome">{toolUses(uses)}</span> : null}
        {activity.id ? <button type="button" class="icon-button tiny agent-toggle" aria-expanded={open} aria-label={open ? 'Hide subagent' : `View ${activity.label}`} onClick={() => setOpen(!open)}><Icon name={open ? 'chevron-up' : 'chevron-down'} /></button> : null}
      </div>
      <div class="activity-child agent-child" title={now}>{now ? <><ActivityGlyph status="done" /><span>{tensedLabel(now, true)}</span></> : null}</div>
      {open && activity.id ? <SubagentBody parentId={activity.id} agentId={activity.agentId} label={activity.label} running onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

export function ActivityRow({ activity, workspace, userIndex }: { activity: Activity; workspace?: string; userIndex?: number }): JSX.Element {
  const id = rowId(activity);
  const [open, setOpenState] = useState(openRows.has(id));
  const setOpen = (value: boolean): void => { if (value) openRows.add(id); else openRows.delete(id); setOpenState(value); };
  const status = activity.kind === 'tool-start' ? 'running' : activity.stopped ? 'stopped' : activity.kind === 'tool-error' ? 'error' : 'done';
  // What the terminal shows under a settled call: an edit's change, a
  // command's or search's last lines, a fetch's first -- a read's row says
  // all of it. The rest is one click away.
  // A command's whole output: its first lines and its last (Codex).
  const budget = previewLinesFor(activity.category);
  const ends = activity.category === 'run' && status !== 'running' ? commandOutputPreview(activity) : undefined;
  const preview = !ends && activity.output?.length && budget > 0 ? outputPreview(activity, budget) : undefined;
  const more = activityMore(activity);
  const hasMore = Boolean(more.task || more.command || more.args.length || (activity.output?.length && (ends ? ends.hidden > 0 : !preview || preview.hidden > 0))
    || (activity.diff && diffPreview(activity.diff, DIFF_PREVIEW_LINES).hiddenLines) || activity.children?.length);
  // Its own live children directly under it (those that began after more
  // text was written are drawn lower, by the turn: turnMarks).
  const beside = status === 'running' ? liveChildren(activity).filter((entry) => entry.beside) : [];
  // What it found ("42 lines"), then the exceptions (a failure, a long run).
  const result = activityResult(activity);
  const outcome = activityOutcome(activity);
  const totals = activity.diff?.length ? diffTotals(activity.diff) : undefined;
  const agentRunning = status === 'running' && (Boolean(activity.agent)
    || liveWaitKind({ kind: 'tool-start', label: activity.label, agent: activity.agent, category: activity.category }) === 'agent');
  const change = (action: 'view' | 'revert') => (event: MouseEvent): void => {
    event.stopPropagation();
    post({ type: 'change', action, key: activity.key, ...(userIndex === undefined ? {} : { userIndex }) });
  };
  return (
    <div class={`activity ${status}`}>
      <div class="activity-line">
        {/* Every running row spins for itself on the page's one clock: dots for
            a call, a ring for a sub-agent. The row is the same one that turns
            done, so nothing moves. */}
        <span class={`activity-status ${toneOf(status)}`} aria-label={status}>
          {status === 'running' ? <Spinner tone="tone-accent" agent={agentRunning} /> : <ActivityGlyph status={status} />}
        </span>
        <ActivityLabel label={status === 'stopped' ? activity.label : tensedLabel(activity.label, status === 'running')} workspace={workspace} />
        {activity.agent && activity.id ? <SubagentPanel key={activity.id} parentId={activity.id} agentId={activity.agentId} label={activity.label} running={status === 'running'} /> : null}
        {status === 'stopped' ? <span class="activity-outcome stopped">stopped</span> : null}
        {status === 'error' ? <span class="activity-outcome failed-word">failed</span> : null}
        {activity.decision ? <span class={`activity-outcome activity-decision ${decisionBadge(activity.decision).tone}`}>{decisionBadge(activity.decision).text}</span> : null}
        {totals ? <span class="activity-counts"><Counts additions={totals.additions} removals={totals.removals} /></span> : null}
        {status === 'running' && activity.startedAt ? <Clock since={activity.startedAt} /> : null}
        {result ? <span class="activity-outcome activity-result">{result}</span> : null}
        {outcome ? <span class={`activity-outcome${outcome.failed ? ' failed' : ''}`}>{activity.children?.length || activity.childTools ? `(${outcome.parts.join(' · ')})` : outcome.parts.join(' · ')}</span> : null}
        {activity.diff?.length && status !== 'running' ? (
          <span class="activity-actions">
            <button type="button" class="icon-button tiny" title="Open in the diff editor" aria-label="Open in the diff editor" onClick={change('view')}><Icon name="diff" /></button>
            {status === 'done' ? <button type="button" class="icon-button tiny" title="Undo this change" aria-label="Undo this change" onClick={change('revert')}><Icon name="discard" /></button> : null}
          </span>
        ) : null}
        {hasMore ? (
          <button type="button" class="icon-button tiny" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen(!open)}>
            <Icon name={open ? 'chevron-up' : 'chevron-down'} />
          </button>
        ) : null}
      </div>
      {beside.map((entry) => <ChildLine key={entry.child.key} live={entry} />)}
      {/* A harness that sent no child calls, only what it is doing now. */}
      {status === 'running' && activity.child && !activity.children?.length ? <div class="activity-child" title={activity.child}><ActivityGlyph status="done" /><span>{activity.child}</span>{activity.childTools ? <span class="muted">{toolUses(activity.childTools)}</span> : null}</div> : null}
      {/* The children stay available once it settles, one click away. */}
      {open && activity.children?.length ? (
        <div class="activities nested">{activity.children.map((child) => <ActivityRow key={child.key} activity={child} workspace={workspace} userIndex={userIndex} />)}</div>
      ) : null}
      {open && (more.task || more.command || more.args.length) ? (
        <div class="activity-more muted">
          {more.task ? <div>{more.task}</div> : null}
          {more.command ? <div class="activity-command">{more.command}</div> : null}
          {more.args.map((arg) => <div key={arg}>{arg}</div>)}
        </div>
      ) : null}
      {/* A running call shows what it has printed so far, newest last -- a
          long build is visibly working instead of a bare timer. */}
      {status === 'running' && !open && activity.output?.length ? <OutputView activity={{ ...activity, outputTail: true }} budget={LIVE_OUTPUT_LINES} /> : null}
      {activity.diff?.length ? <DiffView files={activity.diff} budget={open ? undefined : status === 'running' ? 0 : DIFF_PREVIEW_LINES} /> : null}
      {!open && ends ? <CommandOutput ends={ends} /> : null}
      {status !== 'running' && !open && preview ? <OutputView activity={activity} budget={budget} /> : null}
      {open && activity.output?.length ? <OutputView activity={activity} budget={Number.MAX_SAFE_INTEGER} /> : null}
    </div>
  );
}

/** A run of calls and thoughts a turn made between two paragraphs, folded to
 * one line in its place -- "Ran 4 commands, read 3 files · 2 thoughts" -- as
 * Codex folds its work. Open, each item is its own row, and each opens in
 * turn (a call's output, a thought's text). A failed or stopped call stays a
 * row of its own under the line: errors do not hide. One item alone stays as
 * it was: its own label. */
export function FoldedRun({ items, workspace, userIndex }: { items: RunItem[]; workspace?: string; userIndex?: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const calls = items.flatMap((item) => (item.activity ? [item.activity] : []));
  const totals = diffTotals(calls.flatMap((activity) => activity.diff ?? []));
  const row = (item: RunItem): JSX.Element => (item.activity
    ? <ActivityRow key={runItemKey(item)} activity={item.activity} workspace={workspace} userIndex={userIndex} />
    : <ThoughtRow key={runItemKey(item)} thought={item.thought} />);
  const single = items.length === 1;
  const alone = !open && !single ? items.filter(runItemStandsAlone) : [];
  return (
    <div class="trace">
      <button type="button" class="trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span class="tone-tool tool-glyph" aria-hidden="true">{LOOK.glyph.tool}</span>
        <span class="group-summary">{single ? foldedSummary(calls) : runGroupSummary(items)}</span>
        {totals.additions || totals.removals ? <span class="activity-counts"><Counts additions={totals.additions} removals={totals.removals} /></span> : null}
      </button>
      {open ? <div class="activities">{items.map(row)}</div> : alone.length ? <div class="activities">{alone.map(row)}</div> : null}
    </div>
  );
}

/** Rows of one run, each run of looking-around calls merged into one
 * "Explored" row (exploreRuns), the rest a row each. */
export function RunGroups({ groups, workspace, userIndex }: { groups: ReadonlyArray<{ rows: Activity[]; explore: boolean }>; workspace?: string; userIndex?: number }): JSX.Element {
  return (
    <>
      {runGroupView(groups).map((group) => (group.kind === 'explored'
        ? <ExploredRow key={group.key} activities={group.rows} workspace={workspace} userIndex={userIndex} />
        : <ActivityRow key={group.key} activity={group.rows[0]!} workspace={workspace} userIndex={userIndex} />))}
    </>
  );
}

/** Calls shown, dimmed, under a closed "Explored" row: the newest. */
export const EXPLORED_RECENT = 3;

/** A run of reads and searches as one row, as Codex's "Explored" and
 * Cursor's merged reads: what it amounts to ("Read 3 files, searched 1
 * pattern"), its newest calls dimmed beneath; open, every call's own row. */
export function ExploredRow({ activities, workspace, userIndex }: { activities: Activity[]; workspace?: string; userIndex?: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const running = activities.some((activity) => activity.kind === 'tool-start');
  return (
    <div class={`explored${running ? ' running' : ''}`}>
      <button type="button" class="trace-toggle explored-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        {running ? <Spinner tone="tone-accent" /> : null}
        <span class="explored-title">{running ? 'Exploring' : 'Explored'}</span>
        <span class="muted explored-summary">{exploreSummary(activities)}</span>
      </button>
      {open ? <div class="activities">{activities.map((activity) => <ActivityRow key={activity.key} activity={activity} workspace={workspace} userIndex={userIndex} />)}</div> : (
        <div class="explored-recent">
          {activities.slice(-EXPLORED_RECENT).map((activity) => {
            const result = activityResult(activity);
            return (
              <div key={activity.key} class="explored-call">
                <span class={`activity-status ${toneOf(activity.kind === 'tool-start' ? 'running' : 'done')}`}>{activity.kind === 'tool-start' ? <Spinner tone="tone-accent" /> : <ActivityGlyph status="done" />}</span>
                <ActivityLabel label={activity.stopped ? activity.label : tensedLabel(activity.label, activity.kind === 'tool-start')} workspace={workspace} />
                {activity.stopped ? <span class="activity-outcome stopped">stopped</span> : null}
                {result ? <span class="activity-outcome activity-result">{result}</span> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A thought, where it happened: "Thought for 4s · heading", open to read it
 * when its words were kept (the worker caps them; the heading and the
 * duration are always there). The same words as the terminal's row. */
export function ThoughtRow({ thought }: { thought: ThoughtEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const row = thoughtRow({ durationMs: thought.ms, heading: thought.heading ?? reasoningHeading(thought.text) });
  const body = thought.text ? reasoningBody(thought.text) || thought.text : '';
  return (
    <div class="trace thought-row">
      {body ? (
        <button type="button" class="trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} /><span class="thought-glyph" aria-hidden="true">{LOOK.glyph.thought}</span><span class="thought-text">{row}</span>
        </button>
      ) : <div class="trace-toggle static"><span class="thought-glyph" aria-hidden="true">{LOOK.glyph.thought}</span><span class="thought-text">{row}</span></div>}
      {open && body ? <Reasoning text={body} /> : null}
    </div>
  );
}

/** What the user decided at an approval or question, where it was asked:
 * `✓ approved make clean`, `✗ denied …`, `↳ told: …` (standard 8). */
export function DecisionRow({ entry }: { entry: Pick<DecisionEntry, 'decision'> }): JSX.Element {
  const { text, tone } = decisionRow(entry.decision);
  return <div class={`decision-row decision-${tone}`} role="note"><span class="muted">{text}</span></div>;
}

export function Reasoning({ text }: { text: string }): JSX.Element {
  return <div class="reasoning" aria-label="Reasoning"><p>{text}</p></div>;
}
