/** A subagent's recorded work and its own message entry, on live and past rows. */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { SubAgentRow } from '../../../../src/harness/subagent-read';
import { request } from './bus';
import { Icon } from './ui';
import { renderMarkdown } from './markdown';

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
      <div class="subagent-view-rows" ref={scroller} onScroll={(event) => { const box = event.currentTarget; following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24; }}>{view.rows.length ? view.rows.map((row, index) => row.kind === 'activity'
        ? <pre key={index}>{row.event.label}{row.event.output?.length ? `\n${row.event.output.join('\n')}` : ''}</pre>
        : <div key={index} class={row.kind === 'prompt' ? 'markdown muted' : 'markdown'} dangerouslySetInnerHTML={{ __html: renderMarkdown(row.text) }} />) : <p class="muted">No recorded child messages or tool calls.</p>}</div>
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
