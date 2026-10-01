/** The conversation: messages, the running turn, its tool activity, plans,
 * notices and approvals. */
import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ACTIVITY_PREVIEW_LINES, activityOutcome, diffPreview, diffTotals, DIFF_PREVIEW_LINES, formatElapsed, LIVE_OUTPUT_LINES, liveWaitKind,
  outputPreview, previewLinesFor, SPIN_MS, STALL_MS, toolUses, waitingSpinnerGlyph,
} from '../../../../src/harness/protocol/activity-view';
import { TOOL_CATEGORY } from '../../../../src/harness/protocol/tool-category';
import type { ToolCategory } from '../../../../src/harness/prompter';
import { APPROVAL_GUARD_MS, approvalKeyAction } from '../../../../src/tui/render/approval-keys';
import { planStillNeeded, planWindow } from '../../../../src/tui/render/plan-window';
import type { Activity, Approval, ChatModel, LiveTurn, Note, ThoughtEntry, TurnTrace } from '../model';
import type { FileDiff } from '../protocol';
import { post } from './bus';
import { pathIn, titleCase } from './format';
import { createStreamingMarkdown, renderMarkdown } from './markdown';
import { Icon } from './ui';
import { splitEditorContext } from '../editor-context';

/** Finished messages, rendered once each and kept across a redraw of the
 * transcript (another conversation and back). Keyed by conversation and
 * position, checked against the text; the live answer never goes in here. */
const finishedHtml = new Map<string, { text: string; html: string }>();
const FINISHED_LIMIT = 400;

function renderFinished(key: string, text: string): string {
  const hit = finishedHtml.get(key);
  if (hit?.text === text) return hit.html;
  const html = renderMarkdown(text);
  finishedHtml.delete(key);
  finishedHtml.set(key, { text, html });
  if (finishedHtml.size > FINISHED_LIMIT) finishedHtml.delete(finishedHtml.keys().next().value!);
  return html;
}

/** Copies an answer as written (its markdown), and says so for a moment. */
function CopyAnswer({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" class="icon-button tiny message-copy" title={copied ? 'Copied' : 'Copy answer'} aria-label={copied ? 'Copied' : 'Copy answer'}
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  );
}

const AssistantMessage = memo(({ cacheKey, text }: { cacheKey: string; text: string }): JSX.Element => (
  <div class="message assistant" role="article" aria-label="ClikCode">
    <div class="markdown" dangerouslySetInnerHTML={{ __html: renderFinished(cacheKey, text) }} />
    <div class="message-actions"><CopyAnswer text={text} /></div>
  </div>
));

/** The answer still streaming: the settled blocks and the growing one are
 * separate nodes, so a delta replaces only the last block's HTML. */
function LiveMarkdown({ text }: { text: string }): JSX.Element {
  const render = useRef(createStreamingMarkdown());
  const { stable, tail } = render.current(text);
  return (
    <div class="markdown">
      <div class="md-part" dangerouslySetInnerHTML={{ __html: stable }} />
      <div class="md-part" dangerouslySetInnerHTML={{ __html: tail }} />
    </div>
  );
}

const UserMessage = memo(({ text: content }: { text: string }): JSX.Element => {
  const { text, file, problems, selections } = splitEditorContext(content);
  return (
    <div class="message user" role="article" aria-label="You">
      <div class="bubble">
        {text}
        {selections.length ? (
          <div class="bubble-context" title="Sent with the selected lines">
            {selections.map((selection) => <span key={selection} class="bubble-chip"><Icon name="code" />{selection}</span>)}
          </div>
        ) : null}
        {file ? (
          <div class="bubble-context" title={`Sent with the open file${problems ? ` and ${problems} problem${problems === 1 ? '' : 's'} VS Code reported there` : ''}`}>
            <Icon name="file" /><span>{file.split(/[\\/]/).pop()}</span>{problems ? <span class="context-problems"><Icon name="warning" />{problems}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

const CATEGORY_ICON: Record<ToolCategory, string> = { read: 'file', edit: 'edit', run: 'terminal', search: 'search', fetch: 'globe' };

/** A call's icon and colour come from what it is (its category, or being a
 * sub-agent), the same facts the terminal's glyph and colour come from. */
function activityIcon(activity: Activity): string {
  if (activity.agent || liveWaitKind({ ...activity, kind: 'tool-start' }) === 'agent') return 'hubot';
  return activity.category ? CATEGORY_ICON[activity.category] : 'tools';
}

function toneOf(activity: Activity): string {
  if (activity.agent) return 'tone-cyan';
  return activity.category ? `tone-${TOOL_CATEGORY[activity.category].colour}` : '';
}

/** The terminal's spinner, the same braille frames at the same rate: a
 * command's in yellow, a sub-agent's in cyan, the turn's own still and
 * yellow when nothing is arriving. Still under reduced motion. */
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Spinner({ tone = '', still = false }: { tone?: string; still?: boolean }): JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (still || REDUCED_MOTION) return undefined;
    const timer = setInterval(() => setFrame((value) => value + 1), SPIN_MS);
    return () => clearInterval(timer);
  }, [still]);
  return <span class={`spinner ${tone}`} aria-hidden="true">{waitingSpinnerGlyph(frame)}</span>;
}

/** A tool label with the path in it made a link to the file. */
function ActivityLabel({ label, workspace }: { label: string; workspace?: string }): JSX.Element {
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
function DiffView({ files, budget }: { files: readonly FileDiff[]; budget?: number }): JSX.Element {
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

function Counts({ additions, removals }: { additions: number; removals: number }): JSX.Element {
  return <>{additions ? <span class="add">+{additions}</span> : null}{additions && removals ? ' ' : ''}{removals ? <span class="del">-{removals}</span> : null}</>;
}

/** A tool's output as the terminal budgets it: a command's last lines, the
 * earlier ones counted above; anything else its first, the rest below. */
function OutputView({ activity, budget }: { activity: Activity; budget: number }): JSX.Element | null {
  const { lines, hidden, fromEnd } = outputPreview(activity, budget);
  if (!lines.length) return null;
  const note = hidden > 0 ? <div class="gap">… {hidden} {fromEnd ? 'earlier' : 'more'} line{hidden === 1 ? '' : 's'}</div> : null;
  return <pre class="activity-output">{fromEnd ? note : null}{lines.join('\n')}{fromEnd ? null : note}</pre>;
}

/** Which rows are open, kept across the live turn becoming its trace and
 * across a redraw: a row is its call (key) at the moment it was first seen. */
const openRows = new Set<string>();
const rowId = (activity: Activity): string => `${activity.key}@${activity.startedAt ?? ''}`;

/** The seconds a running call has taken, ticking on its own so the rest of
 * the turn is not redrawn every second. */
function Clock({ since }: { since: number }): JSX.Element | null {
  const now = useNow();
  return now - since >= 1000 ? <span class="activity-outcome">{formatElapsed(now - since)}</span> : null;
}

function ActivityRow({ activity, workspace, userIndex }: { activity: Activity; workspace?: string; userIndex?: number }): JSX.Element {
  const id = rowId(activity);
  const [open, setOpenState] = useState(openRows.has(id));
  const setOpen = (value: boolean): void => { if (value) openRows.add(id); else openRows.delete(id); setOpenState(value); };
  const status = activity.kind === 'tool-start' ? 'running' : activity.kind === 'tool-error' ? 'error' : 'done';
  // What the terminal shows under a settled call: an edit's change, a
  // command's or search's last lines, a fetch's first -- a read's row says
  // all of it. The rest is one click away.
  const budget = previewLinesFor(activity.category);
  const preview = activity.output?.length && budget > 0 ? outputPreview(activity, budget) : undefined;
  const hasMore = Boolean((activity.output?.length && (!preview || preview.hidden > 0))
    || (activity.diff && diffPreview(activity.diff, DIFF_PREVIEW_LINES).hiddenLines));
  const outcome = activityOutcome(activity);
  const kind = status === 'running' ? liveWaitKind(activity) : undefined;
  const totals = activity.diff?.length ? diffTotals(activity.diff) : undefined;
  const change = (action: 'view' | 'revert') => (event: MouseEvent): void => {
    event.stopPropagation();
    post({ type: 'change', action, key: activity.key, ...(userIndex === undefined ? {} : { userIndex }) });
  };
  return (
    <div class={`activity ${status}`}>
      <div class="activity-line">
        <span class={`activity-status ${toneOf(activity)}`} aria-label={status}>
          {status === 'running' ? <Spinner tone={kind === 'command' ? 'tone-yellow' : kind === 'agent' ? 'tone-cyan' : ''} />
            : status === 'error' ? <Icon name="error" /> : <Icon name={activityIcon(activity)} />}
        </span>
        <ActivityLabel label={activity.label} workspace={workspace} />
        {totals ? <span class="activity-counts"><Counts additions={totals.additions} removals={totals.removals} /></span> : null}
        {status === 'running' && activity.startedAt ? <Clock since={activity.startedAt} /> : null}
        {outcome ? <span class={`activity-outcome${outcome.failed ? ' failed' : ''}`}>{outcome.parts.join(' · ')}</span> : null}
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
      {status === 'running' && activity.child ? <div class="activity-child" title={activity.child}><Icon name="arrow-small-right" /><span>{activity.child}</span>{activity.childTools ? <span class="muted">{toolUses(activity.childTools)}</span> : null}</div> : null}
      {/* A running call shows what it has printed so far, newest last -- a
          long build is visibly working instead of a bare timer. */}
      {status === 'running' && !open && activity.output?.length ? <OutputView activity={{ ...activity, outputTail: true }} budget={LIVE_OUTPUT_LINES} /> : null}
      {activity.diff?.length ? <DiffView files={activity.diff} budget={open ? undefined : status === 'running' ? 0 : DIFF_PREVIEW_LINES} /> : null}
      {status !== 'running' && !open && preview ? <OutputView activity={activity} budget={budget} /> : null}
      {open && activity.output?.length ? <OutputView activity={activity} budget={Number.MAX_SAFE_INTEGER} /> : null}
    </div>
  );
}

/** A run of calls a finished turn made between two paragraphs, folded to
 * one line in its place -- "read 3 files · ran 2 commands" -- as Codex folds
 * its work; open, the rows themselves. */
function FoldedRun({ activities, workspace, userIndex }: { activities: Activity[]; workspace?: string; userIndex?: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const failed = activities.filter((activity) => activity.kind === 'tool-error').length;
  const totals = diffTotals(activities.flatMap((activity) => activity.diff ?? []));
  return (
    <div class="trace">
      <button type="button" class="trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>{runSummary(activities)}</span>
        {failed ? <span class="muted"> · {failed} failed</span> : null}
        {totals.additions || totals.removals ? <span class="activity-counts"><Counts additions={totals.additions} removals={totals.removals} /></span> : null}
      </button>
      {open ? <div class="activities">{activities.map((activity) => <ActivityRow key={activity.key} activity={activity} workspace={workspace} userIndex={userIndex} />)}</div> : null}
    </div>
  );
}

/** What a run of calls did, in the terminal's folded words per kind. */
function runSummary(activities: readonly Activity[]): string {
  const counts = new Map<string, number>();
  for (const activity of activities) {
    const kind = activity.agent ? 'agent' : activity.category ?? 'other';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => (kind === 'agent' ? `ran ${count} agent${count === 1 ? '' : 's'}`
    : kind === 'other' ? `${count} step${count === 1 ? '' : 's'}`
      : count === 1 && activities.length === 1 ? activities[0]!.label : TOOL_CATEGORY[kind as ToolCategory].folded(count))).join(' · ');
}

/** A thought, where it happened: "Thought for 4s", open to read it. */
function ThoughtRow({ thought }: { thought: ThoughtEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div class="trace thought-row">
      <button type="button" class="trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} /><span>Thought for {formatElapsed(Math.max(1000, thought.ms))}</span>
      </button>
      {open ? <Reasoning text={thought.text} /> : null}
    </div>
  );
}

function Reasoning({ text }: { text: string }): JSX.Element {
  return <div class="reasoning" aria-label="Reasoning"><p>{text}</p></div>;
}

/** How a turn reads, live or finished, in the order it happened -- as
 * Claude Code and Codex lay a turn out: each paragraph of the answer, and
 * between them the calls, thoughts and messages sent into the turn at the
 * point they came. Live, calls show as rows and the last paragraph streams;
 * finished, each run of calls folds to one line in its place, so nothing
 * moves when the turn ends. */
function TurnFlow(props: {
  text: string; activities: readonly Activity[]; thoughts: readonly ThoughtEntry[]; steers: ReadonlyArray<{ text: string; offset: number }>;
  workspace?: string; live?: { startedAt: number }; cacheKey?: string; userIndex?: number;
}): JSX.Element {
  const { text } = props;
  type Mark = { offset: number; activity?: Activity; thought?: ThoughtEntry; steer?: string };
  const marks: Mark[] = [
    ...props.thoughts.map((thought) => ({ offset: Math.min(thought.offset, text.length), thought })),
    ...props.activities.map((activity) => ({ offset: Math.min(activity.offset ?? 0, text.length), activity })),
    ...props.steers.map((steer) => ({ offset: Math.min(steer.offset, text.length), steer: steer.text })),
  ].sort((left, right) => left.offset - right.offset);
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
    const html = props.cacheKey ? renderFinished(`${props.cacheKey}@${at}`, piece) : renderMarkdown(piece);
    parts.push(<div key={`t${at}`} class="markdown" dangerouslySetInnerHTML={{ __html: html }} />);
    at = end;
  };
  for (const mark of marks) {
    if (mark.offset > at) paragraph(mark.offset);
    if (mark.activity) { run.push(mark.activity); continue; }
    flushRun();
    if (mark.thought) parts.push(<ThoughtRow key={`h${mark.offset}-${parts.length}`} thought={mark.thought} />);
    else parts.push(<div key={`s${mark.offset}-${mark.steer}`} class="steer"><Icon name="arrow-small-right" /><span>{mark.steer}</span><span class="muted">sent into this turn</span></div>);
  }
  flushRun();
  if (props.live) {
    if (text.slice(at)) parts.push(<LiveMarkdown key={`${props.live.startedAt}-${at}`} text={text.slice(at)} />);
  } else paragraph(text.length);
  return <>{parts}</>;
}

/** A finished answer with how it was reached, in the order it happened.
 * Rows and thoughts land where they came in the answer as it streamed; one
 * whose place the saved answer no longer reads the same up to goes first. */
const FinishedTurn = memo(({ text, trace, cacheKey, workspace }: { text: string; trace: TurnTrace; cacheKey: string; workspace?: string }): JSX.Element => {
  const place = <T extends { offset?: number }>(item: T): T => {
    const offset = item.offset ?? 0;
    return offset <= text.length && text.slice(0, offset) === trace.text.slice(0, offset) ? item : { ...item, offset: 0 };
  };
  return (
    <div class="message assistant" role="article" aria-label="ClikCode">
      {trace.plan ? <Plan plan={trace.plan} folded /> : null}
      <TurnFlow text={text} activities={trace.activities.map(place)} thoughts={(trace.reasoning ?? []).map(place)} steers={(trace.steers ?? []).map(place)}
        workspace={workspace} cacheKey={cacheKey} userIndex={trace.userIndex} />
      <div class="message-actions"><CopyAnswer text={text} /></div>
    </div>
  );
});

const NoteView = memo(({ note }: { note: Note }): JSX.Element => {
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
function Plan({ plan, folded = false, running = false }: { plan: ChatModel['plan']; folded?: boolean; running?: boolean }): JSX.Element {
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
          {/* The step in progress moves with the turn, as the terminal's does. */}
          {entry.status === 'in_progress' && running ? <Spinner tone="tone-cyan" />
            : <Icon name={entry.status === 'completed' ? 'pass-filled' : entry.status === 'cancelled' ? 'circle-slash' : entry.status === 'in_progress' ? 'circle-large-filled' : 'circle-large'} />}
          <span>{entry.content}</span>
        </div>
      ))}
      {hidden && !all ? <button type="button" class="more-steps" onClick={() => setAll(true)}><Icon name="ellipsis" /> {done}/{plan.length} done · {hidden} more</button> : null}
      {all && hidden ? <button type="button" class="more-steps" onClick={() => setAll(false)}><Icon name="fold-up" /> Show fewer</button> : null}
    </div>
  );
}

/** The time, once a second, while mounted. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Rows of one run of calls shown before the earlier ones fold away. */
const VISIBLE_ACTIVITIES = 6;

/** The working line, as the terminal's: what the turn is doing (the open
 * call's verb, else the turn's phase), how long it has run, and a stall named
 * as one -- never while a call runs or an approval waits, when silence is
 * expected. Ticks on its own. */
function Working({ live, elsewhere, asking }: { live: LiveTurn | undefined; elsewhere: boolean; asking: boolean }): JSX.Element {
  const now = useNow();
  const label = asking ? 'waiting for approval' : live?.toolPhase ?? live?.phase ?? live?.waitingLabel ?? 'starting';
  const quiet = live && !asking && !live.openTools.length ? now - (live.lastEventAt ?? live.startedAt) : 0;
  const stalled = quiet >= STALL_MS;
  return (
    <div class="working" role="status">
      <Spinner tone={stalled ? 'tone-yellow' : 'tone-cyan'} still={stalled || asking} />
      <span class="working-label">{titleCase(label.replace(/(…|\.\.\.)$/, ''))}…</span>
      <span class="muted">{live ? formatElapsed(now - live.startedAt) : ''}{elsewhere ? ' · running in another window' : ''}</span>
      {stalled ? <span class="stalled" title="Nothing has arrived from the agent for a while">nothing received for {formatElapsed(quiet)}</span> : null}
      {asking ? null : <span class="muted working-hint">Esc to stop</span>}
    </div>
  );
}

/** The thought being had, its newest words on one line as in the terminal;
 * open, all of it. Settled, it becomes a "Thought for Xs" row in place. */
function LiveThought({ live }: { live: LiveTurn }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!live.thought) return null;
  const text = live.thought.text;
  return (
    <div class={`thought${open ? ' open' : ''}`}>
      <button type="button" class="thought-toggle" aria-expanded={open} title={open ? 'Hide reasoning' : 'Show reasoning'} onClick={() => setOpen(!open)}>
        <Icon name="lightbulb" /><span class="thought-text">{text.length > 200 ? `…${text.slice(-200)}` : text}</span>
      </button>
      {open ? <Reasoning text={text} /> : null}
    </div>
  );
}

/** A run of calls between two paragraphs, its earlier rows folded once long. */
function ActivityRun({ activities, workspace }: { activities: Activity[]; workspace?: string }): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : Math.max(0, activities.length - VISIBLE_ACTIVITIES);
  return (
    <div class="activities">
      {hidden ? <button type="button" class="more-steps" onClick={() => setShowAll(true)}><Icon name="ellipsis" /> {hidden} earlier step{hidden === 1 ? '' : 's'}</button> : null}
      {activities.slice(hidden).map((activity) => <ActivityRow key={activity.key} activity={activity} workspace={workspace} />)}
    </div>
  );
}

/** The running turn as the terminal lays it out: each call (and each message
 * sent into the turn) where it happened in the answer, the paragraphs around
 * it, the newest still streaming; then the thought and the working line. */
const LiveTurnView = memo(({ live, workspace, elsewhere, asking }: { live: LiveTurn | undefined; workspace?: string; elsewhere: boolean; asking: boolean }): JSX.Element => (
  <div class="message assistant live" aria-busy="true">
    {live ? <TurnFlow text={live.text} activities={live.activities} thoughts={live.reasoning} steers={live.steers} workspace={workspace} live={{ startedAt: live.startedAt }} /> : null}
    {live && !asking ? <LiveThought live={live} /> : null}
    <Working live={live} elsewhere={elsewhere} asking={asking} />
  </div>
));

/** Messages drawn at first; a long conversation shows its latest and loads
 * earlier ones on demand, so opening it stays instant. */
const WINDOW = 120;

/** The settled conversation. Memoized on the fields it draws, which keep
 * their objects while a turn streams, so a delta does not redraw it. */
const History = memo(({ sessionId, messages, traces, notes, workspace }: Pick<ChatModel, 'sessionId' | 'messages' | 'traces' | 'notes' | 'workspace'>): JSX.Element => {
  const byUser = useMemo(() => new Map(traces.map((trace) => [trace.userIndex, trace])), [traces]);
  const [shown, setShown] = useState(WINDOW);
  useEffect(() => { setShown(WINDOW); }, [sessionId]);
  const start = Math.max(0, messages.length - shown);
  const parts: JSX.Element[] = [];
  if (start > 0) {
    parts.push(
      <button key="earlier" type="button" class="more-steps earlier" onClick={() => setShown(shown + WINDOW)}>
        <Icon name="fold-up" /> {start} earlier message{start === 1 ? '' : 's'}
      </button>,
    );
  }
  const notesAt = (index: number): void => {
    notes.forEach((note, position) => { if (note.after === index) parts.push(<NoteView key={`n${position}`} note={note} />); });
  };
  if (start === 0) notesAt(0);
  messages.forEach((message, index) => {
    if (index < start) return;
    if (message.role === 'user') parts.push(<UserMessage key={`m${index}`} text={message.content} />);
    else {
      const trace = byUser.get(index - 1);
      parts.push(trace
        ? <FinishedTurn key={`m${index}`} text={message.content} trace={trace} cacheKey={`${sessionId}#${index}`} workspace={workspace} />
        : <AssistantMessage key={`m${index}`} cacheKey={`${sessionId}#${index}`} text={message.content} />);
    }
    notesAt(index + 1);
  });
  return <>{parts}</>;
});

export function Transcript({ model }: { model: ChatModel }): JSX.Element {
  const parts: JSX.Element[] = [];
  if (model.pendingPrompt) parts.push(<UserMessage key="pending" text={model.pendingPrompt} />);
  // A plan is on screen while it has open steps; finished, it goes, and is
  // kept with its turn (planStillNeeded, as the terminal decides).
  if (planStillNeeded(model.plan)) parts.push(<Plan key="plan" plan={model.plan} running={model.running} />);
  if (model.running) parts.push(<LiveTurnView key="live" live={model.live} workspace={model.workspace} elsewhere={!model.ownTurn} asking={model.approvals.length > 0} />);
  // Notes from the running turn (an account switch, "Stopped") follow it.
  model.notes.forEach((note, position) => { if (note.after > model.messages.length) parts.push(<NoteView key={`n${position}`} note={note} />); });
  const queuedTexts = new Set(model.queued.map((item) => item.text));
  const steered = new Set(model.live?.steers.map((steer) => steer.text));
  for (const submission of model.submissions) {
    // A queued message is drawn once, from the stored queue under the
    // composer; one the turn took is drawn in the turn, where it landed.
    if (submission.disposition === 'queued' || (!submission.disposition && queuedTexts.has(submission.text)) || steered.has(submission.text)) continue;
    const said = submission.disposition === 'steered' ? 'Sent into this turn' : submission.disposition === 'queued' ? 'Queued for the next turn' : submission.disposition === 'error' ? 'Not sent' : 'Sending…';
    parts.push(<div key={`s${submission.id}`} class="submission"><Icon name="arrow-small-right" /><span class="muted">{said}:</span> <span>{submission.text}</span></div>);
  }
  return (
    <div class="transcript" role="log" aria-live="polite" aria-relevant="additions">
      <History sessionId={model.sessionId} messages={model.messages} traces={model.traces} notes={model.notes} workspace={model.workspace} />
      {parts}
    </div>
  );
}

/** Paths inside the workspace, shown relative to it. */
function relative(text: string, workspace: string | undefined): string {
  if (!workspace) return text;
  const root = workspace.replace(/[\\/]+$/, '');
  return text.split(`${root}/`).join('').split(`${root}\\`).join('');
}

/** A pending approval, answered with the terminal's keys and its guard
 * (approval-keys.ts): nothing counts for the first moments, so a word being
 * typed cannot approve a call; y once, a always (only where a rule is
 * offered, and the rule is shown), n, Enter or Esc deny. */
export function ApprovalCard({ approval, workspace, waiting, onAnswer }: { approval: Approval; workspace?: string; waiting: number; onAnswer: (value: boolean | 'always') => void }): JSX.Element {
  const shownAt = useRef(Date.now());
  const [guarded, setGuarded] = useState(true);
  useEffect(() => { const timer = setTimeout(() => setGuarded(false), APPROVAL_GUARD_MS); return () => clearTimeout(timer); }, []);
  const onKey = (event: KeyboardEvent): void => {
    if ((event.target as HTMLElement).tagName === 'TEXTAREA' || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key === 'Escape' ? '\u001b' : event.key === 'Enter' ? '\r' : event.key === 'Tab' ? '\t' : event.key;
    const action = approvalKeyAction(key, Date.now() - shownAt.current, false, true, Boolean(approval.rule));
    if (action === 'ignore' || action === 'focus') { if (key.length === 1) event.preventDefault(); return; }
    event.preventDefault();
    event.stopPropagation();
    onAnswer(action === 'allow' ? true : action === 'always' ? 'always' : false);
  };
  const answer = (value: boolean | 'always') => (): void => { if (Date.now() - shownAt.current >= APPROVAL_GUARD_MS) onAnswer(value); };
  return (
    <div class={`approval${guarded ? ' guarded' : ''}`} role="alertdialog" aria-label={`Approval: ${approval.title}`} tabIndex={0} onKeyDown={onKey} data-approval={approval.id}>
      <div class="approval-head">
        <Icon name="shield" /><span class="approval-title">{relative(approval.title, workspace)}</span>
        {waiting ? <span class="muted">+{waiting} waiting</span> : null}
        {approval.diff?.length ? <button type="button" class="icon-button tiny approval-diff" title="Open in the diff editor" aria-label="Open in the diff editor" onClick={() => post({ type: 'viewDiff', id: approval.id })}><Icon name="diff" /></button> : null}
      </div>
      {/* The change speaks for an edit; a command's words are its detail. */}
      {approval.diff?.length ? <DiffView files={approval.diff} budget={ACTIVITY_PREVIEW_LINES} />
        : approval.detail ? <pre class="approval-detail">{relative(approval.detail, workspace)}</pre> : null}
      <div class="approval-actions">
        <button type="button" class="primary" data-approve="yes" onClick={answer(true)}>Allow <kbd>y</kbd></button>
        {approval.rule ? <button type="button" class="secondary" data-approve="always" title={`Always allow ${approval.rule}`} onClick={answer('always')}>Always <kbd>a</kbd></button> : null}
        <button type="button" class="secondary" data-approve="no" title="Deny (n, Enter or Esc)" onClick={answer(false)}>Deny <kbd>n</kbd></button>
      </div>
      {approval.rule ? <div class="approval-rule muted" title="What Always allow remembers">Always: <code>{approval.rule}</code></div> : null}
    </div>
  );
}
