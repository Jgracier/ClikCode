/** A subagent's recorded work and its own message entry, on live and past rows. */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { SubAgentRow } from '../../../../src/harness/subagent-read';
import { request } from './bus';
import { Icon } from './ui';
import { renderMarkdown } from './markdown';
import { withoutOtherOrgThinkingNotice } from '../../../../src/harness/protocol/claude-thinking-notice';
import { freshLive, upsertActivity } from '../model/activity';
import type { Activity } from '../model';
import { ActivityRow } from './activity-rows';

type Group = { kind: 'prompt' | 'text'; text: string } | { kind: 'activities'; items: Activity[] };

/** The rows as the main chat draws a turn: prose as markdown, and a run of calls as ordinary activity
 * rows (their verb, result and output preview), not a raw dump of each call's text. */
function groups(rows: SubAgentRow[]): Group[] {
  const out: Group[] = [];
  let live = freshLive('');
  const flush = (): void => {
    if (live.activities.length) out.push({ kind: 'activities', items: live.activities });
    live = freshLive('');
  };
  for (const row of rows) {
    if (row.kind === 'activity') { live = upsertActivity(live, row.event); continue; }
    flush();
    out.push({ kind: row.kind, text: row.text });
  }
  flush();
  return out;
}

/** What the agent was asked: two lines, the rest a click away -- it is context, not the answer. */
function Prompt({ text }: { text: string }): JSX.Element {
  const [full, setFull] = useState(false);
  const long = text.length > 240 || text.split('\n').length > 2;
  return <div class={`subagent-prompt muted${full ? ' full' : ''}`}>
    <div class="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(withoutOtherOrgThinkingNotice(text)) }} />
    {long ? <button type="button" class="link-button" onClick={() => setFull(!full)}>{full ? 'Show less' : 'Show the full prompt'}</button> : null}
  </div>;
}

interface View { rows: SubAgentRow[]; steer: 'direct' | 'relay' | 'none' }

/** The expanded view: what the subagent did, and a field to message it. `onClose` runs on Escape. */
export function SubagentBody({ parentId, agentId, label, running, onClose }: { parentId: string; agentId?: string; label: string; running: boolean; onClose: () => void }): JSX.Element {
  const [view, setView] = useState<View>({ rows: [], steer: 'none' });
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // Follows the latest while the reader is at the end; a scroll up to read stays put.
  const following = useRef(true);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && following.current) box.scrollTop = box.scrollHeight;
  }, [view]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const answer = await request<View>({ method: 'subagent', action: 'read', parentId });
        if (active) setView(answer);
      } catch (error) { if (active) setNotice(error instanceof Error ? error.message : 'Could not read this subagent.'); }
      if (active && running) timer = setTimeout(() => { void read(); }, 1500);
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [parentId, running]);
  return (
    <section class="subagent-view" aria-label={label} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <div class="subagent-view-rows" ref={scroller} onScroll={(event) => { const box = event.currentTarget; following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24; }}>
        {view.rows.length ? groups(view.rows).map((group, index) => group.kind === 'activities'
          ? <div key={index} class="activities">{group.items.map((item) => <ActivityRow key={item.key} activity={item} />)}</div>
          : group.kind === 'prompt' ? <Prompt key={index} text={group.text} />
          : <div key={index} class="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(withoutOtherOrgThinkingNotice(group.text)) }} />)
          : <p class="muted">No recorded child messages or tool calls.</p>}
      </div>
      {running && view.steer !== 'none' ? <form onSubmit={(event) => {
        event.preventDefault();
        if (!draft.trim() || sending) return;
        const text = draft;
        setSending(true);
        void request({ method: 'subagent', action: 'steer', parentId, agentId, text }).then(() => {
          setDraft(''); setNotice(view.steer === 'relay' ? 'Sent through the main agent.' : 'Sent to the subagent.');
        }, (error: unknown) => setNotice(error instanceof Error ? error.message : 'Not sent.')).finally(() => setSending(false));
      }}><input aria-label="Message this subagent" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} placeholder={view.steer === 'relay' ? 'Message through the main agent…' : 'Message this subagent…'} /><button type="submit" disabled={sending || !draft.trim()}>Send</button></form>
        : <p class="muted">{running ? 'This harness does not support messaging this subagent.' : 'Finished · read-only'}</p>}
      {notice ? <p role="status" class="muted">{notice}</p> : null}
    </section>
  );
}

/** The standalone form, for a finished agent's row: a chevron that opens the same view beneath it. */
export function SubagentPanel(props: { parentId: string; agentId?: string; label: string; running: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" class="icon-button tiny" aria-label={open ? 'Hide subagent' : `View ${props.label}`} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? 'chevron-up' : 'chevron-down'} /></button>
    {open ? <SubagentBody {...props} onClose={() => setOpen(false)} /> : null}
  </>;
}
