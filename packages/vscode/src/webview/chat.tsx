/** The conversation: messages, the running turn, its tool activity, plans,
 * notices and approvals. */
import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ACTIVITY_PREVIEW_LINES, activityOutcome, commandOutputPreview, diffPreview, diffTotals, DIFF_PREVIEW_LINES, LIVE_OUTPUT_LINES, liveWaitKind,
  outputPreview, previewLinesFor, toolUses, waitingSpinnerGlyph,
} from '../../../../src/harness/protocol/activity-view';
import { clikCodeNoticeBody, isClikCodeNotice } from '../../../../src/session/clikcode-notice';
import { activityResult, endsWithSummary, exploreRuns, exploreSummary, tensedLabel, turnSummary } from '../../../../src/harness/protocol/turn-flow';
import { TOOL_CATEGORY } from '../../../../src/harness/protocol/tool-category';
import { COPIED_MS, shimmerCycleMs } from '../../../../src/harness/protocol/timings';
import { useNow, useSpinFrame } from './clock';

/** The shimmer sweeps a label at the terminal's pace: the same characters a
 * step, so a longer label takes longer, as it does there. */
const shimmerStyle = (label: string): string => `--shimmer-cycle: ${shimmerCycleMs(label.length)}ms`;
import { formatElapsed } from '../../../../src/harness/protocol/format';
import { turnStalled } from '../../../../src/harness/protocol/turn-pace';
import type { ToolCategory } from '../../../../src/harness/prompter';
import { APPROVAL_GUARD_MS, approvalHeading, approvalKeyAction } from '../../../../src/tui/render/approval-keys';
import { planStillNeeded, planWindow } from '../../../../src/tui/render/plan-window';
import { turnMarks, type Activity, type Approval, type ChatModel, type LiveTurn, type Note, type ThoughtEntry, type TurnTrace } from '../model';
import type { FileDiff } from '../protocol';
import { post } from './bus';
import { pathIn, titleCase } from './format';
import { createStreamingMarkdown, renderMarkdown } from './markdown';
import { Icon } from './ui';
import { foldedGroupCount, foldedSummary, workingStatus } from './flow';
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
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), COPIED_MS); }); }}>
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

/** A notice ClikCode sent the model in the user's place (a background
 * shell's exit, vendor work a stopped worker ended): muted and labelled as
 * ClikCode's, not a bubble the user wrote (session/clikcode-notice.ts). */
const ClikCodeNotice = ({ text }: { text: string }): JSX.Element => (
  <div class="notice clikcode-notice" role="note" aria-label="ClikCode notice">
    <Icon name="info" /><span><span class="notice-label">ClikCode notice</span>{'\n'}{clikCodeNoticeBody(text)}</span>
  </div>
);

const UserMessage = memo(({ text: content }: { text: string }): JSX.Element => {
  if (isClikCodeNotice(content)) return <ClikCodeNotice text={content} />;
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
 * yellow when nothing is arriving. Every spinner on the page steps on the
 * page's one clock; still under reduced motion and while hidden. */
export function Spinner({ tone = '', still = false }: { tone?: string; still?: boolean }): JSX.Element {
  const frame = useSpinFrame(!still);
  return <span class={`spinner ${tone}`} aria-hidden="true">{waitingSpinnerGlyph(frame)}</span>;
}

/** A tool label with the path in it made a link to the file. */
function ActivityLabel({ label, workspace, shimmer }: { label: string; workspace?: string; shimmer?: boolean }): JSX.Element {
  const className = shimmer ? 'activity-text live-name' : 'activity-text';
  const style = shimmer ? shimmerStyle(label) : undefined;
  const found = pathIn(label);
  if (!found) return <span class={className} style={style} title={label}>{relative(label, workspace)}</span>;
  const before = relative(label.slice(0, found.index), workspace);
  const written = found.path + (found.line ? `:${found.line}` : '');
  const after = relative(label.slice(found.index + written.length), workspace);
  // Shown relative to the workspace, opened by the path the tool used.
  const shown = relative(found.path, workspace) + (found.line ? `:${found.line}` : '');
  return (
    <span class={className} style={style} title={label}>
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

/** A finished command's output: its first lines and its last, the middle
 * counted (commandOutputPreview, the terminal's rule). */
function CommandOutput({ ends }: { ends: NonNullable<ReturnType<typeof commandOutputPreview>> }): JSX.Element {
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
  // A command's whole output: its first lines and its last (Codex).
  const budget = previewLinesFor(activity.category);
  const ends = activity.category === 'run' && status !== 'running' ? commandOutputPreview(activity) : undefined;
  const preview = !ends && activity.output?.length && budget > 0 ? outputPreview(activity, budget) : undefined;
  const hasMore = Boolean((activity.output?.length && (ends ? ends.hidden > 0 : !preview || preview.hidden > 0))
    || (activity.diff && diffPreview(activity.diff, DIFF_PREVIEW_LINES).hiddenLines));
  // What it found ("42 lines"), then the exceptions (a failure, a long run).
  const result = activityResult(activity);
  const outcome = activityOutcome(activity);
  const totals = activity.diff?.length ? diffTotals(activity.diff) : undefined;
  const agentRunning = status === 'running' && (Boolean(activity.swarm) || Boolean(activity.agent)
    || liveWaitKind({ kind: 'tool-start', label: activity.label, agent: activity.agent, category: activity.category }) === 'agent');
  const change = (action: 'view' | 'revert') => (event: MouseEvent): void => {
    event.stopPropagation();
    post({ type: 'change', action, key: activity.key, ...(userIndex === undefined ? {} : { userIndex }) });
  };
  return (
    <div class={`activity ${status}`}>
      <div class="activity-line">
        {/* The working line moves for the turn. A running sub-agent or swarm
            agent also keeps its own spinner here: that animation belongs on
            its chat row, not only on the thinking line. */}
        <span class={`activity-status ${activity.swarm ? 'tone-cyan' : toneOf(activity)}`} aria-label={status}>
          {status === 'error' ? <Icon name="error" /> : agentRunning ? <Spinner tone="tone-cyan" /> : <Icon name={activityIcon(activity)} />}
        </span>
        <ActivityLabel label={tensedLabel(activity.label, status === 'running')} workspace={workspace} shimmer={agentRunning} />
        {totals ? <span class="activity-counts"><Counts additions={totals.additions} removals={totals.removals} /></span> : null}
        {status === 'running' && activity.startedAt ? <Clock since={activity.startedAt} /> : null}
        {result ? <span class="activity-outcome activity-result">{result}</span> : null}
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
      {status === 'running' && activity.child ? <div class="activity-child" title={activity.child}><Spinner tone="tone-cyan" /><span>{activity.child}</span>{activity.childTools ? <span class="muted">{toolUses(activity.childTools)}</span> : null}</div> : null}
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

/** A run of calls a finished turn made between two paragraphs, folded to
 * one line in its place -- "Read 3 files, searched 1 pattern · ran 2
 * commands" -- as Codex folds its work; open, the rows themselves. */
function FoldedRun({ activities, workspace, userIndex }: { activities: Activity[]; workspace?: string; userIndex?: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const failed = activities.filter((activity) => activity.kind === 'tool-error').length;
  const totals = diffTotals(activities.flatMap((activity) => activity.diff ?? []));
  return (
    <div class="trace">
      <button type="button" class="trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>{foldedSummary(activities)}</span>
        {failed ? <span class="muted"> · {failed} failed</span> : null}
        {totals.additions || totals.removals ? <span class="activity-counts"><Counts additions={totals.additions} removals={totals.removals} /></span> : null}
      </button>
      {open ? <div class="activities"><RunGroups groups={exploreRuns(activities)} workspace={workspace} userIndex={userIndex} /></div> : null}
    </div>
  );
}

/** Rows of one run, each run of looking-around calls merged into one
 * "Explored" row (exploreRuns), the rest a row each. */
function RunGroups({ groups, workspace, userIndex }: { groups: ReadonlyArray<{ rows: Activity[]; explore: boolean }>; workspace?: string; userIndex?: number }): JSX.Element {
  return (
    <>
      {groups.map((group) => (group.explore
        ? <ExploredRow key={`e${group.rows[0]!.key}`} activities={group.rows} workspace={workspace} userIndex={userIndex} />
        : <ActivityRow key={group.rows[0]!.key} activity={group.rows[0]!} workspace={workspace} userIndex={userIndex} />))}
    </>
  );
}

/** Calls shown, dimmed, under a closed "Explored" row: the newest. */
const EXPLORED_RECENT = 3;

/** A run of reads and searches as one row, as Codex's "Explored" and
 * Cursor's merged reads: what it amounts to ("Read 3 files, searched 1
 * pattern"), its newest calls dimmed beneath; open, every call's own row. */
function ExploredRow({ activities, workspace, userIndex }: { activities: Activity[]; workspace?: string; userIndex?: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const running = activities.some((activity) => activity.kind === 'tool-start');
  return (
    <div class={`explored${running ? ' running' : ''}`}>
      <button type="button" class="trace-toggle explored-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span class="explored-title">{running ? 'Exploring' : 'Explored'}</span>
        <span class="muted explored-summary">{exploreSummary(activities)}</span>
      </button>
      {open ? <div class="activities">{activities.map((activity) => <ActivityRow key={activity.key} activity={activity} workspace={workspace} userIndex={userIndex} />)}</div> : (
        <div class="explored-recent">
          {activities.slice(-EXPLORED_RECENT).map((activity) => {
            const result = activityResult(activity);
            return (
              <div key={activity.key} class="explored-call">
                <span class={`activity-status ${toneOf(activity)}`}><Icon name={activityIcon(activity)} /></span>
                <ActivityLabel label={tensedLabel(activity.label, activity.kind === 'tool-start')} workspace={workspace} />
                {result ? <span class="activity-outcome activity-result">{result}</span> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
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
  const marks = turnMarks(text, props.activities, props.thoughts, props.steers);
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

/** The quiet line a finished turn ends on (Codex's "Worked for 1m 2s",
 * Cursor's files edited), and, when it changed files, all of them to review
 * at once or undo together. */
function TurnSummary({ trace }: { trace: TurnTrace }): JSX.Element | null {
  if (!endsWithSummary(trace.endedAt - trace.startedAt, trace.activities.length)) return null;
  const diffs = trace.activities.flatMap((activity) => (activity.kind === 'tool-done' && activity.diff?.length ? [activity.diff] : []));
  const changed = diffs.some((diff) => diff.some((file) => file.path));
  const act = (action: 'view' | 'revert') => (): void => post({ type: 'turnChanges', action, userIndex: trace.userIndex });
  return (
    <div class="turn-summary">
      <span class="muted">{turnSummary({ ms: trace.endedAt - trace.startedAt, diffs })}</span>
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
      <TurnSummary trace={trace} />
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
          {/* The step in progress is marked, still: the working line is
              what moves. */}
          <Icon name={entry.status === 'completed' ? 'pass-filled' : entry.status === 'cancelled' ? 'circle-slash' : entry.status === 'in_progress' ? 'circle-large-filled' : 'circle-large'} />
          <span>{entry.content}</span>
        </div>
      ))}
      {hidden && !all ? <button type="button" class="more-steps" onClick={() => setAll(true)}><Icon name="ellipsis" /> {done}/{plan.length} done · {hidden} more</button> : null}
      {all && hidden ? <button type="button" class="more-steps" onClick={() => setAll(false)}><Icon name="fold-up" /> Show fewer</button> : null}
    </div>
  );
}

/** Rows of one run of calls shown before the earlier ones fold away. */
const VISIBLE_ACTIVITIES = 6;

/** The working line: what the turn is doing (turn-flow's rule: waiting on you,
 * the open call's verb, the reasoning's own heading, or how long it has
 * thought), in the colour of that work, a shimmer passing over it (CSS). A
 * running sub-agent or swarm agent keeps its own spinner on its chat row.
 * The thought being had is this line's tooltip, and opens under it. Ticks
 * on its own. */
function Working({ live, elsewhere, asking }: { live: LiveTurn | undefined; elsewhere: boolean; asking: boolean }): JSX.Element {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const status = workingStatus(live, asking, now);
  const thought = asking ? undefined : live?.thought?.text;
  return (
    <div class="working-wrap">
      <div class={`working status-${status.tone}`} role="status">
        <Spinner tone={!asking && live && turnStalled(now - live.activeAt) ? 'tone-yellow' : status.toneClass} still={asking} />
        <span class={`working-label ${status.toneClass}`} style={shimmerStyle(status.label)} title={thought ? (thought.length > 600 ? `…${thought.slice(-600)}` : thought) : undefined}>{status.label}</span>
        {thought ? (
          <button type="button" class="icon-button tiny working-thought" aria-expanded={open} title={open ? 'Hide reasoning' : 'Show reasoning'} aria-label={open ? 'Hide reasoning' : 'Show reasoning'}
            onClick={() => setOpen(!open)}><Icon name="lightbulb" /></button>
        ) : null}
        <span class="muted">{live ? formatElapsed(now - live.startedAt) : ''}{elsewhere ? ' · running in another window' : ''}</span>
      </div>
      {open && thought ? <Reasoning text={thought} /> : null}
    </div>
  );
}

/** A run of calls between two paragraphs, reads and searches merged as they
 * come (an "Explored" row), its earlier rows folded once long. */
function ActivityRun({ activities, workspace }: { activities: Activity[]; workspace?: string }): JSX.Element {
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
const LiveTurnView = memo(({ live, workspace, elsewhere, asking }: { live: LiveTurn | undefined; workspace?: string; elsewhere: boolean; asking: boolean }): JSX.Element => (
  <div class="message assistant live" aria-busy="true">
    {live ? <TurnFlow text={live.text} activities={live.activities} thoughts={live.reasoning} steers={live.steers} workspace={workspace} live={{ startedAt: live.startedAt }} /> : null}
    <Working live={live} elsewhere={elsewhere} asking={asking} />
  </div>
));

/** Messages drawn at first; a long conversation shows its latest and loads
 * earlier ones on demand, so opening it stays instant. */
const WINDOW = 120;

/** The settled conversation. Memoized on the fields it draws, which keep
 * their objects while a turn streams, so a delta does not redraw it. */
const History = memo(({ sessionId, messages, traces, notes, workspace, reveal }: Pick<ChatModel, 'sessionId' | 'messages' | 'traces' | 'notes' | 'workspace'> & { reveal?: number }): JSX.Element => {
  const byUser = useMemo(() => new Map(traces.map((trace) => [trace.userIndex, trace])), [traces]);
  const [shown, setShown] = useState(WINDOW);
  useEffect(() => { setShown(WINDOW); }, [sessionId]);
  // A message /search went to is drawn, however far back it is.
  useEffect(() => { if (reveal !== undefined && messages.length - reveal > shown) setShown(messages.length - reveal + WINDOW / 4); }, [reveal, messages.length]);
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
    const trace = message.role === 'assistant' ? byUser.get(index - 1) : undefined;
    // `display: contents`: an anchor /search finds the message by, with no box of its own.
    parts.push(
      <div key={`m${index}`} class="message-anchor" data-message={index}>
        {message.role === 'user' ? <UserMessage text={message.content} />
          : trace ? <FinishedTurn text={message.content} trace={trace} cacheKey={`${sessionId}#${index}`} workspace={workspace} />
            : <AssistantMessage cacheKey={`${sessionId}#${index}`} text={message.content} />}
      </div>,
    );
    notesAt(index + 1);
  });
  return <>{parts}</>;
});

export function Transcript({ model, reveal }: { model: ChatModel; reveal?: number }): JSX.Element {
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
      <History sessionId={model.sessionId} messages={model.messages} traces={model.traces} notes={model.notes} workspace={model.workspace} reveal={reveal} />
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
 * offered, and the rule is shown), n, Enter or Esc deny. Or denied with a
 * note (Claude Code's "No, and tell it what to do instead"): the note goes
 * into the running turn as a message. Several waiting: "Approval 1 of 3". */
export function ApprovalCard({ approval, workspace, position, total, onAnswer }: {
  approval: Approval; workspace?: string; position: number; total: number; onAnswer: (value: boolean | 'always', note?: string) => void;
}): JSX.Element {
  const shownAt = useRef(Date.now());
  const [guarded, setGuarded] = useState(true);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const noteInput = useRef<HTMLInputElement>(null);
  useEffect(() => { const timer = setTimeout(() => setGuarded(false), APPROVAL_GUARD_MS); return () => clearTimeout(timer); }, []);
  useEffect(() => { if (noting) noteInput.current?.focus(); }, [noting]);
  const onKey = (event: KeyboardEvent): void => {
    const tag = (event.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key === 'Escape' ? '\u001b' : event.key === 'Enter' ? '\r' : event.key === 'Tab' ? '\t' : event.key;
    const action = approvalKeyAction(key, Date.now() - shownAt.current, false, true, Boolean(approval.rule));
    if (action === 'ignore' || action === 'focus') { if (key.length === 1) event.preventDefault(); return; }
    event.preventDefault();
    event.stopPropagation();
    onAnswer(action === 'allow' ? true : action === 'always' ? 'always' : false);
  };
  const answer = (value: boolean | 'always') => (): void => { if (Date.now() - shownAt.current >= APPROVAL_GUARD_MS) onAnswer(value); };
  const denyWithNote = (): void => {
    if (Date.now() - shownAt.current >= APPROVAL_GUARD_MS && note.trim()) onAnswer(false, note.trim());
  };
  // The note's own keys: Enter denies with it, Esc puts the note away (and
  // is not the page's Esc, which would deny without it).
  const onNoteKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      denyWithNote();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setNoting(false);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-approval="${approval.id}"]`)?.focus());
    }
  };
  return (
    <div class={`approval${guarded ? ' guarded' : ''}`} role="alertdialog" aria-label={`Approval: ${approval.title}`} tabIndex={0} onKeyDown={onKey} data-approval={approval.id}>
      <div class="approval-head">
        <Icon name="shield" /><span class="approval-title">{relative(approvalHeading(approval.title, approval.detail), workspace)}</span>
        {total > 1 ? <span class="muted approval-count">Approval {position} of {total}</span> : null}
        {approval.diff?.length ? <button type="button" class="icon-button tiny approval-diff" title="Open in the diff editor" aria-label="Open in the diff editor" onClick={() => post({ type: 'viewDiff', id: approval.id })}><Icon name="diff" /></button> : null}
      </div>
      {/* The change speaks for an edit; a command's words are its detail. */}
      {approval.diff?.length ? <DiffView files={approval.diff} budget={ACTIVITY_PREVIEW_LINES} />
        : approval.detail ? <pre class="approval-detail">{relative(approval.detail, workspace)}</pre> : null}
      <div class="approval-actions">
        <button type="button" class="primary" data-approve="yes" onClick={answer(true)}>Allow <kbd>y</kbd></button>
        {approval.rule ? <button type="button" class="secondary" data-approve="always" title={`Always allow ${approval.rule}`} onClick={answer('always')}>Always <kbd>a</kbd></button> : null}
        <button type="button" class="secondary" data-approve="no" title="Deny (n, Enter or Esc)" onClick={answer(false)}>Deny <kbd>n</kbd></button>
        <button type="button" class="link" data-approve="note" aria-expanded={noting} title="Deny, and tell it what to do instead" onClick={() => setNoting(!noting)}>Deny with a note…</button>
      </div>
      {noting ? (
        <div class="approval-note">
          <input ref={noteInput} type="text" class="approval-note-input" value={note} placeholder="Tell it what to do instead…" aria-label="Tell it what to do instead"
            onInput={(event) => setNote((event.target as HTMLInputElement).value)} onKeyDown={onNoteKey} />
          <button type="button" class="secondary" data-approve="note-send" title="Deny, and send this note into the turn (Enter)" disabled={!note.trim()} onClick={denyWithNote}>Deny <kbd>↵</kbd></button>
        </div>
      ) : null}
      {approval.rule ? <div class="approval-rule muted" title="What Always allow remembers">Always: <code>{approval.rule}</code></div> : null}
    </div>
  );
}
