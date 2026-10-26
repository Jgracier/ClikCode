/** A subagent's recorded work and its own message entry, on live and past rows. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { SubAgentRow } from '../../../../src/harness/subagent-read';
import { request } from './bus';
import { Icon } from './ui';

interface View { rows: SubAgentRow[]; steer: 'direct' | 'relay' | 'none' }

export function SubagentPanel({ parentId, agentId, label, running }: { parentId: string; agentId?: string; label: string; running: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ rows: [], steer: 'none' });
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
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
  }, [open, parentId, running]);
  const close = (): void => { setOpen(false); toggle.current?.focus(); };
  return <>
    <button ref={toggle} type="button" class="icon-button tiny" aria-label={`View ${label}`} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="open-preview" /></button>
    {open ? <section class="subagent-view" aria-label={label} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <div class="subagent-view-heading"><strong>{label}</strong><button type="button" class="icon-button tiny" aria-label="Close subagent view" onClick={close}><Icon name="close" /></button></div>
      <div class="subagent-view-rows">{view.rows.length ? view.rows.map((row, index) => row.kind === 'activity'
        ? <pre key={index}>{row.event.label}{row.event.output?.length ? `\n${row.event.output.join('\n')}` : ''}</pre>
        : <p key={index} class={row.kind === 'prompt' ? 'muted' : undefined}>{row.text}</p>) : <p class="muted">No recorded child messages or tool calls.</p>}</div>
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
    </section> : null}
  </>;
}
