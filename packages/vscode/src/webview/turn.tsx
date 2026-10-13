/** A turn as it reads, live or finished: its flow, plan, notes and working line. */
import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useRef, useState } from 'preact/hooks';
import { exploreRuns } from '../../../../src/harness/protocol/turn-flow';
import { useNow, useSpinFrame } from './clock';
import type { TurnUsage } from '../../../../src/harness/protocol/turn-usage';
import { turnStalled } from '../../../../src/harness/protocol/turn-pace';
import { planWindow } from '../../../../src/tui/render/plan-window';
import { liveElapsedMs, turnMarks, type Activity, type ChatModel, type DecisionEntry, type LiveTurn, type Note, type PlanAt, type ThoughtEntry, type TurnTrace } from '../model';
import { post } from './bus';
import { renderMarkdown } from './markdown';
import { Icon, Spinner } from './ui';
import { foldedGroupCount, liveMeter, shimmerStyle, traceSummaryLine, workingDetail, workingIndicator, workingStatus } from './flow';
import { CopyAnswer, LiveMarkdown, renderFinished } from './messages';
import { ChildLine, DecisionRow, FoldedRun, Reasoning, RunGroups, ThoughtRow } from './activity-rows';

/** How a turn reads, live or finished, in the order it happened -- as
 * Claude Code and Codex lay a turn out: each paragraph of the answer, and
 * between them the calls, thoughts and messages sent into the turn at the
 * point they came. Live, calls show as rows and the last paragraph streams;
 * finished, each run of calls folds to one line in its place, so nothing
 * moves when the turn ends. */
export function TurnFlow(props: {
  text: string; activities: readonly Activity[]; thoughts: readonly ThoughtEntry[]; steers: ReadonlyArray<{ text: string; offset: number; seq?: number }>;
  workspace?: string; live?: { startedAt: number }; cacheKey?: string; userIndex?: number;
  /** The turn's one plan, drawn once at the offset it first appeared. */
  plan?: { entries: ChatModel['plan']; at: PlanAt };
  /** Notices that arrived during the turn, each where it did. */
  notes?: ReadonlyArray<Note>;
  /** What the user decided at the turn's approvals, each where it was asked. */
  decisions?: ReadonlyArray<DecisionEntry>;
}): JSX.Element {
  const { text } = props;
  const marks = turnMarks(text, props.activities, props.thoughts, props.steers, {
    ...(props.plan?.entries.length ? { plan: props.plan.at } : {}),
    ...(props.notes?.length ? { notes: props.notes.map((note, index) => ({ offset: note.offset ?? 0, seq: note.seq ?? index, note })) } : {}),
    ...(props.decisions?.length ? { decisions: props.decisions } : {}),
  });
  const parts: JSX.Element[] = [];
  let at = 0;
  let run: Activity[] = [];
  const flushRun = (): void => {
    if (!run.length) return;
    parts.push(props.live
      ? <ActivityRun key={`r${run[0]!.key}`} activities={run} workspace={props.workspace} />
      : <FoldedRun key={`r${run[0]!.key}`} activities={run} workspace={props.workspace} userIndex={props.userIndex} />);
    run = [];
  };
  const paragraph = (end: number): void => {
    const piece = text.slice(at, end);
    if (!piece.trim()) return;
    flushRun();
    // Live, every block of text is the same kind of node under the same key
    // as it grows and as a call starts after it: its DOM survives.
    if (props.live) parts.push(<LiveMarkdown key={`t${at}`} text={piece} />);
    else {
      const html = props.cacheKey ? renderFinished(`${props.cacheKey}@${at}`, piece) : renderMarkdown(piece);
      parts.push(<div key={`t${at}`} class="markdown" dangerouslySetInnerHTML={{ __html: html }} />);
    }
    at = end;
  };
  for (const mark of marks) {
    if (mark.offset > at) paragraph(mark.offset);
    if (mark.activity) { run.push(mark.activity); continue; }
    flushRun();
    if (mark.thought) parts.push(<ThoughtRow key={`h${mark.thought.seq}`} thought={mark.thought} />);
    else if (mark.plan && props.plan) parts.push(<Plan key="plan" plan={props.plan.entries} folded={!props.live} running={Boolean(props.live)} />);
    else if (mark.note) parts.push(<NoteView key={`n${mark.seq}`} note={mark.note} />);
    else if (mark.child) parts.push(<div key={`c${mark.child.child.key}`} class="activities"><ChildLine live={mark.child} /></div>);
    else if (mark.decision) parts.push(<DecisionRow key={`d${mark.decision.id}`} entry={mark.decision} />);
    else parts.push(<div key={`s${mark.steerIndex}`} class="steer"><Icon name="arrow-small-right" /><span>{mark.steer}</span><span class="muted">sent into this turn</span></div>);
  }
  flushRun();
  if (props.live) {
    if (text.slice(at).trim()) parts.push(<LiveMarkdown key={`t${at}`} text={text.slice(at)} />);
  } else paragraph(text.length);
  return <>{parts}</>;
}

/** The quiet line a finished turn ends on (Codex's "Worked for 1m 2s",
 * Cursor's files edited), and, when it changed files, all of them to review
 * at once or undo together. */
export function TurnSummary({ trace }: { trace: TurnTrace }): JSX.Element | null {
  const diffs = trace.activities.flatMap((activity) => (activity.kind === 'tool-done' && activity.diff?.length ? [activity.diff] : []));
  const changed = diffs.some((diff) => diff.some((file) => file.path));
  const line = traceSummaryLine(trace, diffs);
  if (line === undefined) return null;
  const act = (action: 'view' | 'revert') => (): void => post({ type: 'turnChanges', action, userIndex: trace.userIndex });
  return (
    <div class="turn-summary">
      <span class="muted">{line}</span>
      {changed ? (
        <>
          <button type="button" class="link small" data-turn-changes="view" title="Open every change this turn made in the diff editor" onClick={act('view')}><Icon name="diff-multiple" />Review changes</button>
          <button type="button" class="link small" data-turn-changes="revert" title="Undo every change this turn made" onClick={act('revert')}><Icon name="discard" />Undo all</button>
        </>
      ) : null}
    </div>
  );
}

/** A finished answer with how it was reached, in the order it happened.
 * Rows and thoughts land where they came in the answer as it streamed; one
 * whose place the saved answer no longer reads the same up to goes first. */
export const FinishedTurn = memo(({ text, trace, cacheKey, workspace, notes }: { text: string; trace: TurnTrace; cacheKey: string; workspace?: string; notes?: Note[] }): JSX.Element => {
  const place = <T extends { offset?: number }>(item: T): T => {
    const offset = item.offset ?? 0;
    return offset <= text.length && text.slice(0, offset) === trace.text.slice(0, offset) ? item : { ...item, offset: 0 };
  };
  return (
    <div class="message assistant" role="article" aria-label="ClikCode">
      <TurnFlow text={text} activities={trace.activities.map(place)} thoughts={(trace.reasoning ?? []).map(place)} steers={(trace.steers ?? []).map(place)}
        {...(trace.plan ? { plan: { entries: trace.plan, at: place(trace.planAt ?? { offset: 0, seq: 0 }) } } : {})}
        {...(notes?.length ? { notes: notes.map(place) } : {})}
        {...(trace.decisions?.length ? { decisions: trace.decisions.map(place) } : {})}
        workspace={workspace} cacheKey={cacheKey} userIndex={trace.userIndex} />
      <TurnSummary trace={trace} />
      <div class="message-actions"><CopyAnswer text={text} /></div>
    </div>
  );
});

export const NoteView = memo(({ note }: { note: Note }): JSX.Element => {
  const [open, setOpen] = useState(note.text.split('\n').length <= 14);
  if (note.kind === 'panel') {
    return (
      <div class="panel-card">
        <button type="button" class="panel-title" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} /><span>{note.title}</span>
        </button>
        {open ? <pre class="panel-body">{note.text}</pre> : null}
      </div>
    );
  }
  const icon = note.level === 'error' ? 'error' : note.level === 'warning' ? 'warning' : 'info';
  return <div class={`notice ${note.level ?? 'info'}`} role={note.level === 'error' ? 'alert' : undefined}><Icon name={icon} /><span>{note.text}</span></div>;
});

/** The plan, windowed around the step in progress as the terminal shows it;
 * the rest one click away. */
export function Plan({ plan, folded = false, running = false }: { plan: ChatModel['plan']; folded?: boolean; running?: boolean }): JSX.Element {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(!folded);
  if (!open) {
    const done = plan.filter((entry) => entry.status === 'completed').length;
    return (
      <div class="trace">
        <button type="button" class="trace-toggle" aria-expanded={false} onClick={() => { setOpen(true); setAll(true); }}>
          <Icon name="chevron-right" /><span>Plan · {done}/{plan.length} done</span>
        </button>
      </div>
    );
  }
  const { visible, done, hidden } = planWindow(plan);
  const rows = all ? plan.map((entry, index) => ({ entry, index })) : visible;
  return (
    <div class="plan-card" aria-label="Plan">
      <div class="plan-head"><Icon name="checklist" /><span>Plan</span><span class="muted">{done}/{plan.length}</span></div>
      {rows.map(({ entry, index }) => (
        <div key={index} class={`plan-entry ${entry.status ?? ''}`}>
          {/* The step in progress spins while its turn runs, on the shared
              clock; settled, it is a still mark. */}
          {entry.status === 'in_progress' && running
            ? <Spinner tone="tone-blue" />
            : <Icon name={entry.status === 'completed' ? 'pass-filled' : entry.status === 'cancelled' ? 'circle-slash' : entry.status === 'in_progress' ? 'circle-large-filled' : 'circle-large'} />}
          <span>{entry.content}</span>
        </div>
      ))}
      {hidden && !all ? <button type="button" class="more-steps" onClick={() => setAll(true)}><Icon name="ellipsis" /> {done}/{plan.length} done · {hidden} more</button> : null}
      {all && hidden ? <button type="button" class="more-steps" onClick={() => setAll(false)}><Icon name="fold-up" /> Show fewer</button> : null}
    </div>
  );
}

/** Rows of one run of calls shown before the earlier ones fold away. */
export const VISIBLE_ACTIVITIES = 6;

/** The working line: what the turn is doing (turn-flow's rule: waiting on you,
 * the open call's verb, the reasoning's own heading, or how long it has
 * thought), in the colour of that work, a shimmer passing over it (CSS). A
 * running sub-agent keeps its own spinner on its chat row.
 * The thought being had is this line's tooltip, and opens under it. Ticks
 * on its own. */
/** The working line's clock and token meter. The count steps on the page's
 * spinner clock, as the terminal's does on its tick, and never falls within a
 * turn (liveMeter); the clock beside it reads once a second. */
export function WorkingDetail({ live, usage }: { live: LiveTurn; usage?: TurnUsage }): JSX.Element {
  const now = useNow();
  useSpinFrame();
  const shown = useRef({ turn: live.startedAt, tokens: 0 });
  // A new turn starts its count again.
  if (shown.current.turn !== live.startedAt) shown.current = { turn: live.startedAt, tokens: 0 };
  const thoughtChars = (live.thought?.text.length ?? 0) + (live.reasoning ?? []).reduce((sum, item) => sum + (item.text?.length ?? 0), 0);
  const meter = liveMeter({ shown: shown.current.tokens, usage, responseChars: live.text.length, thoughtChars });
  shown.current.tokens = meter.tokens;
  return <span class="muted" aria-hidden="true">{workingDetail(liveElapsedMs(live, now), meter.label)}</span>;
}

export function Working({ live, asking, usage, reconnecting: away = false }: { live: LiveTurn | undefined; asking: boolean; usage?: TurnUsage; reconnecting?: boolean }): JSX.Element {
  const now = useNow(!away);
  const [open, setOpen] = useState(false);
  const status = workingStatus(live, asking, now, away);
  // Not working: waiting on the user, or the bridge coming back. A still
  // mark, no shimmer, no clock.
  const held = asking || away;
  const thought = asking ? undefined : live?.thought?.text;
  return (
    <div class="working-wrap">
      <div class={`working status-${status.tone}`} role="status">
        {/* Waiting on the user is not working: a still dot, as the terminal
            shows it, and no clock -- it is stopped. */}
        {held ? <span class={`spinner ${status.toneClass}`} aria-hidden="true">●</span>
          : <Spinner tone={live && turnStalled(now - live.activeAt) ? 'tone-yellow' : status.toneClass} />}
        <span class={workingLabelClass(status.toneClass, held)} style={held ? undefined : shimmerStyle(status.label)} title={thought ? (thought.length > 600 ? `…${thought.slice(-600)}` : thought) : undefined}>{status.label}</span>
        {thought ? (
          <button type="button" class="icon-button tiny working-thought" aria-expanded={open} title={open ? 'Hide reasoning' : 'Show reasoning'} aria-label={open ? 'Hide reasoning' : 'Show reasoning'}
            onClick={() => setOpen(!open)}><Icon name="lightbulb" /></button>
        ) : null}
        {/* Not announced: a clock changing every second would be read out. */}
        {live && !held ? <WorkingDetail live={live} usage={usage} /> : null}
        {/* Background terminals the vendor runs (standard section 10): its
            footer indicator, here beside the clock. Not on the closing line. */}
        {workingIndicator(live) ? <span class="muted working-background">{workingIndicator(live)}</span> : null}
      </div>
      {open && thought ? <Reasoning text={thought} /> : null}
    </div>
  );
}

/** The turn waits on the user -- an approval, or a sign-in in their
 * browser: the working line holds still, its clock stopped. */
export function waitingOnUser(model: Pick<ChatModel, 'approvals' | 'signIn'>): boolean {
  return model.approvals.length > 0 || Boolean(model.signIn);
}

/** The working line's label: in its tone, and shimmering only while the
 * turn works. Waiting on the user it holds still, as the terminal's does. */
export function workingLabelClass(toneClass: string, asking: boolean): string {
  return `working-label ${toneClass}${asking ? '' : ' shimmer'}`;
}

/** A run of calls between two paragraphs, reads and searches merged as they
 * come (an "Explored" row), its earlier rows folded once long. */
export function ActivityRun({ activities, workspace }: { activities: Activity[]; workspace?: string }): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const groups = exploreRuns(activities);
  const hiddenGroups = showAll ? 0 : foldedGroupCount(groups, VISIBLE_ACTIVITIES);
  const hidden = groups.slice(0, hiddenGroups).reduce((sum, group) => sum + group.rows.length, 0);
  return (
    <div class="activities">
      {hidden ? <button type="button" class="more-steps" onClick={() => setShowAll(true)}><Icon name="ellipsis" /> {hidden} earlier step{hidden === 1 ? '' : 's'}</button> : null}
      <RunGroups groups={groups.slice(hiddenGroups)} workspace={workspace} />
    </div>
  );
}

/** The running turn as the terminal lays it out: each call (and each message
 * sent into the turn) where it happened in the answer, the paragraphs around
 * it, the newest still streaming; then the working line. */
export const LiveTurnView = memo(({ live, workspace, asking, plan, notes, turn, away, usage }: {
  live: LiveTurn | undefined; workspace?: string; asking: boolean; plan: ChatModel['plan']; notes: Note[]; turn?: number; away: boolean; usage?: TurnUsage;
}): JSX.Element => (
  <div class="message assistant live" aria-busy="true">
    {live ? (
      <TurnFlow text={live.text} activities={live.activities} thoughts={live.reasoning} steers={live.steers} workspace={workspace} live={{ startedAt: live.startedAt }}
        {...(live.planAt ? { plan: { entries: plan, at: live.planAt } } : {})}
        {...(live.decisions?.length ? { decisions: live.decisions } : {})}
        {...(turn !== undefined ? { notes: notes.filter((note) => note.turn === turn) } : {})} />
    ) : null}
    <Working live={live} asking={asking} reconnecting={away} {...(usage ? { usage } : {})} />
  </div>
));
