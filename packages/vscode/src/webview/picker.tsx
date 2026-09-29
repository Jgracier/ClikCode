/** The composer footer's menus: provider·model (every harness, the Gateway
 * and ClikCode Local, each with its models), reasoning effort, and
 * permissions with plan mode. */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatModel } from '../model';
import type { IdeChoice, IdeModels, IdeProvider } from '../protocol';
import { request } from './bus';
import { titleCase } from './format';
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

function providerIcon(provider: IdeProvider): string {
  if (provider.kind === 'gateway') return 'cloud';
  if (provider.kind === 'clikcode-local') return 'vm';
  return provider.installed ? 'terminal' : 'cloud-download';
}

export function ProviderModelPicker(props: { model: ChatModel; onClose: () => void; onError: (message: string) => void }): JSX.Element {
  const [providers, setProviders] = useState<IdeProvider[] | undefined>(providerCache);
  const [error, setError] = useState<string>();
  const current = props.model.providerId;
  const [drill, setDrill] = useState<string | undefined>(current);
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

  // Moving between the providers and one provider's models starts a fresh
  // search, in the same update: reset from an effect, it could land after the
  // first keys typed on the new list and wipe them.
  const drillTo = (next: string | undefined): void => { setSearch(''); setDrill(next); };
  useEffect(() => { input.current?.focus(); }, [drill]);

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
            <span class="row-main"><span class="row-label">{item.label}</span>{item.detail ? <span class="row-detail">{item.detail}</span> : null}</span>
          </div>
        ),
      }));
      if (models?.custom && query && !list.some((item) => item.id.toLowerCase() === query)) {
        result.push({
          key: 'custom', onSelect: () => apply(drill, search.trim()),
          render: () => <div class="row"><span class="row-check"><Icon name="edit" /></span><span class="row-main"><span class="row-label">Use “{search.trim()}”</span><span class="row-detail">a model id this list does not show</span></span></div>,
        });
      }
      if (drill !== current && provider) {
        result.unshift({
          key: 'default', onSelect: () => apply(drill),
          render: () => <div class="row"><span class="row-check"><Icon name="arrow-right" /></span><span class="row-main"><span class="row-label">Switch to {provider.name}</span><span class="row-detail">its default model</span></span></div>,
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
          onSelect: () => (item.choosesModel ? drillTo(item.id) : apply(item.id)),
          render: () => (
            <div class="row" title={item.integration ? `${item.name} · ${item.integration}${item.version ? ` · ${item.version}` : ''}` : item.name}>
              <span class="row-check">{item.current ? <Icon name="check" /> : <Icon name={providerIcon(item)} />}</span>
              <span class="row-main"><span class="row-label">{item.name}</span>{providerBadge(item)}</span>
              {item.choosesModel ? <span class="row-end"><Icon name="chevron-right" /></span> : null}
            </div>
          ),
        });
      }
    }
    // Models of lists already loaded match the search too.
    if (query) {
      for (const [id, cached] of modelCache) {
        const owner = providers?.find((item) => item.id === id);
        const hits = cached.models.filter((item) => !item.unavailable && (item.id.toLowerCase().includes(query) || item.label.toLowerCase().includes(query))).slice(0, 8);
        if (!owner || !hits.length) continue;
        result.push({ key: `h:m:${id}`, heading: true, render: () => <>{owner.name} models</> });
        for (const hit of hits) {
          result.push({ key: `mm:${id}:${hit.id}`, onSelect: () => apply(id, hit.id), render: () => <div class="row"><span class="row-check" /><span class="row-main"><span class="row-label">{hit.label}</span><span class="row-detail">{owner.name}</span></span></div> });
        }
      }
    }
    return result;
  }, [drill, models, providers, query, current]);

  return (
    <Popover label="Choose provider and model" onClose={props.onClose} class="picker" id="provider-picker">
      <div class="picker-head">
        {drill ? <button type="button" id="picker-back" class="icon-button" aria-label="All providers" title="All providers" onClick={() => drillTo(undefined)}><Icon name="arrow-left" /></button> : <Icon name="server-environment" />}
        <span class="picker-title">{drill ? provider?.name ?? drill : 'Provider and model'}</span>
        {drill && loading ? <Icon name="loading" spin label="Loading models" /> : null}
      </div>
      <div class="search">
        <Icon name="search" />
        <input ref={input} type="text" value={search} placeholder={drill ? 'Search or type a model id…' : 'Search providers and models…'}
          aria-label={drill ? 'Search models' : 'Search providers'} aria-controls="picker-list" onInput={(event) => setSearch((event.target as HTMLInputElement).value)} />
      </div>
      {error ? <div class="picker-error">{error}</div> : null}
      {drill && models?.error ? <div class="picker-error">{models.error}</div> : null}
      {!providers && !error ? <div class="picker-loading"><Icon name="loading" spin /> Loading providers…</div> : null}
      <KeyList id="picker-list" rows={rows} label={drill ? 'Models' : 'Providers'} inputRef={input} onEscape={props.onClose}
        onBack={drill ? () => drillTo(undefined) : undefined}
        onForward={drill ? undefined : (key) => { const id = key.startsWith('p:') ? key.slice(2) : undefined; if (id && providers?.find((item) => item.id === id)?.choosesModel) drillTo(id); }}
        emptyText={drill ? (loading ? 'Finding models…' : 'No models match.') : providers ? 'No providers match.' : undefined} />
      <div class="picker-foot muted">
        {drill ? <><kbd>←</kbd> providers · <kbd>Enter</kbd> choose</> : <><kbd>→</kbd> models · <kbd>Enter</kbd> choose</>}
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
        <label class="menu-switch"><span><Icon name="list-tree" /> Plan mode <span class="muted">read-only: plan, change nothing</span></span>
          <Switch checked={settings.plan} label="Plan mode" onChange={(on) => set({ kind: 'plan', on })} /></label>
      ) : null}
      {settings?.fast !== undefined ? (
        <label class="menu-switch"><span><Icon name="zap" /> Fast <span class="muted">fastest provider, not cheapest</span></span>
          <Switch checked={settings.fast} label="Fast" onChange={(on) => set({ kind: 'fast', on })} /></label>
      ) : null}
    </Popover>
  );
}

export function EffortMenu(props: { model: ChatModel; onClose: () => void; onError: (message: string) => void }): JSX.Element {
  const effort = props.model.chatSettings?.effort;
  const values = ['default', ...(effort?.choices ?? [])];
  const current = effort?.current ?? 'default';
  const rows: ListRow[] = values.map((value) => ({
    key: value,
    onSelect: () => { props.onClose(); choose({ kind: 'effort', value }).catch((failure: Error) => props.onError(failure.message)); },
    render: () => (
      <div class="row">
        <span class="row-check">{value === current ? <Icon name="check" /> : null}</span>
        <span class="row-main"><span class="row-label">{value === 'default' ? 'Default' : titleCase(value)}</span>{value === 'default' ? <span class="row-detail">the model decides</span> : null}</span>
      </div>
    ),
  }));
  return (
    <Popover label="Reasoning effort" onClose={props.onClose} class="menu" id="effort-menu">
      <div class="menu-title">Reasoning effort</div>
      <KeyList rows={rows} label="Reasoning effort" onEscape={props.onClose} />
    </Popover>
  );
}
