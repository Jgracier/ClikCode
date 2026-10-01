/** The conversations list, dropped from the header's history button. */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatModel } from '../model';
import type { ListedConversation } from '../webview-protocol';
import { request } from './bus';
import { relativeTime } from './format';
import { choose } from './picker';
import { Icon, IconButton, KeyList, Popover, type ListRow } from './ui';

/** The conversations, as a list dropped from the header's history button:
 * search, then this chat's recent ones by day. Rename, open in a tab and
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
  // While a chat is generating, re-query so its pulse stops when it finishes.
  useEffect(() => {
    if (!rows?.some((row) => row.activity === 'working')) return;
    const timer = setInterval(load, 2_000);
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
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const day = 24 * 60 * 60 * 1000;
    const at = (row: ListedConversation): number => Date.parse(row.updatedAt) || 0;
    const sections: Array<[string, ListedConversation[]]> = [
      ['Working', matching.filter((row) => row.activity === 'working')],
      ['Today', matching.filter((row) => row.activity !== 'working' && at(row) >= startOfToday)],
      ['Previous 7 days', matching.filter((row) => row.activity !== 'working' && at(row) < startOfToday && at(row) >= startOfToday - 7 * day)],
      ['Older', matching.filter((row) => row.activity !== 'working' && at(row) < startOfToday - 7 * day)],
    ];
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
