/** The conversation: messages, the running turn, its tool activity, plans,
 * notices and approvals. */
import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { diffPreview, diffTotals, DIFF_PREVIEW_LINES, LIVE_OUTPUT_LINES, outputPreview } from '../../../../src/harness/protocol/activity-view';
import { approvalKeyAction } from '../../../../src/tui/render/approval-keys';
import { planWindow } from '../../../../src/tui/render/plan-window';
import type { Activity, Approval, ChatModel, LiveTurn as Live, Note, TurnTrace } from '../model';
import type { FileDiff } from '../protocol';
import { post } from './bus';
import { duration, pathIn, titleCase } from './format';
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

const CATEGORY_ICON: Record<string, string> = { read: 'file', edit: 'edit', run: 'terminal', search: 'search', fetch: 'globe' };

function activityIcon(activity: Activity): string {
  if (activity.kind === 'thinking') return 'lightbulb';
  if (activity.category && CATEGORY_ICON[activity.category]) return CATEGORY_ICON[activity.category]!;
  const verb = activity.label.split(/\s/)[0]?.toLowerCase() ?? '';
  if (/^(read|view|open|cat|list|ls)/.test(verb)) return 'file';
  if (/^(edit|write|update|create|patch|apply|delete)/.test(verb)) return 'edit';
  if (/^(run|bash|shell|exec|command|\$)/.test(verb)) return 'terminal';
  if (/^(search|grep|find|glob)/.test(verb)) return 'search';
  if (/^(fetch|web|http|browse)/.test(verb)) return 'globe';
  if (/^(task|agent|subagent)/.test(verb)) return 'hubot';
  return 'tools';
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

/** What the terminal shows after a finished call: its non-zero exit and a run of a second or more -- the exceptions, since
 * every call exits 0 in under a second. */
function activityOutcome(activity: Activity): { text: string; failed: boolean } | undefined {
  if (activity.kind === 'tool-start' || activity.kind === 'thinking') return undefined;
  const failed = activity.exitCode !== undefined && activity.exitCode !== 0;
  const parts = [
    ...(failed ? [`exit ${activity.exitCode}`] : []),
    ...(activity.durationMs !== undefined && activity.durationMs >= 1000 ? [duration(activity.durationMs)] : []),
  ];
  return parts.length ? { text: parts.join(' · '), failed } : undefined;
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
  return now - since >= 1000 ? <span class="activity-outcome">{duration(now - since)}</span> : null;
}

function ActivityRow({ activity, workspace, userIndex }: { activity: Activity; workspace?: string; userIndex?: number }): JSX.Element {
  const id = rowId(activity);
  const [open, setOpenState] = useState(openRows.has(id));
  const setOpen = (value: boolean): void => { if (value) openRows.add(id); else openRows.delete(id); setOpenState(value); };
  const status = activity.kind === 'tool-start' ? 'running' : activity.kind === 'tool-error' ? 'error' : 'done';
  // An edit shows its change (the edit IS the lines); anything else folds
  // its output away until asked, as Claude Code's rows do.
  const hasMore = Boolean(activity.output?.length || (activity.diff && diffPreview(activity.diff, DIFF_PREVIEW_LINES).hiddenLines));
  const outcome = activityOutcome(activity);
  const totals = activity.diff?.length ? diffTotals(activity.diff) : undefined;
  const change = (action: 'view' | 'revert') => (event: MouseEvent): void => {
    event.stopPropagation();
    post({ type: 'change', action, key: activity.key, ...(userIndex === undefined ? {} : { userIndex }) });
  };
  return (
    <div class={`activity ${status}`}>
      <div class="activity-line">
        <span class="activity-status" aria-label={status}>
          {status === 'running' ? <Icon name="loading" spin /> : status === 'error' ? <Icon name="error" /> : <Icon name={activityIcon(activity)} />}
        </span>
        <ActivityLabel label={activity.label} workspace={workspace} />
        {totals ? <span class="activity-counts"><Counts additions={totals.additions} removals={totals.removals} /></span> : null}
        {status === 'running' && activity.startedAt ? <Clock since={activity.startedAt} /> : null}
        {outcome ? <span class={`activity-outcome${outcome.failed ? ' failed' : ''}`}>{outcome.text}</span> : null}
        {activity.diff?.length && status !== 'running' ? (
          <span class="row-actions">
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
      {status === 'running' && activity.child ? <div class="activity-child" title={activity.child}><Icon name="arrow-small-right" /><span>{activity.child}</span></div> : null}
      {/* A running call shows what it has printed so far, newest last -- a
          long build is visibly working instead of a bare timer. */}
      {status === 'running' && !open && activity.output?.length ? <OutputView activity={{ ...activity, outputTail: true }} budget={LIVE_OUTPUT_LINES} /> : null}
      {activity.diff?.length ? <DiffView files={activity.diff} budget={open ? undefined : status === 'running' ? 0 : DIFF_PREVIEW_LINES} /> : null}
      {open && activity.output?.length ? <OutputView activity={activity} budget={Number.MAX_SAFE_INTEGER} /> : null}
    </div>
  );
}

/** A finished turn's steps, folded to one line above its answer. */
const TraceRow = memo(({ trace, workspace }: { trace: TurnTrace; workspace?: string }): JSX.Element => {
  const [open, setOpen] = useState(false);
  const tools = trace.activities.filter((activity) => activity.kind !== 'thinking');
  const failed = tools.filter((activity) => activity.kind === 'tool-error').length;
  const totals = diffTotals(tools.flatMap((activity) => activity.diff ?? []));
  const label = tools.length ? `${tools.length} step${tools.length === 1 ? '' : 's'}` : `Thought for ${duration(trace.endedAt - trace.startedAt)}`;
  return (
    <div class="trace">
      <button type="button" class="trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>{label}</span>
        <span class="muted">{tools.length ? ` · ${duration(trace.endedAt - trace.startedAt)}` : ''}{failed ? ` · ${failed} failed` : ''}</span>
        {totals.additions || totals.removals ? <span class="activity-counts"><Counts additions={totals.additions} removals={totals.removals} /></span> : null}
      </button>
      {open ? (
        <div class="activities">
          {trace.reasoning?.length ? <Reasoning thoughts={trace.reasoning} /> : null}
          {tools.map((activity) => <ActivityRow key={activity.key} activity={activity} workspace={workspace} userIndex={trace.userIndex} />)}
        </div>
      ) : null}
    </div>
  );
});

/** A turn's reasoning, each thought its own paragraph. */
function Reasoning({ thoughts }: { thoughts: readonly string[] }): JSX.Element {
  return <div class="reasoning" aria-label="Reasoning">{thoughts.map((thought, index) => <p key={index}>{thought}</p>)}</div>;
}

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
function Plan({ plan }: { plan: ChatModel['plan'] }): JSX.Element {
  const [all, setAll] = useState(false);
  const { visible, done, hidden } = planWindow(plan);
  const rows = all ? plan.map((entry, index) => ({ entry, index })) : visible;
  return (
    <div class="plan-card" aria-label="Plan">
      <div class="plan-head"><Icon name="checklist" /><span>Plan</span><span class="muted">{done}/{plan.length}</span></div>
      {rows.map(({ entry, index }) => (
        <div key={index} class={`plan-entry ${entry.status ?? ''}`}>
          <Icon name={entry.status === 'completed' ? 'pass-filled' : entry.status === 'cancelled' ? 'circle-slash' : entry.status === 'in_progress' ? 'circle-large-filled' : 'circle-large'} />
          <span>{entry.content}</span>
        </div>
      ))}
      {hidden && !all ? <button type="button" class="more-steps" onClick={() => setAll(true)}><Icon name="ellipsis" /> {hidden} more step{hidden === 1 ? '' : 's'}</button> : null}
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

const VISIBLE_ACTIVITIES = 6;
/** Lines of a proposed change an approval shows, as in the terminal. */
const APPROVAL_DIFF_LINES = 8;
/** Silence this long reads as a stall, not as work. */
const STALL_MS = 30_000;

/** The working line: what the turn is doing, how long it has run, and a
 * stall named as one. Ticks on its own, once a second. */
function Working({ live, elsewhere }: { live: Live | undefined; elsewhere: boolean }): JSX.Element {
  const now = useNow();
  const label = live?.phase ?? live?.waitingLabel ?? 'starting';
  const quiet = live ? now - (live.lastEventAt ?? live.startedAt) : 0;
  const toolRunning = live?.activities.some((activity) => activity.kind === 'tool-start');
  return (
    <div class="working" role="status">
      <span class="pulse" aria-hidden="true" />
      <span class="working-label">{titleCase(label.replace(/(…|\.\.\.)$/, ''))}…</span>
      <span class="muted">{live ? duration(now - live.startedAt) : ''}{elsewhere ? ' · running in another window' : ''}</span>
      {quiet >= STALL_MS ? <span class="stalled" title="Nothing has arrived from the agent for a while"><Icon name="warning" /> {toolRunning ? 'no output' : 'no response'} for {duration(quiet)}</span> : null}
      <span class="muted working-hint">Esc to stop</span>
    </div>
  );
}

/** The thought being had, on one line as in the terminal; open, the whole
 * of this turn's reasoning so far. */
function LiveThought({ live }: { live: Live }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!live.thought) return null;
  return (
    <div class={`thought${open ? ' open' : ''}`}>
      <button type="button" class="thought-toggle" aria-expanded={open} title={open ? 'Hide reasoning' : 'Show reasoning'} onClick={() => setOpen(!open)}>
        <Icon name="lightbulb" /><span class="thought-text">{live.thought.text}</span>
      </button>
      {open ? <Reasoning thoughts={[...live.reasoning, live.thought.text]} /> : null}
    </div>
  );
}

const LiveTurn = memo(({ live, workspace, elsewhere }: { live: Live | undefined; workspace?: string; elsewhere: boolean }): JSX.Element => {
  const [showAll, setShowAll] = useState(false);
  const activities = live?.activities ?? [];
  const hidden = showAll ? 0 : Math.max(0, activities.length - VISIBLE_ACTIVITIES);
  return (
    <div class="message assistant live" aria-busy="true">
      {activities.length ? (
        <div class="activities">
          {hidden ? <button type="button" class="more-steps" onClick={() => setShowAll(true)}><Icon name="ellipsis" /> {hidden} earlier step{hidden === 1 ? '' : 's'}</button> : null}
          {activities.slice(hidden).map((activity) => <ActivityRow key={activity.key} activity={activity} workspace={workspace} />)}
        </div>
      ) : null}
      {live?.text ? <LiveMarkdown key={live.startedAt} text={live.text} /> : null}
      {live ? <LiveThought live={live} /> : null}
      <Working live={live} elsewhere={elsewhere} />
    </div>
  );
});

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
      if (trace) parts.push(<TraceRow key={`t${index}`} trace={trace} workspace={workspace} />);
      parts.push(<AssistantMessage key={`m${index}`} cacheKey={`${sessionId}#${index}`} text={message.content} />);
    }
    notesAt(index + 1);
  });
  notes.forEach((note, position) => { if (note.after > messages.length) parts.push(<NoteView key={`n${position}`} note={note} />); });
  return <>{parts}</>;
});

export function Transcript({ model }: { model: ChatModel }): JSX.Element {
  const parts: JSX.Element[] = [];
  if (model.pendingPrompt) parts.push(<UserMessage key="pending" text={model.pendingPrompt} />);
  if (model.plan.length) parts.push(<Plan key="plan" plan={model.plan} />);
  if (model.running) parts.push(<LiveTurn key="live" live={model.live} workspace={model.workspace} elsewhere={!model.ownTurn} />);
  const queuedTexts = new Set(model.queued.map((item) => item.text));
  for (const submission of model.submissions) {
    // A queued message is drawn once, from the stored queue under the composer.
    if (submission.disposition === 'queued' || (!submission.disposition && queuedTexts.has(submission.text))) continue;
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
  useEffect(() => { const timer = setTimeout(() => setGuarded(false), 400); return () => clearTimeout(timer); }, []);
  const onKey = (event: KeyboardEvent): void => {
    if ((event.target as HTMLElement).tagName === 'TEXTAREA' || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key === 'Escape' ? '\u001b' : event.key === 'Enter' ? '\r' : event.key === 'Tab' ? '\t' : event.key;
    const action = approvalKeyAction(key, Date.now() - shownAt.current, false, true, Boolean(approval.rule));
    if (action === 'ignore' || action === 'focus') { if (key.length === 1) event.preventDefault(); return; }
    event.preventDefault();
    event.stopPropagation();
    onAnswer(action === 'allow' ? true : action === 'always' ? 'always' : false);
  };
  const answer = (value: boolean | 'always') => (): void => { if (Date.now() - shownAt.current >= 400) onAnswer(value); };
  return (
    <div class={`approval${guarded ? ' guarded' : ''}`} role="alertdialog" aria-label={`Approval: ${approval.title}`} tabIndex={0} onKeyDown={onKey} data-approval={approval.id}>
      <div class="approval-head"><Icon name="shield" /><span class="approval-title">{relative(approval.title, workspace)}</span>{waiting ? <span class="muted">+{waiting} waiting</span> : null}</div>
      {approval.detail ? <pre class="approval-detail">{relative(approval.detail, workspace)}</pre> : null}
      {approval.diff?.length ? <DiffView files={approval.diff} budget={APPROVAL_DIFF_LINES} /> : null}
      {approval.rule ? <div class="approval-rule muted">Always allow remembers <code>{approval.rule}</code></div> : null}
      <div class="approval-actions">
        <button type="button" class="primary" data-approve="yes" onClick={answer(true)}>Allow <kbd>y</kbd></button>
        {approval.rule ? <button type="button" class="secondary" data-approve="always" title={`Always allow: ${approval.rule}`} onClick={answer('always')}>Always allow <kbd>a</kbd></button> : null}
        <button type="button" class="secondary" data-approve="no" title="Deny (n, Enter or Esc)" onClick={answer(false)}>Deny <kbd>n</kbd></button>
        {approval.diff?.length ? <button type="button" class="link" onClick={() => post({ type: 'viewDiff', id: approval.id })}><Icon name="diff" /> Open in diff editor</button> : null}
      </div>
    </div>
  );
}
