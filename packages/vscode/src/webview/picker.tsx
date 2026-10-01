/** The composer footer's menus: provider (every harness, the Gateway and
 * ClikCode Local), the chosen provider's models, reasoning effort, and
 * permissions with plan mode. */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatModel } from '../model';
import type { IdeAccount, IdeAccounts, IdeChoice, IdeModels, IdeProvider } from '../protocol';
import { request } from './bus';
import { modelLabel, titleCase } from './format';
import { Icon, KeyList, Popover, Switch, type ListRow } from './ui';

/** Model lists, kept for the panel's life: a second look is instant. */
const modelCache = new Map<string, IdeModels>();
let providerCache: IdeProvider[] | undefined;

/** Providers as last listed, for names before the chat's record catches up. */
export function knownProviders(): IdeProvider[] | undefined {
  return providerCache;
}

export function choose(choice: IdeChoice): Promise<unknown> {
  return request({ method: 'choose', choice });
}

function providerBadge(provider: IdeProvider): JSX.Element | null {
  if (provider.kind === 'harness' && provider.install === 'auto') return <span class="badge">installs when chosen</span>;
  if (provider.kind === 'harness' && provider.install === 'manual') return <span class="badge muted-badge">install it yourself</span>;
  if (provider.kind === 'gateway' && !provider.signedIn) return <span class="badge">sign in</span>;
  if (provider.kind === 'harness' && !provider.signedIn) return <span class="badge muted-badge">not signed in</span>;
  return null;
}

/** Only what sets a provider apart gets an icon; an installed harness, the
 * common case, has none. */
function providerIcon(provider: IdeProvider): string | undefined {
  if (provider.kind === 'gateway') return 'cloud';
  if (provider.kind === 'clikcode-local') return 'vm';
  return provider.installed ? undefined : 'cloud-download';
}

/** Whether the provider has a model list to choose from; unknown counts as yes. */
/** A model row's label. A ClikCode from before model labels sends the id
 * itself (or its `provider:model` spelling); that one gets the shared rule
 * here. A label the bridge already shortened is shown as it came. */
function rowLabel(item: { id: string; label: string }, ...owners: Array<string | undefined>): string {
  const spelledAsId = item.label === item.id || item.label.replace(':', '/') === item.id;
  return spelledAsId ? modelLabel(item.label, ...owners) : item.label;
}

export function providerChoosesModel(providerId: string | undefined): boolean {
  if (!providerId) return false;
  return providerCache?.find((item) => item.id === providerId)?.choosesModel ?? true;
}

/** `provider`: the providers alone; choosing one switches to it on its
 * default model. `model`: the current provider's models, so the list is
 * always the provider's the chat is on. */
export function ProviderModelPicker(props: { mode: 'provider' | 'model'; model: ChatModel; onClose: () => void; onError: (message: string) => void }): JSX.Element {
  const [providers, setProviders] = useState<IdeProvider[] | undefined>(providerCache);
  const [error, setError] = useState<string>();
  const current = props.model.providerId;
  const drill = props.mode === 'model' ? current : undefined;
  const [models, setModels] = useState<IdeModels | undefined>(drill ? modelCache.get(drill) : undefined);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    request<IdeProvider[]>({ method: 'query', query: 'providers' })
      .then((list) => { providerCache = list; setProviders(list); }, (failure: Error) => setError(failure.message));
  }, []);

  useEffect(() => {
    if (!drill) { setModels(undefined); return; }
    const cached = modelCache.get(drill);
    setModels(cached);
    setLoading(!cached);
    let live = true;
    request<IdeModels>({ method: 'query', query: 'models', provider: drill }).then((list) => {
      modelCache.set(drill, list);
      if (live) { setModels(list); setLoading(false); }
    }, (failure: Error) => { if (live) { setLoading(false); setModels({ provider: drill, models: [], custom: false, error: failure.message }); } });
    return () => { live = false; };
  }, [drill]);

  useEffect(() => { input.current?.focus(); }, []);

  const apply = (providerId: string, modelId?: string): void => {
    props.onClose();
    const choice: IdeChoice = providerId === current
      ? (modelId ? { kind: 'model', model: modelId } : { kind: 'provider', provider: providerId })
      : { kind: 'provider', provider: providerId, ...(modelId ? { model: modelId } : {}) };
    if (providerId === current && !modelId) return;
    choose(choice).catch((failure: Error) => props.onError(failure.message));
  };

  const provider = providers?.find((item) => item.id === drill);
  const query = search.trim().toLowerCase();

  const rows = useMemo((): ListRow[] => {
    if (drill) {
      const list = models?.models ?? [];
      const matching = list.filter((item) => !query || item.label.toLowerCase().includes(query) || item.id.toLowerCase().includes(query) || item.detail?.toLowerCase().includes(query));
      const result: ListRow[] = matching.map((item) => ({
        key: `m:${item.id}`,
        disabled: Boolean(item.unavailable),
        onSelect: () => apply(drill, item.id),
        render: () => (
          <div class="row" title={item.unavailable}>
            <span class="row-check">{item.current || (drill === current && item.id === props.model.model) ? <Icon name="check" /> : null}</span>
            <span class="row-main"><span class="row-label">{rowLabel(item, drill, provider?.name)}</span>{item.detail ? <span class="row-detail">{item.detail}</span> : null}</span>
          </div>
        ),
      }));
      if (models?.custom && query && !list.some((item) => item.id.toLowerCase() === query)) {
        result.push({
          key: 'custom', onSelect: () => apply(drill, search.trim()),
          render: () => <div class="row"><span class="row-check"><Icon name="edit" /></span><span class="row-main"><span class="row-label">Use “{search.trim()}”</span><span class="row-detail">a model id this list does not show</span></span></div>,
        });
      }
      return result;
    }
    const list = (providers ?? []).filter((item) => !query || item.name.toLowerCase().includes(query) || item.id.includes(query));
    const sections: Array<[string, IdeProvider[]]> = [
      ['ClikCode', list.filter((item) => item.kind !== 'harness')],
      ['Signed in', list.filter((item) => item.kind === 'harness' && item.installed && item.signedIn)],
      ['Installed', list.filter((item) => item.kind === 'harness' && item.installed && !item.signedIn)],
      ['Available', list.filter((item) => item.kind === 'harness' && !item.installed)],
    ];
    const result: ListRow[] = [];
    for (const [title, items] of sections) {
      if (!items.length) continue;
      result.push({ key: `h:${title}`, heading: true, render: () => <>{title}<span class="count">{items.length}</span></> });
      for (const item of items) {
        result.push({
          key: `p:${item.id}`,
          disabled: item.install === 'manual',
          onSelect: () => apply(item.id),
          render: () => (
            <div class="row" title={item.integration ? `${item.name} · ${item.integration}${item.version ? ` · ${item.version}` : ''}` : item.name}>
              <span class="row-check">{item.current ? <Icon name="check" /> : providerIcon(item) ? <Icon name={providerIcon(item)!} /> : null}</span>
              <span class="row-main"><span class="row-label">{item.name}</span>{providerBadge(item)}</span>
            </div>
          ),
        });
      }
    }
    return result;
  }, [drill, models, providers, query, current]);

  return (
    <Popover label={drill ? 'Choose model' : 'Choose provider'} onClose={props.onClose} class="picker" id={drill ? 'model-picker' : 'provider-picker'}>
      <div class="picker-head">
        <Icon name={drill ? 'symbol-namespace' : 'server-environment'} />
        <span class="picker-title">{drill ? <>Model <span class="muted">· {provider?.name ?? drill}</span></> : 'Provider'}</span>
        {drill && loading ? <Icon name="loading" spin label="Loading models" /> : null}
      </div>
      <div class="search">
        <Icon name="search" />
        <input ref={input} type="text" value={search} placeholder={drill ? 'Search or type a model id…' : 'Search providers…'}
          aria-label={drill ? 'Search models' : 'Search providers'} aria-controls="picker-list" onInput={(event) => setSearch((event.target as HTMLInputElement).value)} />
      </div>
      {drill && props.model.chatSettings?.effort ? <EffortBar model={props.model} onError={props.onError} /> : null}
      {error ? <div class="picker-error">{error}</div> : null}
      {drill && models?.error ? <div class="picker-error">{models.error}</div> : null}
      {!providers && !error ? <div class="picker-loading"><Icon name="loading" spin /> Loading providers…</div> : null}
      <KeyList id="picker-list" rows={rows} label={drill ? 'Models' : 'Providers'} inputRef={input} onEscape={props.onClose}
        emptyText={drill ? (loading ? 'Finding models…' : 'No models match.') : providers ? 'No providers match.' : undefined} />
      <div class="picker-foot muted">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> select</span><span><kbd>Esc</kbd> close</span>
      </div>
    </Popover>
  );
}

const PERMISSION_TEXT: Record<string, { label: string; detail: string; icon: string }> = {
  ask: { label: 'Ask', detail: 'Approve each edit and command', icon: 'shield' },
  auto: { label: 'Auto', detail: 'The provider reviews requests itself', icon: 'sparkle' },
  bypass: { label: 'Bypass', detail: 'Run everything without asking', icon: 'unlock' },
};

export function permissionLabel(value: string | undefined): string {
  return PERMISSION_TEXT[value ?? 'ask']?.label ?? titleCase(value ?? 'ask');
}

export function ModeMenu(props: { model: ChatModel; onClose: () => void; onError: (message: string) => void }): JSX.Element {
  const settings = props.model.chatSettings;
  const permissions = settings?.permissions;
  const set = (choice: IdeChoice): void => { choose(choice).catch((failure: Error) => props.onError(failure.message)); };
  const rows: ListRow[] = (permissions?.choices ?? ['ask', 'auto', 'bypass']).map((value) => ({
    key: value,
    onSelect: () => { props.onClose(); set({ kind: 'permissions', value }); },
    render: () => (
      <div class="row">
        <span class="row-check">{(permissions?.current ?? props.model.permissions) === value ? <Icon name="check" /> : <Icon name={PERMISSION_TEXT[value]?.icon ?? 'shield'} />}</span>
        <span class="row-main"><span class="row-label">{PERMISSION_TEXT[value]?.label ?? titleCase(value)}</span><span class="row-detail">{PERMISSION_TEXT[value]?.detail ?? ''}</span></span>
      </div>
    ),
  }));
  return (
    <Popover label="Permissions" onClose={props.onClose} class="menu" id="mode-menu">
      <div class="menu-title">Permissions</div>
      <KeyList rows={rows} label="Permissions" onEscape={props.onClose} />
      {settings?.plan !== undefined ? (
        <label class="menu-switch"><span><Icon name="list-tree" /> Plan mode <span class="muted">Read-only: plan, change nothing</span></span>
          <Switch checked={settings.plan} label="Plan mode" onChange={(on) => set({ kind: 'plan', on })} /></label>
      ) : null}
      {settings?.fast !== undefined ? (
        <label class="menu-switch"><span><Icon name="zap" /> Fast <span class="muted">Fastest provider, not cheapest</span></span>
          <Switch checked={settings.fast} label="Fast" onChange={(on) => set({ kind: 'fast', on })} /></label>
      ) : null}
    </Popover>
  );
}

/** An effort as the menu names it: the level, or Default when the model decides. */
export function effortLabel(value: string | undefined): string {
  return !value || value === 'default' ? 'Default' : titleCase(value);
}

/** The chip's words for model and effort together, as Claude Code's picker
 * says them: `Opus Medium`; the model alone while the model decides. */
export function modelWithEffort(modelName: string | undefined, effort: string | undefined): string {
  const name = modelName && /^[a-z]+$/.test(modelName) ? titleCase(modelName) : modelName ?? 'Default model';
  return !effort || effort === 'default' ? name : `${name} ${effortLabel(effort)}`;
}

/** Effort, chosen beside the model in the same menu (or alone, EffortMenu):
 * picking one keeps the menu open, so a model and its effort are set together. */
function EffortBar(props: { model: ChatModel; onError: (message: string) => void }): JSX.Element {
  const effort = props.model.chatSettings?.effort;
  const [current, setCurrent] = useState(effort?.current ?? 'default');
  useEffect(() => { setCurrent(effort?.current ?? 'default'); }, [effort?.current]);
  const values = ['default', ...(effort?.choices ?? [])];
  return (
    <div class="effort-bar" role="radiogroup" aria-label="Reasoning effort">
      <span class="effort-title muted">Effort</span>
      {values.map((value) => (
        <button key={value} type="button" role="radio" aria-checked={value === current} class={`effort-option${value === current ? ' on' : ''}`}
          title={value === 'default' ? 'The model decides' : `${effortLabel(value)} reasoning effort`}
          onClick={() => { setCurrent(value); choose({ kind: 'effort', value }).catch((failure: Error) => props.onError(failure.message)); }}>
          {effortLabel(value)}
        </button>
      ))}
    </div>
  );
}

/** The accounts of the chat's own provider, as a short list: choosing one
 * moves the chat onto it; another can be added for the same provider. */
export function AccountMenu(props: { model: ChatModel; onClose: () => void; onError: (message: string) => void }): JSX.Element {
  const [data, setData] = useState<IdeAccounts>();
  useEffect(() => {
    request<IdeAccounts>({ method: 'query', query: 'accounts' }).then(setData, (failure: Error) => props.onError(failure.message));
  }, []);
  const providerId = props.model.providerId;
  const currentProvider = data?.accounts.find((item) => item.current)?.provider;
  const mine = (data?.accounts ?? []).filter((item) => (item.harness ? item.harness === providerId : item.provider === currentProvider));
  const addable = data?.addable.find((item) => item.provider === providerId);
  const rows: ListRow[] = mine.map((account) => ({
    key: account.id,
    onSelect: () => { props.onClose(); if (!account.current) choose({ kind: 'account', accountId: account.id }).catch((failure: Error) => props.onError(failure.message)); },
    render: () => (
      <div class="row">
        <span class="row-check">{account.current ? <Icon name="check" /> : account.problem ? <Icon name="warning" /> : null}</span>
        <span class="row-main"><span class="row-label">{account.label}</span>
          <span class="row-detail">{account.problem ? ACCOUNT_PROBLEM[account.problem] : account.usage?.label ?? ''}</span></span>
      </div>
    ),
  }));
  if (addable) {
    rows.push({
      key: 'add', onSelect: () => { props.onClose(); choose({ kind: 'add-account', provider: addable.provider }).catch((failure: Error) => props.onError(failure.message)); },
      render: () => <div class="row"><span class="row-check"><Icon name="add" /></span><span class="row-main"><span class="row-label">Add account</span></span></div>,
    });
  }
  return (
    <Popover label="Accounts" onClose={props.onClose} class="menu" id="account-menu">
      <div class="menu-title">{data?.accounts.find((item) => item.current)?.providerName ?? 'Accounts'}</div>
      {!data ? <div class="picker-loading"><Icon name="loading" spin /> Loading accounts…</div>
        : <KeyList rows={rows} label="Accounts" onEscape={props.onClose} emptyText="No accounts for this provider." />}
    </Popover>
  );
}

const ACCOUNT_PROBLEM: Record<NonNullable<IdeAccount['problem']>, string> = {
  verify: 'needs verifying', reauth: 'signed out', 'out-of-usage': 'out of usage',
};

/** Effort alone, for a provider with no model list: the same choices as
 * beside the model, floated over the chip. */
export function EffortMenu(props: { model: ChatModel; onClose: () => void; onError: (message: string) => void }): JSX.Element {
  return (
    <Popover label="Reasoning effort" onClose={props.onClose} class="menu" id="effort-menu">
      <EffortBar model={props.model} onError={props.onError} />
    </Popover>
  );
}
