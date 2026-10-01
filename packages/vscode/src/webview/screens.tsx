/** Full-panel screens: conversations (history) and accounts with usage. */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatModel } from '../model';
import type { IdeAccount, IdeAccounts, IdeConversation, IdeGateway } from '../protocol';
import { post, request } from './bus';
import { homeRelative, relativeTime, resetIn } from './format';
import { choose } from './picker';
import { Icon, IconButton, KeyList, Meter, Switch, type ListRow } from './ui';

function ScreenHead(props: { title: string; onBack: () => void; children?: JSX.Element | JSX.Element[] | null }): JSX.Element {
  return (
    <header class="topbar screen-head">
      <IconButton id="back-button" icon="arrow-left" label="Back to chat (Esc)" onClick={props.onBack} />
      <h2 class="screen-title">{props.title}</h2>
      <div class="screen-tools">{props.children}</div>
    </header>
  );
}

// ---- conversations -------------------------------------------------------------

export function HistoryScreen(props: { model: ChatModel; onBack: () => void; onError: (message: string) => void }): JSX.Element {
  const [rows, setRows] = useState<IdeConversation[]>();
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const load = (): void => {
    request<IdeConversation[]>({ method: 'query', query: 'conversations' }).then(setRows, (failure: Error) => props.onError(failure.message));
  };
  useEffect(() => { load(); input.current?.focus(); }, []);
  useEffect(() => { if (rows) load(); }, [props.model.sessionId, props.model.title]);
  // While a chat is generating, re-query so the pulse stops when it finishes.
  useEffect(() => {
    if (!rows?.some((row) => row.activity === 'working')) return;
    const timer = setInterval(load, 2_000);
    return () => clearInterval(timer);
  }, [rows]);

  const open = (row: IdeConversation): void => {
    props.onBack();
    if (!row.current) request({ method: 'open', mode: 'resume', sessionId: row.id }).catch((failure: Error) => props.onError(failure.message));
  };
  const act = (row: IdeConversation, action: 'rename' | 'fork' | 'archive' | 'delete', name?: string): void => {
    setConfirming(undefined);
    choose({ kind: 'conversation', sessionId: row.id, action, ...(name ? { name } : {}) }).then(load, (failure: Error) => props.onError(failure.message));
  };

  const query = search.trim().toLowerCase();
  const listRows = useMemo((): ListRow[] => {
    const matching = (rows ?? []).filter((row) => !query || `${row.title} ${row.preview ?? ''} ${row.provider ?? ''} ${row.model ?? ''} ${row.workspace ?? ''}`.toLowerCase().includes(query));
    const now = Date.now();
    const activeWithinMs = 24 * 60 * 60 * 1000;
    const isActive = (row: IdeConversation): boolean => {
      const at = Date.parse(row.updatedAt);
      return !Number.isNaN(at) && now - at < activeWithinMs;
    };
    // Working = generating (animated). Active = touched in the last 24 hours.
    // Past = older. An idle worker on an old chat is Past, not Active.
    const sections: Array<[string, IdeConversation[]]> = [
      ['Working', matching.filter((row) => row.activity === 'working')],
      ['Active', matching.filter((row) => row.activity !== 'working' && isActive(row))],
      ['Past', matching.filter((row) => row.activity !== 'working' && !isActive(row))],
    ];
    const result: ListRow[] = [];
    for (const [title, items] of sections) {
      if (!items.length) continue;
      result.push({ key: `h:${title}`, heading: true, render: () => <>{title}<span class="count">{items.length}</span></> });
      for (const row of items) {
        result.push({
          key: row.id,
          onSelect: () => (renaming === row.id ? undefined : open(row)),
          render: () => (
            <div class={`conversation${row.current ? ' current' : ''}`}>
              <span class={`conversation-dot ${row.activity === 'working' ? 'working' : row.activity === 'idle' ? 'idle' : ''}`} aria-hidden="true" />
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
                ) : <div class="conversation-title">{row.title}{row.current ? <span class="badge">this chat</span> : null}{row.elsewhere ? <span class="badge muted-badge">open elsewhere</span> : null}</div>}
                <div class="conversation-meta" title={row.workspace ? homeRelative(row.workspace) : undefined}>
                  {[row.provider, row.model, relativeTime(row.updatedAt), row.workspace ? row.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : undefined, row.history > 1 ? `${row.history} branches` : undefined].filter(Boolean).join(' · ')}
                </div>
                {row.preview ? <div class="conversation-preview">{row.preview}</div> : null}
              </div>
              <div class="row-actions" data-row-action>
                <IconButton icon="link-external" label="Open in new tab" onClick={() => { void request({ method: 'openInTab', sessionId: row.id }); }} />
                <IconButton icon="terminal" label="Continue in terminal" onClick={() => { void request({ method: 'openInTerminal', sessionId: row.id }).catch((failure: Error) => props.onError(failure.message)); }} />
                <IconButton icon="edit" label="Rename" onClick={() => setRenaming(row.id)} />
                <IconButton icon="repo-forked" label="Fork" onClick={() => act(row, 'fork')} />
                <IconButton icon="archive" label="Archive" onClick={() => act(row, 'archive')} />
                {confirming === row.id
                  ? <button type="button" class="danger small" onClick={() => act(row, 'delete')}>Delete?</button>
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
    <section class="screen" aria-label="Conversations">
      <ScreenHead title="Conversations" onBack={props.onBack}>
        <IconButton icon="refresh" label="Refresh" onClick={load} />
        <IconButton icon="add" label="New chat" onClick={() => { props.onBack(); void request({ method: 'open', mode: 'new' }); }} />
      </ScreenHead>
      <div class="search screen-search">
        <Icon name="search" />
        <input ref={input} type="text" value={search} placeholder="Search conversations…" aria-label="Search conversations"
          onInput={(event) => setSearch((event.target as HTMLInputElement).value)} />
      </div>
      <div class="screen-body">
        {!rows ? <div class="picker-loading"><Icon name="loading" spin /> Loading conversations…</div> : null}
        <KeyList id="history-list" rows={listRows} label="Conversations" inputRef={input} onEscape={props.onBack}
          emptyText={rows ? (query ? 'No conversation matches.' : 'No conversations yet.') : undefined} />
        <div class="screen-foot">
          <span class="muted">Shared with <code>clikcode</code> in the terminal.</span>
          <button type="button" class="link" onClick={() => { props.onBack(); post({ type: 'send', text: '/resume', id: `resume-${Date.now()}` }); }}>
            <Icon name="search" /> Find chats from other CLIs…
          </button>
        </div>
      </div>
    </section>
  );
}

// ---- accounts and usage ------------------------------------------------------------

const PROBLEM: Record<NonNullable<IdeAccount['problem']>, string> = {
  verify: 'needs verifying', reauth: 'signed out', 'out-of-usage': 'out of usage',
};

const ACTION_LABEL: Record<IdeAccount['actions'][number], { label: string; icon: string }> = {
  reauthenticate: { label: 'Sign in again', icon: 'key' },
  disconnect: { label: 'Sign out', icon: 'sign-out' },
  remove: { label: 'Remove', icon: 'trash' },
  verified: { label: 'I have verified it', icon: 'pass' },
};

export function UsageBars({ account, compact }: { account: IdeAccount; compact?: boolean }): JSX.Element | null {
  const windows = account.usage?.windows ?? [];
  if (!windows.length) return account.usage?.label ? <div class="usage-label muted">{account.usage.label}</div> : null;
  return (
    <div class={`usage-bars${compact ? ' compact' : ''}`}>
      {windows.map((window) => {
        const left = Math.max(0, 100 - Math.round(window.usedPct));
        return (
          <div key={window.name} class="usage-window">
            <span class="usage-name">{window.name}</span>
            <Meter usedPct={window.usedPct} label={`${window.name}: ${Math.round(window.usedPct)}% used`} />
            <span class="usage-left">{left}% left{!compact && resetIn(window.resetsAt) ? <span class="muted"> · {resetIn(window.resetsAt)}</span> : null}</span>
          </div>
        );
      })}
      {account.usage?.learned && !compact ? <div class="muted usage-note">Learned from this account’s own limits.</div> : null}
    </div>
  );
}

function money(value: number): string {
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function GatewayCard(props: { onError: (message: string) => void }): JSX.Element {
  const [gateway, setGateway] = useState<IdeGateway>();
  useEffect(() => { request<IdeGateway>({ method: 'query', query: 'gateway' }).then(setGateway, (failure: Error) => props.onError(failure.message)); }, []);
  const buy = (): void => {
    choose({ kind: 'gateway-credit' }).then((data) => {
      const url = (data as { url?: string } | undefined)?.url;
      if (url) post({ type: 'openLink', href: url });
    }, (failure: Error) => props.onError(failure.message));
  };
  const credit = gateway?.credit;
  return (
    <div class="card gateway-card">
      <div class="card-head"><Icon name="cloud" /><span class="card-title">ClikDeploy Gateway</span>
        {gateway ? <span class={`badge${gateway.connected ? ' ok' : ' muted-badge'}`}>{gateway.connected ? 'connected' : 'not signed in'}</span> : <Icon name="loading" spin />}
      </div>
      {gateway?.connected ? (
        <div class="credit">
          <div>
            <div class="credit-amount">{credit?.unlimited ? 'Unlimited' : credit?.balanceUsd !== undefined ? money(credit.balanceUsd) : '—'}</div>
            <div class="muted">{credit?.unlimited ? 'Your plan includes unlimited AI credit' : credit?.allowed === false ? 'Out of credit: add more to keep using Gateway models' : 'AI credit for Gateway models'}{credit?.autoTopUp ? ' · auto top-up on' : ''}</div>
          </div>
          {!credit?.unlimited ? <button type="button" class="primary" onClick={buy}><Icon name="credit-card" /> Buy credit</button> : null}
        </div>
      ) : gateway ? (
        <div class="credit">
          <div class="muted">Hosted models from every lab, paid from one balance.</div>
          <button type="button" class="secondary" onClick={() => choose({ kind: 'provider', provider: 'gateway' }).catch((failure: Error) => props.onError(failure.message))}>Sign in</button>
        </div>
      ) : null}
      {gateway?.error ? <div class="muted">{gateway.error}</div> : null}
    </div>
  );
}

export function AccountsScreen(props: { model: ChatModel; onBack: () => void; onError: (message: string) => void }): JSX.Element {
  const [data, setData] = useState<IdeAccounts>();
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string>();
  const load = (network: boolean): void => {
    if (network) setRefreshing(true);
    request<IdeAccounts>({ method: 'query', query: 'accounts', network }).then((result) => { setData(result); setRefreshing(false); },
      (failure: Error) => { setRefreshing(false); props.onError(failure.message); });
  };
  const section = useRef<HTMLElement>(null);
  useEffect(() => { load(false); load(true); section.current?.focus(); }, []);
  const act = (account: IdeAccount, action: IdeAccount['actions'][number]): void => {
    setConfirming(undefined);
    choose({ kind: 'account-action', accountId: account.id, action }).then(() => load(false), (failure: Error) => props.onError(failure.message));
  };
  const use = (account: IdeAccount): void => {
    if (account.harness && account.harness !== props.model.providerId) {
      choose({ kind: 'provider', provider: account.harness }).then(() => choose({ kind: 'account', accountId: account.id })).then(() => load(false), (failure: Error) => props.onError(failure.message));
      return;
    }
    choose({ kind: 'account', accountId: account.id }).then(() => load(false), (failure: Error) => props.onError(failure.message));
  };
  const add = (provider: string): void => {
    setAdding(false);
    choose({ kind: 'add-account', provider }).then(() => load(true), (failure: Error) => props.onError(failure.message));
  };

  const groups = new Map<string, IdeAccount[]>();
  for (const account of data?.accounts ?? []) groups.set(account.providerName, [...(groups.get(account.providerName) ?? []), account]);
  const ordered = [...groups.entries()].sort(([left, a], [right, b]) =>
    Number(b.some((item) => item.current)) - Number(a.some((item) => item.current)) || left.localeCompare(right));
  const addRows: ListRow[] = (data?.addable ?? []).map((item) => ({
    key: item.provider, onSelect: () => add(item.provider),
    render: () => <div class="row"><span class="row-check"><Icon name="add" /></span><span class="row-main"><span class="row-label">{item.name}</span></span></div>,
  }));

  return (
    <section class="screen" aria-label="Accounts and usage" tabIndex={-1} ref={section}
      onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); props.onBack(); } }}>
      <ScreenHead title="Accounts & usage" onBack={props.onBack}>
        <IconButton icon="refresh" label="Refresh usage" onClick={() => load(true)} class={refreshing ? 'spinning' : ''} />
        <IconButton icon="add" label="Add account" onClick={() => setAdding(!adding)} active={adding} />
      </ScreenHead>
      <div class="screen-body">
        {adding ? (
          <div class="card add-card">
            <div class="card-head"><span class="card-title">Add an account</span><span class="muted">sign in with the provider's own login</span></div>
            <KeyList id="add-list" rows={addRows} label="Providers" onEscape={() => setAdding(false)} />
          </div>
        ) : null}
        {data && props.model.chatSettings?.failover !== undefined ? (
          <label class="card switch-card">
            <span><span class="card-title">Switch accounts automatically</span><br /><span class="muted">When this chat's account hits a usage limit, continue on the next one with room.</span></span>
            <Switch checked={data.failover === 'auto'} label="Switch accounts automatically"
              onChange={(on) => choose({ kind: 'failover', value: on ? 'auto' : 'never' }).then(() => load(false), (failure: Error) => props.onError(failure.message))} />
          </label>
        ) : null}
        <GatewayCard onError={props.onError} />
        {!data ? <div class="picker-loading"><Icon name="loading" spin /> Loading accounts…</div> : null}
        {data && !data.accounts.length ? <div class="empty-note">No provider accounts yet. <button type="button" class="link" onClick={() => setAdding(true)}>Add one</button></div> : null}
        {ordered.map(([provider, accounts]) => (
          <div key={provider} class="account-group">
            <div class="group-head">{provider}<span class="count">{accounts.length}</span>
              {accounts[0]?.harness ? <button type="button" class="link small" onClick={() => add(accounts[0]!.harness!)}><Icon name="add" /> Add</button> : null}
            </div>
            {accounts.map((account) => (
              <div key={account.id} class={`account${account.current ? ' current' : ''}`}>
                <div class="account-head">
                  <Icon name={account.current ? 'pass-filled' : 'account'} />
                  <span class="account-label" title={account.label}>{account.label}</span>
                  {account.current ? <span class="badge ok">this chat</span> : null}
                  {account.problem ? <span class="badge warn">{PROBLEM[account.problem]}</span> : null}
                  <span class="spacer" />
                  {!account.current && account.status === 'ready' ? <button type="button" class="secondary small" onClick={() => use(account)}>Use</button> : null}
                  {account.actions.map((action) => (action === 'remove' || action === 'disconnect') && confirming !== `${account.id}:${action}`
                    ? <IconButton key={action} icon={ACTION_LABEL[action].icon} label={ACTION_LABEL[action].label} onClick={() => setConfirming(`${account.id}:${action}`)} />
                    : (action === 'remove' || action === 'disconnect')
                      ? <button key={action} type="button" class="danger small" onClick={() => act(account, action)}>{ACTION_LABEL[action].label}?</button>
                      : <IconButton key={action} icon={ACTION_LABEL[action].icon} label={ACTION_LABEL[action].label} onClick={() => act(account, action)} />)}
                </div>
                <UsageBars account={account} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
