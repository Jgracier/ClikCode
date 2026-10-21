/** The conversations list, dropped from the header's history button. */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatModel } from '../model';
import type { ListedConversation } from '../webview-protocol';
import type { ListedMachine } from '../remote-directory';
import { machineMeta, offersUpdate } from './machine-text';
import { listen, request } from './bus';
import { useNow } from './clock';
import { conversationState, SECTION_TITLES, type ConversationSection } from '../../../../src/session/conversation-state';
import { choose } from './picker';
import { Icon, IconButton, KeyList, Loading, Popover, type ListRow } from './ui';

type Section = ConversationSection;
/** The terminal board's sections, in its order and words (session/conversation-state.ts). */
const SECTIONS = (['working', 'active', 'past'] as const).map((section): [Section, string] => [section, SECTION_TITLES[section]]);
const ACTIVE_WITHIN_MS = 24 * 60 * 60 * 1000;
let lastHistoryMachine = 'local';
const lastHistoryChat = new Map<string, string>();

/** The row's section as ClikCode decided it; a bridge from before `section`
 * gets the same rule here (generating, else the last 24 hours, else Past). */
export function conversationSection(row: ListedConversation, now = Date.now()): Section {
  if (row.section) return row.section;
  if (row.activity === 'working') return 'working';
  const at = Date.parse(row.updatedAt);
  return !Number.isNaN(at) && now - at < ACTIVE_WITHIN_MS ? 'active' : 'past';
}

/** A row's one state, by the terminal's rule. An approval VS Code is showing
 * in one of its own panels (`attention`) needs the user as much as one the
 * worker recorded. A bridge from before `turn` still says it is working. */
export function rowState(row: ListedConversation, now = Date.now()): ReturnType<typeof conversationState> {
  const turn = row.turn ?? (row.activity === 'working' ? { startedAt: '', activeAt: '' } : undefined);
  return conversationState({
    updatedAt: row.updatedAt,
    ...(turn ? { turn } : {}),
    ...(row.needsYou || row.attention === 'waiting' ? { needsYou: true } : {}),
    ...(row.resumeAt ? { resumeAt: row.resumeAt } : {}),
  }, now);
}

/** Lists on this page that want to hear of changes: the bridge's watch is
 * on while any is. The welcome's Recent and the history menu share it --
 * one of them closing must not switch it off under the other. */
let watching = 0;

export function holdConversationWatch(): () => void {
  if (watching++ === 0) void request({ method: 'watchConversations', on: true }).catch(() => undefined);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--watching === 0) void request({ method: 'watchConversations', on: false }).catch(() => undefined);
  };
}

/** The conversation list, kept current: loaded (again whenever `key`
 * changes), reloaded when ClikCode says a turn started or ended, so a
 * pulse stops when its chat finishes. ClikCode says so; there is no poll. */
export function useConversations(onError?: (message: string) => void, key?: unknown, machineId?: string): { rows: ListedConversation[] | undefined; load: () => void } {
  const [rows, setRows] = useState<ListedConversation[]>();
  const load = (): void => {
    request<ListedConversation[]>(machineId ? { method: 'machineConversations', machineId } : { method: 'query', query: 'conversations' })
      .then(setRows, (failure: Error) => onError?.(failure.message));
  };
  useEffect(load, [key]);
  useEffect(() => {
    const stop = listen((message) => {
      if (message.type !== 'conversations-changed') return;
      load();
    });
    const release = holdConversationWatch();
    return () => { stop(); release(); };
  }, []);
  return { rows, load };
}

/** The second a list's rows are read at: the current one while a row
 * works (its time counts up), else fixed -- nothing to redraw. */
export function listSecond(rows: readonly ListedConversation[] | undefined, now: number): number {
  return rows?.some((row) => row.activity === 'working') ? Math.floor(now / 1000) : 0;
}

/** What a row is marked with, by its one state: waiting on you, working
 * (stalled), the chat on screen, finished unseen, or nothing. */
export function conversationMark(row: ListedConversation, state: ReturnType<typeof rowState>): 'needs-you' | 'working' | 'stalled' | 'current' | 'unread' | 'none' {
  if (state.kind === 'needs-you') return 'needs-you';
  if (row.activity === 'working') return state.kind === 'stalled' ? 'stalled' : 'working';
  if (row.current) return 'current';
  return row.attention === 'unread' ? 'unread' : 'none';
}

/** The row's mark, drawn: the history menu's and the welcome's Recent alike. */
export function ConversationMark({ row, state }: { row: ListedConversation; state: ReturnType<typeof rowState> }): JSX.Element {
  const mark = conversationMark(row, state);
  if (mark === 'needs-you') return <Icon name="bell-dot" label="waiting for your answer" />;
  if (mark === 'working' || mark === 'stalled') return <span class={`conversation-dot working${mark === 'stalled' ? ' stalled' : ''}`} aria-label={state.text} />;
  if (mark === 'current') return <Icon name="check" label="this chat" />;
  if (mark === 'unread') return <span class="conversation-dot unread" aria-label="finished" />;
  return <span class="conversation-dot" aria-hidden="true" />;
}

/** The conversations, as a list dropped from the header's history button:
 * search, then Working, Recent and Older, as the terminal's board lists them.
 * Each row is its title, its one state and, dim under it, the last thing
 * asked -- the terminal's three parts. Rename, open in a tab and
 * delete are on each row; the rest (fork, archive) are slash commands. */
export function HistoryMenu(props: { model: ChatModel; onClose: () => void; onError: (message: string) => void; initialScreen?: 'chats' | 'machines' }): JSX.Element {
  const { rows: localRows, load } = useConversations(props.onError, undefined, 'local');
  const [machineId, setMachineId] = useState(props.model.machineId ?? (props.initialScreen === 'machines' ? 'local' : lastHistoryMachine));
  const [showMachines, setShowMachines] = useState(props.initialScreen === 'machines');
  const [machines, setMachines] = useState<ListedMachine[]>();
  const [remoteRows, setRemoteRows] = useState<ListedConversation[]>();
  const rows = machineId === 'local' ? localRows : remoteRows;
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (showMachines) document.getElementById('machines-list')?.focus();
    else input.current?.focus();
  }, [showMachines]);
  useEffect(() => {
    let active = true;
    if (machineId !== 'local') setRemoteRows(undefined);
    const refresh = (): void => {
      void request<ListedMachine[]>({ method: 'machines' }).then((next) => { if (active) setMachines(next); }, (error: Error) => { if (active) props.onError(error.message); });
      if (machineId !== 'local') void request<ListedConversation[]>({ method: 'machineConversations', machineId }).then(
        (next) => { if (active) setRemoteRows(next); }, (error: Error) => { if (active) props.onError(error.message); },
      );
    };
    refresh();
    const stop = listen((message) => { if (message.type === 'conversations-changed') refresh(); });
    return () => { active = false; stop(); };
  }, [machineId]);

  const open = (row: ListedConversation): void => {
    lastHistoryChat.set(machineId, row.id);
    props.onClose();
    if (machineId !== 'local') {
      void request({ method: 'openOnMachine', machineId, mode: 'resume', sessionId: row.id }).catch((failure: Error) => props.onError(failure.message));
    } else if (!row.current || props.model.sessionId !== row.id) void request({ method: 'openOnMachine', machineId, mode: 'resume', sessionId: row.id }).catch((failure: Error) => props.onError(failure.message));
  };
  const act = (row: ListedConversation, action: 'rename' | 'delete', name?: string): void => {
    setConfirming(undefined);
    choose({ kind: 'conversation', sessionId: row.id, action, ...(name ? { name } : {}) }).then(load, (failure: Error) => props.onError(failure.message));
  };

  const query = search.trim().toLowerCase();
  // A working row's "working 3m" counts up and can turn "stalled": the rows
  // are rebuilt each second while one works, and only then.
  const now = useNow(Boolean(rows?.some((row) => row.activity === 'working')));
  const second = listSecond(rows, now);
  const listRows = useMemo((): ListRow[] => {
    // The chat on screen is listed once it is a conversation, not while empty.
    const matching = (rows ?? []).filter((row) => !(row.current && !row.messages))
      .filter((row) => !query || `${row.title} ${row.preview ?? ''} ${row.provider ?? ''}`.toLowerCase().includes(query));
    // Within a section one that needs you comes first, as on the terminal's
    // board; ClikCode's order otherwise (the sort is stable).
    const needsYouFirst = (left: ListedConversation, right: ListedConversation): number => Number(rowState(right, now).kind === 'needs-you') - Number(rowState(left, now).kind === 'needs-you');
    const sections: Array<[string, ListedConversation[]]> = SECTIONS.map(([section, title]) => [title, matching.filter((row) => conversationSection(row) === section).sort(needsYouFirst)]);
    const result: ListRow[] = [];
    for (const [title, items] of sections) {
      if (!items.length) continue;
      result.push({ key: `h:${title}`, heading: true, render: () => <>{title}</> });
      for (const row of items) {
        const state = rowState(row, now);
        result.push({
          key: row.id,
          onSelect: () => (renaming === row.id ? undefined : open(row)),
          render: () => (
            <div class={`conversation${row.current ? ' current' : ''}`} title={row.preview}>
              <ConversationMark row={row} state={state} />
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
                {row.preview && renaming !== row.id ? <div class="conversation-preview">{row.preview}</div> : null}
              </div>
              <span class="conversation-meta">{row.movedTo ? `moved to ${row.movedTo}` : state.text}</span>
              {machineId === 'local' ? <div class="row-actions" data-row-action>
                <IconButton icon="link-external" label="Open in new tab" onClick={() => { props.onClose(); void request({ method: 'openInTab', sessionId: row.id }); }} />
                <IconButton icon="edit" label="Rename" onClick={() => setRenaming(row.id)} />
                {confirming === row.id
                  ? <button type="button" class="danger small" onClick={() => act(row, 'delete')}>Delete</button>
                  : <IconButton icon="trash" label="Delete" onClick={() => setConfirming(row.id)} />}
              </div> : null}
            </div>
          ),
        });
      }
    }
    return result;
  }, [rows, query, renaming, confirming, second]);

  const machineRows: ListRow[] = (machines ?? []).map((machine) => ({
    key: machine.id,
    onSelect: () => { lastHistoryMachine = machine.id; setMachineId(machine.id); setShowMachines(false); setSearch(''); },
    render: () => <div class="conversation" title={machine.updateError}><div class="conversation-main"><div class="conversation-title">{machine.name}</div></div>
      <span class="conversation-meta">{machineMeta(machine, '')}</span></div>,
  }));

  return (
    <Popover label={showMachines ? 'Machines' : 'Conversations'} onClose={props.onClose} class="picker history-menu" id="history-menu">
      <button type="button" class="link small" onClick={() => setShowMachines((value) => !value)}>
        {showMachines ? '← Chats' : `← Machines · ${machines?.find((item) => item.id === machineId)?.name ?? 'This machine'}`}
      </button>
      {!showMachines ? <div class="search">
        <Icon name="search" />
        <input ref={input} type="text" value={search} placeholder="Search conversations…" aria-label="Search conversations"
          aria-controls="history-list" onInput={(event) => setSearch((event.target as HTMLInputElement).value)} />
      </div> : null}
      <Loading waiting={showMachines ? !machines : !rows}>Loading…</Loading>
      {showMachines
        ? <KeyList id="machines-list" rows={machineRows} label="Machines" initialKey={machineId} onEscape={() => setShowMachines(false)} onBack={() => setShowMachines(false)} rightSelect />
        : <KeyList id="history-list" rows={listRows} label="Conversations" inputRef={input} onEscape={props.onClose}
          onBack={() => setShowMachines(true)} initialKey={lastHistoryChat.get(machineId) ?? (machineId === 'local' ? props.model.sessionId : undefined)} rightSelect
          emptyText={rows ? (query ? 'No conversation matches.' : 'No conversations yet.') : undefined} />}
    </Popover>
  );
}

/** The composer's machine chip: the machine is one of this chat's settings,
 * like its provider, so choosing another moves THIS chat there (an empty one
 * is simply a new chat there). Browsing a machine's chats is the history
 * menu's. A Tailscale machine not added yet is installed first. */
export function MachineMenu(props: { model: ChatModel; onClose: () => void; onError: (message: string) => void }): JSX.Element {
  const [machines, setMachines] = useState<ListedMachine[]>();
  const [switching, setSwitching] = useState(false);
  const empty = !props.model.messages.length && !props.model.pendingPrompt;
  useEffect(() => {
    let active = true;
    const load = (): void => {
      void request<ListedMachine[]>({ method: 'machines', discover: true }).then(
        (next) => { if (active) setMachines(next); },
        (error: Error) => { if (active) props.onError(error.message); },
      );
    };
    load();
    const stop = listen((message) => { if (message.type === 'conversations-changed') load(); });
    const release = holdConversationWatch();
    return () => { active = false; stop(); release(); };
  }, []);

  const select = (machine: ListedMachine): void => {
    if (switching) return;
    setSwitching(true);
    void request({ method: 'moveToMachine', machineId: machine.id }).then(
      () => props.onClose(),
      (error: Error) => { setSwitching(false); props.onError(error.message); },
    );
  };
  const update = (machine: ListedMachine): void => {
    void request({ method: 'updateMachine', machineId: machine.id }).catch((error: Error) => props.onError(error.message));
  };
  const available = (machines ?? []).filter((machine) => !machine.id.startsWith('tailscale:'));
  const discovered = (machines ?? []).filter((machine) => machine.id.startsWith('tailscale:'));
  const rows: ListRow[] = [
    { key: 'saved-heading', heading: true, render: () => <>{empty ? 'Start this chat on' : 'Move this chat to'}</> },
    ...available.map((machine): ListRow => ({
      key: machine.id, disabled: switching || machine.state === 'offline', onSelect: () => select(machine),
      render: () => <div class="conversation" title={machine.updateError}><div class="conversation-main"><div class="conversation-title">{machine.name}</div></div>
        <span class="conversation-meta">{machineMeta({ ...machine, needsYou: 0 }, props.model.machineId ?? 'local')}</span>
        {offersUpdate(machine) ? <button type="button" class="link small machine-update" data-row-action
          title={machine.id === 'local' ? 'Update ClikCode on this machine, the way it was installed' : `Update ClikCode on ${machine.name} to this editor's build`}
          onClick={() => update(machine)}>Update</button> : null}</div>,
    })),
    ...(discovered.length ? [{ key: 'tailnet-heading', heading: true, render: () => <>On your tailnet</> } satisfies ListRow] : []),
    ...discovered.map((machine): ListRow => ({
      key: machine.id, disabled: switching || machine.state !== 'available', onSelect: () => select(machine),
      render: () => <div class="conversation"><div class="conversation-main"><div class="conversation-title">{machine.name}</div></div>
        <span class="conversation-meta">{machine.state === 'available' ? 'Connect · install from GitHub main' : machine.state === 'unsupported' ? 'Windows is not supported yet' : 'offline'}</span></div>,
    })),
  ];
  return <Popover label={empty ? 'Start this chat on' : 'Move this chat to'} onClose={props.onClose} class="picker history-menu" id="machines-menu">
    <Loading waiting={!machines || switching}>{switching ? (empty ? 'Connecting to machine…' : 'Moving this chat…') : 'Finding machines…'}</Loading>
    <KeyList id="machine-switch-list" rows={rows} label="Machines" initialKey={props.model.machineId ?? 'local'}
      onEscape={props.onClose} rightSelect emptyText={machines ? 'No machines found.' : undefined} />
  </Popover>;
}
