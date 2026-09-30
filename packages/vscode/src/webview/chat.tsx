/** The conversation: messages, the running turn, its tool activity, plans,
 * notices and approvals. */
import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Activity, Approval, ChatModel, LiveTurn as Live, Note, TurnTrace } from '../model';
import { post } from './bus';
import { duration, pathIn, titleCase } from './format';
import { createStreamingMarkdown, renderMarkdown } from './markdown';
import { Icon } from './ui';

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

const AssistantMessage = memo(({ cacheKey, text }: { cacheKey: string; text: string }): JSX.Element => (
  <div class="message assistant"><div class="markdown" dangerouslySetInnerHTML={{ __html: renderFinished(cacheKey, text) }} /></div>
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

const UserMessage = memo(({ text }: { text: string }): JSX.Element => <div class="message user"><div class="bubble">{text}</div></div>);

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

function ActivityRow({ activity, workspace }: { activity: Activity; workspace?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const status = activity.kind === 'tool-start' ? 'running' : activity.kind === 'tool-error' ? 'error' : 'done';
  const hasMore = Boolean(activity.output?.length || activity.diff);
  return (
    <div class={`activity ${status}`}>
      <div class="activity-line">
        <span class="activity-status" aria-label={status}>
          {status === 'running' ? <Icon name="loading" spin /> : status === 'error' ? <Icon name="error" /> : <Icon name={activityIcon(activity)} />}
        </span>
        <ActivityLabel label={activity.label} workspace={workspace} />
        {hasMore ? (
          <button type="button" class="icon-button tiny" aria-expanded={open} aria-label={open ? 'Hide output' : 'Show output'} onClick={() => setOpen(!open)}>
            <Icon name={open ? 'chevron-up' : 'chevron-down'} />
          </button>
        ) : null}
      </div>
      {open && activity.diff ? (
        <pre class="activity-output diff">
          {activity.diff.removed.map((line, index) => <div key={`r${index}`} class="del">- {line}</div>)}
          {activity.diff.added.map((line, index) => <div key={`a${index}`} class="add">+ {line}</div>)}
        </pre>
      ) : null}
      {open && activity.output?.length ? <pre class="activity-output">{activity.output.slice(-40).join('\n')}</pre> : null}
    </div>
  );
}

/** A finished turn's steps, folded to one line above its answer. */
const TraceRow = memo(({ trace, workspace }: { trace: TurnTrace; workspace?: string }): JSX.Element => {
  const [open, setOpen] = useState(false);
  const tools = trace.activities.filter((activity) => activity.kind !== 'thinking');
  const failed = tools.filter((activity) => activity.kind === 'tool-error').length;
  return (
    <div class="trace">
      <button type="button" class="trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>{tools.length ? `${tools.length} step${tools.length === 1 ? '' : 's'}` : 'Thought'}</span>
        <span class="muted">· {duration(trace.endedAt - trace.startedAt)}{failed ? ` · ${failed} failed` : ''}</span>
      </button>
      {open ? <div class="activities">{trace.activities.map((activity) => <ActivityRow key={activity.key} activity={activity} workspace={workspace} />)}</div> : null}
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

function Plan({ plan }: { plan: ChatModel['plan'] }): JSX.Element {
  const done = plan.filter((entry) => entry.status === 'completed').length;
  return (
    <div class="plan-card" aria-label="Plan">
      <div class="plan-head"><Icon name="checklist" /><span>Plan</span><span class="muted">{done}/{plan.length}</span></div>
      {plan.map((entry, index) => (
        <div key={index} class={`plan-entry ${entry.status ?? ''}`}>
          <Icon name={entry.status === 'completed' ? 'pass-filled' : entry.status === 'in_progress' ? 'circle-large-filled' : 'circle-large'} />
          <span>{entry.content}</span>
        </div>
      ))}
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
/** Silence this long reads as a stall, not as work. */
const STALL_MS = 30_000;

const LiveTurn = memo(({ live, workspace, elsewhere }: { live: Live | undefined; workspace?: string; elsewhere: boolean }): JSX.Element => {
  const now = useNow();
  const [showAll, setShowAll] = useState(false);
  // Thoughts are one line below, as in the terminal; the rows are tools.
  const activities = live?.activities.filter((activity) => activity.kind !== 'thinking') ?? [];
  const hidden = showAll ? 0 : Math.max(0, activities.length - VISIBLE_ACTIVITIES);
  const label = live?.phase ?? live?.waitingLabel ?? 'starting';
  const quiet = live ? now - (live.lastEventAt ?? live.startedAt) : 0;
  const toolRunning = activities.some((activity) => activity.kind === 'tool-start');
  return (
    <div class="message assistant live" aria-busy="true">
      {activities.length ? (
        <div class="activities">
          {hidden ? <button type="button" class="more-steps" onClick={() => setShowAll(true)}><Icon name="ellipsis" /> {hidden} earlier step{hidden === 1 ? '' : 's'}</button> : null}
          {activities.slice(hidden).map((activity) => <ActivityRow key={activity.key} activity={activity} workspace={workspace} />)}
        </div>
      ) : null}
      {live?.text ? <LiveMarkdown key={live.startedAt} text={live.text} /> : null}
      {live?.thought ? <div class="thought" title={live.thought}><Icon name="lightbulb" /><span>{live.thought}</span></div> : null}
      <div class="working" role="status">
        <span class="pulse" aria-hidden="true" />
        <span class="working-label">{titleCase(label.replace(/(…|\.\.\.)$/, ''))}…</span>
        <span class="muted">{live ? duration(now - live.startedAt) : ''}{elsewhere ? ' · running in another window' : ''}</span>
        {quiet >= STALL_MS ? <span class="stalled" title="Nothing has arrived from the agent for a while"><Icon name="warning" /> {toolRunning ? 'no output' : 'no response'} for {duration(quiet)}</span> : null}
        <span class="muted working-hint">Esc to stop</span>
      </div>
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
  if (model.running) parts.push(<LiveTurn key="live" live={model.live} workspace={model.workspace} elsewhere={model.ownTurn === false || (!model.ownTurn && model.running)} />);
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

/** A proposed change's text with its added and removed lines coloured. */
function diffLines(text: string): JSX.Element[] {
  return text.split('\n').map((line, index) => {
    const kind = /^\+(?!\+\+)/.test(line) ? 'add' : /^-(?!--)/.test(line) ? 'del' : /^@@/.test(line) ? 'hunk' : '';
    return <div key={index} class={kind}>{line || ' '}</div>;
  });
}

export function ApprovalCard({ approval, workspace, onAnswer }: { approval: Approval; workspace?: string; onAnswer: (value: boolean | 'always') => void }): JSX.Element {
  const onKey = (event: KeyboardEvent): void => {
    if ((event.target as HTMLElement).tagName === 'TEXTAREA') return;
    if (event.key === '1') onAnswer(true);
    else if (event.key === '2' && approval.rule) onAnswer('always');
    else if (event.key === '3' || event.key === 'Escape') onAnswer(false);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div class="approval" role="alertdialog" aria-label={`Approval: ${approval.title}`} tabIndex={0} onKeyDown={onKey} data-approval={approval.id}>
      <div class="approval-head"><Icon name="shield" /><span class="approval-title">{relative(approval.title, workspace)}</span></div>
      {approval.detail ? <pre class="approval-detail">{approval.hasDiff ? diffLines(relative(approval.detail, workspace)) : relative(approval.detail, workspace)}</pre> : null}
      <div class="approval-actions">
        <button type="button" class="primary" data-approve="yes" onClick={() => onAnswer(true)}>Allow <kbd>1</kbd></button>
        {approval.rule ? <button type="button" class="secondary" data-approve="always" title={`Always allow: ${approval.rule}`} onClick={() => onAnswer('always')}>Always allow <kbd>2</kbd></button> : null}
        <button type="button" class="secondary" data-approve="no" title="Reject (3 or Esc)" onClick={() => onAnswer(false)}>Reject <kbd>3</kbd></button>
        {approval.hasDiff ? <button type="button" class="link" onClick={() => post({ type: 'viewDiff', id: approval.id })}><Icon name="diff" /> Open diff</button> : null}
      </div>
    </div>
  );
}
