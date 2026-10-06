/** The chat webview: renders the ChatModel the extension posts, and turns
 * clicks and keys into messages back. Holds no conversation state of its own
 * beyond the composer and which menu is open. */
import { COPIED_MS, NOTICE_MS } from '../../../../src/harness/protocol/timings';
import { Component, render, type ComponentChildren, type JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { chatModelLabel, currentProvider, type ChatModel } from '../model';
import { applyModelPatch } from '../model-patch';
import type { IdeConversation, IdePickItem, IdeSearchFocus, IdeUiResult } from '../protocol';
import type { ToWebview, WebviewMenu } from '../webview-protocol';
import { command, listen, post, request, save, uid } from './bus';
import { ApprovalCard, Transcript } from './chat';
import { Composer, type ComposerHandle } from './composer';
import { relativeTime, tildePath } from './format';
import { choose } from './picker';
import { HistoryMenu } from './screens';
import { markMention, SearchBar } from './search';
import { Sheet, type OpenQuestion } from './sheet';
import { focusHere, Icon, IconButton, KeyList, Logo, Popover, type ListRow } from './ui';

const REMEDY: Record<NonNullable<ChatModel['remedy']>, { command: string; label: string }> = {
  'install': { command: 'clikcode.install', label: 'Install ClikCode' },
  'update-clikcode': { command: 'clikcode.update', label: 'Update ClikCode' },
  'update-extension': { command: 'clikcode.updateExtension', label: 'Update Extension' },
};

function Banner({ model }: { model: ChatModel }): JSX.Element | null {
  if (model.connection === 'error' || model.connection === 'stopped') {
    return (
      <div class="banner" role="alert">
        <div class="banner-head"><Icon name="warning" /><span>{model.connection === 'stopped' ? 'ClikCode stopped' : 'ClikCode could not start'}</span></div>
        <p>{model.connectionError ?? 'ClikCode stopped.'}</p>
        <div class="banner-actions">
          {model.remedy ? <button type="button" class="primary" onClick={() => command(REMEDY[model.remedy!].command)}>{REMEDY[model.remedy].label}</button> : null}
          <button type="button" class={model.remedy ? 'secondary' : 'primary'} onClick={() => command('clikcode.restart')}>Retry</button>
          <button type="button" class="secondary" onClick={() => command('clikcode.configure')}>Extension settings</button>
          <button type="button" class="link" onClick={() => command('clikcode.showLog')}>Show log</button>
        </div>
      </div>
    );
  }
  return null;
}

const SUGGESTIONS: Array<{ icon: string; title: string; prompt: string }> = [
  { icon: 'book', title: 'Explain this codebase', prompt: 'Give me a tour of this codebase: what it does, how it is organized, and where to start reading.' },
  { icon: 'bug', title: 'Find and fix a bug', prompt: 'Look for a real bug in this project, explain it, and fix it.' },
  { icon: 'beaker', title: 'Write tests', prompt: 'Find the most important untested code in this project and write tests for it.' },
  { icon: 'git-compare', title: 'Review my changes', prompt: '/review' },
];

function Welcome({ model, onPrompt, onMenu }: { model: ChatModel; onPrompt: (text: string) => void; onMenu: (menu: WebviewMenu) => void }): JSX.Element {
  const [recent, setRecent] = useState<IdeConversation[]>();
  useEffect(() => {
    request<IdeConversation[]>({ method: 'query', query: 'conversations' }).then((rows) => setRecent(rows.filter((row) => !row.current).slice(0, 3)), () => undefined);
  }, [model.sessionId]);
  const provider = currentProvider(model);
  const needsSignIn = provider && provider.kind === 'harness' && !provider.signedIn && provider.installed;
  const needsGateway = provider && provider.kind === 'gateway' && !provider.signedIn;
  const folder = model.workspace ? model.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : undefined;
  return (
    <div class="welcome">
      <div class="welcome-hero">
        <Logo size={44} />
        <h1>What should we build?</h1>
        <p class="muted">
          {provider ? <>{provider.name}{model.model ? <> · {chatModelLabel(model, provider.name)}</> : null}</> : 'ClikCode'}
          {folder ? <> · <span title={model.workspace ? tildePath(model.workspace) : ''}>{folder}</span></> : null}
        </p>
      </div>
      {needsSignIn || needsGateway ? (
        <div class="card signin-card">
          <div class="card-head"><Icon name="key" /><span class="card-title">Sign in to {provider!.name}</span></div>
          <p class="muted">{provider!.name} needs an account before it can answer.</p>
          <div class="banner-actions">
            <button type="button" class="primary" onClick={() => (needsGateway ? choose({ kind: 'provider', provider: 'gateway' }) : choose({ kind: 'add-account', provider: provider!.id })).catch(() => undefined)}>Sign in</button>
            <button type="button" class="secondary" onClick={() => onMenu('accounts')}>Accounts</button>
          </div>
        </div>
      ) : null}
      <div class="suggestions-grid">
        {SUGGESTIONS.map((item) => (
          <button key={item.title} type="button" class="suggestion" onClick={() => onPrompt(item.prompt)}>
            <Icon name={item.icon} /><span>{item.title}</span>
          </button>
        ))}
      </div>
      {recent?.length ? (
        <div class="recent">
          <div class="group-head">Recent<button type="button" class="link small" onClick={() => onMenu('history')}>View all</button></div>
          {recent.map((row) => (
            <button key={row.id} type="button" class="recent-row" onClick={() => { void request({ method: 'open', mode: 'resume', sessionId: row.id }); }}>
              <span class={`conversation-dot ${row.activity ?? ''}`} aria-hidden="true" />
              <span class="recent-title">{row.title}</span>
              <span class="muted">{relativeTime(row.updatedAt)}</span>
            </button>
          ))}
        </div>
      ) : null}
      <p class="welcome-tip muted"><kbd>@</kbd> files · <kbd>/</kbd> commands</p>
    </div>
  );
}

const MAC = /Mac/i.test(navigator.platform);
/** A keyboard shortcut as this platform writes it: `shortcut('N')` is Ctrl+N, or ⌘N on macOS. */
export function shortcut(keys: string): string {
  return MAC ? `⌘${keys.replace(/Shift\+/g, '⇧').replace(/Esc/g, 'Esc')}` : `Ctrl+${keys}`;
}

function MoreMenu({ model, onClose, onMenu }: { model: ChatModel; onClose: () => void; onMenu: (menu: WebviewMenu) => void }): JSX.Element {
  const item = (key: string, icon: string, label: string, run: () => void, hint?: string): ListRow => ({
    key, onSelect: () => { onClose(); run(); },
    render: () => <div class="row"><span class="row-check"><Icon name={icon} /></span><span class="row-main"><span class="row-label">{label}</span></span>{hint ? <span class="row-end muted">{hint}</span> : null}</div>,
  });
  const heading = (title: string): ListRow => ({ key: `h:${title}`, heading: true, render: () => <>{title}</> });
  const rows: ListRow[] = [
    heading('Chat'),
    item('accounts', 'account', 'Accounts & usage', () => onMenu('accounts')),
    item('settings', 'settings-gear', 'Chat settings', () => post({ type: 'send', text: '/settings', id: uid() })),
    ...(model.route === 'local' && model.harness
      ? [item('tools', 'plug', 'MCP servers & tools', () => post({ type: 'send', text: '/settings tools', id: uid() }))] : []),
    item('commands', 'symbol-namespace', 'All commands', () => post({ type: 'send', text: '/help', id: uid() }), '/'),
    heading('Open'),
    item('window', 'empty-window', 'Open in new window', () => command('clikcode.openInNewWindow')),
    heading('Help'),
    item('walkthrough', 'book', 'Get started', () => command('clikcode.openWalkthrough')),
    item('doctor', 'pulse', 'Check providers', () => post({ type: 'send', text: '/doctor', id: uid() })),
    item('options', 'gear', 'Extension settings', () => command('clikcode.configure')),
    item('log', 'output', 'Show log', () => command('clikcode.showLog')),
  ];
  return (
    <Popover label="More" onClose={onClose} class="menu more-menu" id="more-menu">
      <KeyList rows={rows} label="More" onEscape={onClose} />
    </Popover>
  );
}

function Header({ model, onMenu, history, setHistory, onError }: { model: ChatModel; onMenu: (menu: WebviewMenu) => void; history: boolean; setHistory: (open: boolean) => void; onError: (message: string) => void }): JSX.Element {
  const [more, setMore] = useState(false);
  const title = model.title ?? (model.sessionId ? 'New chat' : 'ClikCode');
  return (
    <header class="topbar">
      <span class="title-text" title={title}>{title}</span>
      <span class="spacer" />
      <IconButton id="new-chat" icon="add" label={`New chat (${shortcut('N')})`} onClick={() => { void request({ method: 'open', mode: 'new' }); }} />
      <span data-popover-anchor><IconButton id="history-button" icon="history" label="Conversations" active={history} onClick={() => { setMore(false); setHistory(!history); }} /></span>
      <span data-popover-anchor><IconButton id="more-button" icon="ellipsis" label="More" active={more} onClick={() => { setHistory(false); setMore(!more); }} /></span>
      {more ? <MoreMenu model={model} onClose={() => setMore(false)} onMenu={onMenu} /> : null}
      {history ? <HistoryMenu model={model} onClose={() => setHistory(false)} onError={onError} /> : null}
    </header>
  );
}

/** A drawing error in the conversation stays there: it is logged, the rest
 * of the panel (the message box, the menus) keeps working, and the next
 * change to the conversation draws it again. One bad value used to blank the
 * whole page. */
class DrawGuard extends Component<{ model: ChatModel; children: ComponentChildren }, { failed?: ChatModel }> {
  override componentDidCatch(error: unknown): void {
    post({ type: 'log', text: `draw failed: ${String((error as Error)?.stack ?? error)}` });
    this.setState({ failed: this.props.model });
  }

  override render(): ComponentChildren {
    if (this.state.failed && this.state.failed === this.props.model) {
      return <div class="notice warning" role="alert"><Icon name="warning" /><span>Part of this conversation could not be drawn. It is in the log (Show log); the chat itself is unaffected.</span></div>;
    }
    return this.props.children;
  }
}

function Toast({ message, onClose }: { message: string; onClose: () => void }): JSX.Element {
  useEffect(() => { const timer = setTimeout(onClose, NOTICE_MS); return () => clearTimeout(timer); }, [message]);
  return <div class="toast" role="alert"><Icon name="error" /><span>{message}</span><IconButton icon="close" label="Dismiss" onClick={onClose} /></div>;
}

/** Answers the extension's probes (integration tests only). */
function probe(message: Extract<ToWebview, { type: 'probe' }>): unknown {
  const elements = [...document.querySelectorAll<HTMLElement>(message.selector)];
  const element = elements[0];
  if (message.action === 'query') {
    return { count: elements.length, text: element?.innerText ?? element?.textContent ?? '', texts: elements.slice(0, 50).map((item) => item.innerText ?? item.textContent ?? ''), disabled: (element as HTMLButtonElement | undefined)?.disabled ?? false, value: (element as HTMLTextAreaElement | undefined)?.value };
  }
  if (!element) {
    return { ok: false, error: `nothing matches ${message.selector} (page: ${document.body.innerText.slice(0, 300).replace(/\s+/g, ' ')})` };
  }
  if (message.action === 'click') { element.scrollIntoView?.({ block: 'nearest' }); element.click(); return { ok: true }; }
  if (message.action === 'type') {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    input.focus();
    input.value = message.text ?? '';
    input.setSelectionRange?.(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
    return { ok: true };
  }
  element.focus();
  if (message.action === 'paste') {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', message.text ?? '');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    return { ok: true };
  }
  element.dispatchEvent(new KeyboardEvent('keydown', { key: message.text ?? 'Enter', bubbles: true, cancelable: true }));
  return { ok: true };
}

function App(): JSX.Element {
  const [model, setModel] = useState<ChatModel>();
  const [history, setHistory] = useState(false);
  const [questions, setQuestions] = useState<Array<OpenQuestion & { items?: readonly IdePickItem[] }>>([]);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState<IdeSearchFocus>();
  const composer = useRef<ComposerHandle | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const runningRef = useRef(false);
  runningRef.current = Boolean(model?.running);
  const approvalRef = useRef<string>();
  approvalRef.current = model?.approvals[0]?.id;
  /** The newest message of the user's still waiting -- what Esc takes back. */
  const waitingRef = useRef<{ id: string }>();
  waitingRef.current = model?.queued.filter((item) => !item.notification && !item.command).at(-1);

  const answer = (id: string, result: IdeUiResult): void => {
    setQuestions((items) => items.filter((item) => item.id !== id));
    post({ type: 'ui-response', id, result });
  };

  const showMenu = (menu: WebviewMenu): void => {
    if (menu === 'history') setHistory(true);
    else composer.current?.accounts();
  };

  useEffect(() => listen((message) => {
    switch (message.type) {
      case 'model':
        setModel(message.model);
        save({ ...(message.model.sessionId ? { sessionId: message.model.sessionId } : {}) }); return;
      case 'patch':
        setModel((previous) => (previous ? applyModelPatch(previous, message.patch) : previous));
        if (message.patch.set.sessionId) save({ sessionId: message.patch.set.sessionId }); return;
      case 'setDraft': composer.current?.setDraft(message.text); return;
      case 'insert': composer.current?.insert(message.text); return;
      case 'mention': requestAnimationFrame(() => composer.current?.mention(message.mention)); return;
      case 'focus': requestAnimationFrame(() => composer.current?.focus()); return;
      case 'show': showMenu(message.menu); return;
      case 'ui-request': setQuestions((items) => [...items.filter((item) => item.id !== message.id), { id: message.id, request: message.request }]); return;
      case 'ui-update': setQuestions((items) => items.map((item) => (item.id === message.id ? { ...item, items: message.items } : item))); return;
      case 'ui-cancel': setQuestions((items) => items.filter((item) => item.id !== message.id)); return;
      case 'search': setSearch(message.focus); return;
      case 'probe': post({ type: 'probeResult', id: message.id, result: probe(message) }); return;
      default: return;
    }
  }), []);

  useEffect(() => {
    const focus = (focused: boolean) => () => post({ type: 'focusChanged', focused });
    const onFocus = focus(true);
    const onBlur = focus(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    if (document.hasFocus()) onFocus();
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement;
      const file = target.closest<HTMLElement>('[data-file]');
      if (file) {
        event.preventDefault();
        post({ type: 'openFile', path: file.dataset.file!, ...(file.dataset.line ? { line: Number(file.dataset.line) } : {}) });
        return;
      }
      const link = target.closest<HTMLElement>('a[data-href]');
      if (link) { event.preventDefault(); post({ type: 'openLink', href: link.dataset.href ?? '' }); return; }
      if (target.closest('a')) { event.preventDefault(); return; }
      const copy = target.closest<HTMLElement>('[data-copy]');
      if (copy) {
        const code = copy.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
        void navigator.clipboard?.writeText(code).then(() => {
          copy.classList.add('copied');
          setTimeout(() => copy.classList.remove('copied'), COPIED_MS);
        });
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement;
      if ((event.key === 'Enter' || event.key === ' ') && target.matches('code.file-link')) {
        event.preventDefault();
        post({ type: 'openFile', path: target.dataset.file!, ...(target.dataset.line ? { line: Number(target.dataset.line) } : {}) });
        return;
      }
      // Esc never stops the turn (the stop button does): as in the terminal
      // it takes the newest waiting message back into the composer to edit,
      // as its Edit button would -- unless a menu, a sheet or the composer
      // already took it (they preventDefault). With an approval pending it
      // denies that call instead: the turn goes on without it.
      if (event.key === 'Escape' && !event.defaultPrevented && runningRef.current) {
        const pending = approvalRef.current;
        const waiting = waitingRef.current;
        if (pending) { event.preventDefault(); post({ type: 'approve', id: pending, approved: false }); }
        else if (waiting) { event.preventDefault(); post({ type: 'unqueue', id: waiting.id, edit: true }); }
      }
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    post({ type: 'ready' });
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // An approval takes the keyboard (y allow, a always, n or Esc deny) when
  // nothing is being typed, as a terminal prompt would; with a draft in the
  // composer it waits for a click or Tab, so the draft's letters stay its own.
  const firstApproval = model?.approvals[0]?.id;
  useEffect(() => {
    if (!firstApproval) return;
    const active = document.activeElement as HTMLElement | null;
    const typing = active?.id === 'composer-input' && composer.current?.hasText();
    if (!typing && (!active || active === document.body || active.id === 'composer-input')) {
      focusHere(document.querySelector<HTMLElement>(`[data-approval="${firstApproval}"]`));
    }
  }, [firstApproval]);

  // A sheet closing hands the keyboard back to the composer.
  const hadQuestion = useRef(false);
  useEffect(() => {
    if (hadQuestion.current && !questions.length && document.hasFocus()) requestAnimationFrame(() => composer.current?.focus());
    hadQuestion.current = questions.length > 0;
  }, [questions.length]);

  // Follow the conversation while the reader is at the bottom of it.
  useLayoutEffect(() => {
    const element = log.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  });

  // /search: the mention in view, once its conversation is drawn; reading
  // there, the log no longer follows the bottom.
  const searchFocus = search && search.sessionId === model?.sessionId ? search : undefined;
  useLayoutEffect(() => {
    if (markMention(searchFocus) && searchFocus) stick.current = false;
  }, [searchFocus, model?.messages]);
  // Back to the composer when the walk ends.
  useEffect(() => { if (!search && document.hasFocus()) composer.current?.focus(); }, [search]);

  if (!model) return <div class="starting"><Logo size={36} /><span class="muted">Starting ClikCode…</span></div>;

  const empty = !model.messages.length && !model.pendingPrompt && !model.running && !model.notes.length;
  const question = questions[questions.length - 1];
  const sendNow = (text: string): void => post({ type: 'send', text, id: uid() });

  return (
    <div class="app">
      <Header model={model} onMenu={showMenu} history={history} setHistory={setHistory} onError={setError} />
      <main class="chat">
        <div class="log" ref={log} onScroll={() => { const element = log.current!; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
          <Banner model={model} />
          {model.connection === 'starting' && !model.sessionId ? <div class="starting inline"><Icon name="loading" spin /><span class="muted">Starting ClikCode…</span></div> : null}
          {model.connection === 'ready' && model.sessionId && empty ? <Welcome model={model} onPrompt={sendNow} onMenu={showMenu} /> : null}
          {!empty ? <DrawGuard model={model}><Transcript model={model} reveal={searchFocus?.messageIndex} /></DrawGuard> : null}
        </div>
        {model.approvals[0] ? (
          // One at a time, as the terminal asks: the rest wait their turn.
          <div class="approvals">
            <ApprovalCard key={model.approvals[0].id} approval={model.approvals[0]} workspace={model.workspace} position={1} total={model.approvals.length}
              onAnswer={(value, note) => {
                post({ type: 'approve', id: model.approvals[0]!.id, approved: value });
                // Denied with a note: the note goes into the running turn, as
                // a message typed during it does (a steer).
                if (note) post({ type: 'send', text: note, id: uid() });
              }} />
          </div>
        ) : null}
        {search ? <SearchBar focus={search} /> : null}
        <Composer model={model} handle={composer} onError={setError} />
      </main>
      {question ? <Sheet key={question.id} question={question} items={question.items} answer={(result) => answer(question.id, result)} /> : null}
      {error ? <Toast message={error} onClose={() => setError(undefined)} /> : null}
    </div>
  );
}

window.addEventListener('error', (event) => post({ type: 'log', text: `${event.message} ${event.filename}:${event.lineno}` }));
window.addEventListener('unhandledrejection', (event) => post({ type: 'log', text: `unhandled: ${String((event.reason as Error)?.stack ?? event.reason)}` }));
render(<App />, document.getElementById('app')!);
