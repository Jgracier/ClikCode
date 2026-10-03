/** The conversations list, dropped from the header's history button. */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatModel } from '../model';
import type { ListedConversation } from '../webview-protocol';
import { listen, request } from './bus';
import { relativeTime } from './format';
import { choose } from './picker';
import { Icon, IconButton, KeyList, Popover, type ListRow } from './ui';

type Section = NonNullable<ListedConversation['section']>;
/** The terminal board's sections, in its order (session/conversation-rows.ts). */
const SECTIONS: ReadonlyArray<[Section, string]> = [['working', 'Working'], ['active', 'Active'], ['past', 'Past']];
const ACTIVE_WITHIN_MS = 24 * 60 * 60 * 1000;
/** Re-query while generating when ClikCode has not reported a change. */
const FALLBACK_POLL_MS = 10_000;

/** The row's section as ClikCode decided it; a bridge from before `section`
 * gets the same rule here (generating, else the last 24 hours, else Past). */
export function conversationSection(row: ListedConversation, now = Date.now()): Section {
  if (row.section) return row.section;
  if (row.activity === 'working') return 'working';
  const at = Date.parse(row.updatedAt);
  return !Number.isNaN(at) && now - at < ACTIVE_WITHIN_MS ? 'active' : 'past';
}

/** The conversations, as a list dropped from the header's history button:
 * search, then Working, Active and Past, as the terminal's board lists them. Rename, open in a tab and
 * delete are on each row; the rest (fork, archive) are slash commands. */
export function HistoryMenu(props: { model: ChatModel; onClose: () => void; onError: (message: string) => void }): JSX.Element {
  const [rows, setRows] = useState<ListedConversation[]>();
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const load = (): void => {
    request<ListedConversation[]>({ method: 'query', query: 'conversations' }).then(setRows, (failure: Error) => props.onError(failure.message));
  };
  useEffect(() => { load(); input.current?.focus(); }, []);
  // ClikCode watches its state and says when a turn starts or ends, so a
  // pulse stops when its chat finishes. A slow poll covers a ClikCode that
  // does not say (older, or no watch possible): only while a chat is
  // generating and nothing has been heard for a while.
  const heardAt = useRef(0);
  useEffect(() => {
    const stop = listen((message) => {
      if (message.type !== 'conversations-changed') return;
      heardAt.current = Date.now();
      load();
    });
    void request({ method: 'watchConversations', on: true }).catch(() => undefined);
    return () => {
      stop();
      void request({ method: 'watchConversations', on: false }).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (!rows?.some((row) => row.activity === 'working')) return;
    const timer = setInterval(() => { if (Date.now() - heardAt.current >= FALLBACK_POLL_MS) load(); }, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [rows]);

  const open = (row: ListedConversation): void => {
    props.onClose();
    if (!row.current) request({ method: 'open', mode: 'resume', sessionId: row.id }).catch((failure: Error) => props.onError(failure.message));
  };
  const act = (row: ListedConversation, action: 'rename' | 'delete', name?: string): void => {
    setConfirming(undefined);
    choose({ kind: 'conversation', sessionId: row.id, action, ...(name ? { name } : {}) }).then(load, (failure: Error) => props.onError(failure.message));
  };

  const query = search.trim().toLowerCase();
  const listRows = useMemo((): ListRow[] => {
    // The chat on screen is listed once it is a conversation, not while empty.
    const matching = (rows ?? []).filter((row) => !(row.current && !row.messages))
      .filter((row) => !query || `${row.title} ${row.preview ?? ''} ${row.provider ?? ''}`.toLowerCase().includes(query));
    const sections: Array<[string, ListedConversation[]]> = SECTIONS.map(([section, title]) => [title, matching.filter((row) => conversationSection(row) === section)]);
    const result: ListRow[] = [];
    for (const [title, items] of sections) {
      if (!items.length) continue;
      result.push({ key: `h:${title}`, heading: true, render: () => <>{title}</> });
      for (const row of items) {
        result.push({
          key: row.id,
          onSelect: () => (renaming === row.id ? undefined : open(row)),
          render: () => (
            <div class={`conversation${row.current ? ' current' : ''}`} title={row.preview}>
              {row.attention === 'waiting' ? <Icon name="bell-dot" label="waiting for your answer" />
                : row.activity === 'working' ? <span class="conversation-dot working" aria-label="working" />
                  : row.current ? <Icon name="check" label="this chat" />
                    : row.attention === 'unread' ? <span class="conversation-dot unread" aria-label="finished" /> : <span class="conversation-dot" aria-hidden="true" />}
              <div class="conversation-main">
                {renaming === row.id ? (
                  <form data-row-action onSubmit={(event) => {
                    event.preventDefault();
                    const value = ((event.currentTarget as HTMLFormElement).elements.namedItem('name') as HTMLInputElement).value;
                    setRenaming(undefined);
                    if (value.trim()) act(row, 'rename', value.trim());
                  }}>
                    <input name="name" class="rename" defaultValue={row.title} aria-label="Conversation name" ref={(element) => element?.focus()}
                      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(undefined); } }} />
                  </form>
                ) : <div class="conversation-title">{row.title}</div>}
              </div>
              <span class="conversation-meta">{[row.provider, relativeTime(row.updatedAt)].filter(Boolean).join(' · ')}</span>
              <div class="row-actions" data-row-action>
                <IconButton icon="link-external" label="Open in new tab" onClick={() => { props.onClose(); void request({ method: 'openInTab', sessionId: row.id }); }} />
                <IconButton icon="edit" label="Rename" onClick={() => setRenaming(row.id)} />
                {confirming === row.id
                  ? <button type="button" class="danger small" onClick={() => act(row, 'delete')}>Delete</button>
                  : <IconButton icon="trash" label="Delete" onClick={() => setConfirming(row.id)} />}
              </div>
            </div>
          ),
        });
      }
    }
    return result;
  }, [rows, query, renaming, confirming]);

  return (
    <Popover label="Conversations" onClose={props.onClose} class="picker history-menu" id="history-menu">
      <div class="search">
        <Icon name="search" />
        <input ref={input} type="text" value={search} placeholder="Search conversations…" aria-label="Search conversations"
          aria-controls="history-list" onInput={(event) => setSearch((event.target as HTMLInputElement).value)} />
      </div>
      {!rows ? <div class="picker-loading"><Icon name="loading" spin /> Loading…</div> : null}
      <KeyList id="history-list" rows={listRows} label="Conversations" inputRef={input} onEscape={props.onClose}
        emptyText={rows ? (query ? 'No conversation matches.' : 'No conversations yet.') : undefined} />
    </Popover>
  );
}
