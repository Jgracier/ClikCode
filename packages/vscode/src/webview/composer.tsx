/** The message box: text with / commands and @ files, attached selections
 * and images, and the footer that chooses provider·model, effort and
 * permissions for this chat. */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { chatModelLabel, currentProvider, providerDisplayName, type ChatModel } from '../model';
import type { IdeSlashCommand } from '../protocol';
import type { Mention } from '../webview-protocol';
import { selectionBlock } from '../editor-context';
import { post, request, save, saved, uid } from './bus';
import { formatTurnUsage, titleCase } from './format';
import { EffortMenu, effortLabel, knownProviders, ModeMenu, permissionLabel, providerChoosesModel, ProviderModelPicker } from './picker';
import { UsageBars } from './screens';
import { Icon, KeyList, type ListRow } from './ui';

type Menu = 'provider' | 'model' | 'effort' | 'mode' | undefined;

export interface ComposerHandle {
  focus(): void;
  hasText(): boolean;
  insert(text: string): void;
  setDraft(text: string): void;
  mention(mention: Mention): void;
}

interface Attachment { key: string; kind: 'selection' | 'image'; label: string; mention?: Mention; path?: string }

let slashCache: { session?: string; commands: IdeSlashCommand[] } | undefined;

/** The @ or / token the caret is in, if any. */
export function tokenAtCaret(text: string, caret: number): { kind: '@' | '/'; query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const slash = /^\/([\w:-]*)$/.exec(before);
  if (slash) return { kind: '/', query: slash[1]!, start: 0 };
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: '@', query: at[1]!, start: caret - at[1]!.length - 1 };
  return undefined;
}

/** What is sent: the typed text, then each attached selection as a fenced
 * block, then each pasted image's path (ClikCode attaches image paths it
 * finds in a message). */
export function composeMessage(text: string, attachments: ReadonlyArray<{ kind: 'selection' | 'image'; mention?: Mention; path?: string }>): string {
  const blocks = attachments.flatMap((attachment) => {
    if (attachment.kind === 'image' && attachment.path) return [attachment.path];
    const mention = attachment.mention;
    if (!mention?.text) return mention ? [`@${mention.label}`] : [];
    return [selectionBlock({ path: mention.label, languageId: mention.languageId ?? '', startLine: mention.startLine ?? 1, endLine: mention.endLine ?? 1, text: mention.text })];
  });
  return [text.trim(), ...blocks].filter(Boolean).join('\n\n');
}

export function Composer(props: {
  model: ChatModel;
  handle: { current: ComposerHandle | null };
  onError: (message: string) => void;
  onOpenScreen: (screen: 'accounts' | 'settings') => void;
}): JSX.Element {
  const { model } = props;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(saved().draft ?? '');
  const [caret, setCaret] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menu, setMenu] = useState<Menu>();
  const [suggestions, setSuggestions] = useState<ListRow[]>([]);
  const [dismissedToken, setDismissedToken] = useState<string>();
  const connected = model.connection === 'ready' && Boolean(model.sessionId);
  const structured = (model.revision ?? 1) >= 2;

  const autosize = (): void => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 280)}px`;
    element.style.overflowY = element.scrollHeight > 280 ? 'auto' : 'hidden';
  };
  useEffect(autosize, [text]);
  const update = (value: string, at = value.length): void => {
    setText(value);
    save({ draft: value });
    setCaret(at);
    requestAnimationFrame(() => {
      const element = textarea.current;
      if (element) { element.focus(); element.setSelectionRange(at, at); }
    });
  };

  props.handle.current = {
    focus: () => textarea.current?.focus(),
    hasText: () => Boolean(text.trim()) || attachments.length > 0,
    insert: (value) => update(text ? `${text.replace(/\s*$/, '')}\n\n${value}` : value),
    setDraft: (value) => update(value),
    mention: (mention) => {
      if (mention.text) {
        setAttachments((items) => [...items, { key: uid(), kind: 'selection', label: `${mention.label.split('/').pop()}:${mention.startLine}${mention.endLine !== mention.startLine ? `-${mention.endLine}` : ''}`, mention }]);
        textarea.current?.focus();
      } else {
        const spacer = text && !/\s$/.test(text) ? ' ' : '';
        update(`${text}${spacer}@${mention.label} `);
      }
    },
  };

  const token = tokenAtCaret(text, caret);
  const tokenKey = token ? `${token.kind}${token.start}` : undefined;

  // Suggestions for the token under the caret.
  useEffect(() => {
    if (!token || tokenKey === dismissedToken) { setSuggestions([]); return undefined; }
    let live = true;
    const replace = (value: string): void => {
      const next = `${text.slice(0, token.start)}${value}${text.slice(caret)}`;
      update(next, token.start + value.length);
    };
    if (token.kind === '/') {
      const cachedSlash = slashCache;
      const load = cachedSlash && cachedSlash.session === model.sessionId ? Promise.resolve(cachedSlash.commands)
        : request<IdeSlashCommand[]>({ method: 'query', query: 'slash-commands' }).then((commands) => { slashCache = { session: model.sessionId, commands }; return commands; });
      load.then((commands) => {
        if (!live) return;
        const query = token.query.toLowerCase();
        const matching = commands.filter((item) => item.command.slice(1).toLowerCase().startsWith(query) || (query.length > 1 && item.command.toLowerCase().includes(query)));
        const rows: ListRow[] = [];
        let group: string | undefined;
        for (const item of matching.slice(0, 60)) {
          if (!query && item.group && item.group !== group) { group = item.group; const heading = group; rows.push({ key: `h:${heading}`, heading: true, render: () => <>{heading}</> }); }
          rows.push({
            key: item.command,
            onSelect: () => {
              if (item.argHint && !/^\[/.test(item.argHint)) replace(`${item.command} `);
              else { setText(''); save({ draft: '' }); setSuggestions([]); post({ type: 'send', text: item.command, id: uid() }); }
            },
            render: () => (
              <div class="row">
                <span class="row-main"><span class="row-label mono">{item.command}{item.argHint ? <span class="muted"> {item.argHint}</span> : null}</span><span class="row-detail">{item.description}</span></span>
              </div>
            ),
          });
        }
        setSuggestions(rows);
      }, () => setSuggestions([]));
    } else {
      const timer = setTimeout(() => {
        request<Mention[]>({ method: 'files', text: token.query }).then((files) => {
          if (!live) return;
          setSuggestions(files.map((file) => ({
            key: file.path,
            onSelect: () => replace(`@${file.label} `),
            render: () => {
              const slash = file.label.lastIndexOf('/');
              return (
                <div class="row">
                  <span class="row-check"><Icon name="file" /></span>
                  <span class="row-main"><span class="row-label">{file.label.slice(slash + 1)}</span><span class="row-detail">{slash > 0 ? file.label.slice(0, slash) : ''}</span></span>
                </div>
              );
            },
          })));
        }, () => setSuggestions([]));
      }, 80);
      return () => { live = false; clearTimeout(timer); };
    }
    return () => { live = false; };
  }, [tokenKey, token?.query, model.sessionId]);

  const send = (): void => {
    const message = composeMessage(text, attachments);
    if (!message || !connected) return;
    post({ type: 'send', text: message, id: uid() });
    setText('');
    setAttachments([]);
    save({ draft: '' });
    setSuggestions([]);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (suggestions.length) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissedToken(tokenKey); return; }
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key) || (event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        // The KeyList listens on this textarea; Tab chooses like Enter.
        if (event.key === 'Tab') {
          event.preventDefault();
          textarea.current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape' && model.running) {
      event.preventDefault();
      post({ type: 'cancel', restoreDraft: !text });
    } else if (event.key === 'Backspace' && !text && attachments.length) {
      setAttachments((items) => items.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent): void => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result).split(',')[1] ?? '';
        request<string>({ method: 'saveImage', name: file.name || 'pasted.png', dataBase64: data }).then((path) => {
          setAttachments((items) => [...items, { key: uid(), kind: 'image', label: file.name || 'image', path }]);
        }, (failure: Error) => props.onError(failure.message));
      };
      reader.readAsDataURL(file);
    }
  };

  const providerName = providerDisplayName(model, knownProviders()) ?? 'Choose provider';
  const modelName = chatModelLabel(model, providerName);
  const effort = model.chatSettings?.effort;
  const showSuggestions = suggestions.length > 0 && !menu;
  const account = model.currentAccount;
  const busy = model.busy;
  const installing = busy && /^(installing|waiting for another ClikCode to finish installing)/i.test(busy);
  const tokens = formatTurnUsage(model.turnUsage) || undefined;

  const placeholder = !connected ? 'ClikCode is not connected'
    : model.running ? 'Steer the running turn, or queue a message…'
      : `Ask ${providerDisplayName(model, knownProviders()) ?? 'ClikCode'} anything`;

  const footerButton = useMemo(() => (name: Menu, content: JSX.Element, label: string, id: string) => (
    <button type="button" id={id} class={`chip-button${menu === name ? ' open' : ''}`} data-popover-anchor aria-haspopup="dialog" aria-expanded={menu === name}
      title={label} aria-label={label} disabled={!connected} onClick={() => setMenu(menu === name ? undefined : name)}>
      {content}
    </button>
  ), [menu, connected]);

  return (
    <div class="composer-wrap">
      {installing ? (
        <div class="install-card" role="status">
          <div class="install-text"><Icon name="cloud-download" /> {titleCase(busy!.replace(/…$/, ''))}…</div>
          <div class="progress indeterminate"><div /></div>
        </div>
      ) : null}
      {model.queued.length ? (
        <div class="queued" aria-label="Queued messages">
          {model.queued.map((item) => (
            <div key={item.id} class="queued-item"><Icon name={item.command ? 'terminal-cmd' : 'clock'} /><span>{item.text}</span><span class="muted">queued</span></div>
          ))}
        </div>
      ) : null}
      <div class="composer-box" data-running={model.running ? 'true' : undefined}>
        {menu === 'provider' ? <ProviderModelPicker mode="provider" model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {menu === 'model' ? <ProviderModelPicker key={model.providerId} mode="model" model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {menu === 'effort' ? <EffortMenu model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {menu === 'mode' ? <ModeMenu model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {showSuggestions ? (
          <div class="popover suggestions" role="dialog" aria-label={token?.kind === '/' ? 'Commands' : 'Files'}>
            <KeyList id="suggestions" rows={suggestions} label={token?.kind === '/' ? 'Commands' : 'Files'} inputRef={textarea as unknown as { current: HTMLInputElement | null }} onEscape={() => setDismissedToken(tokenKey)} />
          </div>
        ) : null}
        {attachments.length ? (
          <div class="attachments">
            {attachments.map((attachment) => (
              <span key={attachment.key} class="attachment" title={attachment.mention?.label ?? attachment.path}>
                <Icon name={attachment.kind === 'image' ? 'file-media' : 'code'} />
                <span>{attachment.label}</span>
                <button type="button" class="icon-button tiny" aria-label={`Remove ${attachment.label}`} onClick={() => setAttachments((items) => items.filter((item) => item !== attachment))}><Icon name="close" /></button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea id="composer-input" ref={textarea} rows={1} value={text} placeholder={placeholder} aria-label="Message ClikCode"
          aria-autocomplete="list" aria-controls={showSuggestions ? 'suggestions' : undefined} disabled={!connected}
          onInput={(event) => { const element = event.target as HTMLTextAreaElement; setText(element.value); setCaret(element.selectionStart); save({ draft: element.value }); setDismissedToken(undefined); }}
          onKeyUp={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart)}
          onClick={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={onKeyDown} onPaste={onPaste} />
        <div class="composer-footer">
          {structured ? footerButton('provider', <><span class="chip-text">{providerName}</span><Icon name="chevron-down" /></>, `Provider: ${providerName}`, 'provider-button')
            : <button type="button" class="chip-button" disabled={!connected} onClick={() => post({ type: 'send', text: '/provider', id: uid() })}><span class="chip-text">{providerName}</span><Icon name="chevron-down" /></button>}
          {structured && providerChoosesModel(model.providerId) ? footerButton('model', <><span class="chip-text">{modelName ?? 'Default model'}</span><Icon name="chevron-down" /></>, `Model: ${modelName ?? 'default'}`, 'model-button') : null}
          {structured && effort ? footerButton('effort', <><Icon name="lightbulb" /><span class="chip-text">{effort.current && effort.current !== 'default' ? effortLabel(effort.current) : 'Effort'}</span></>, `Reasoning effort: ${effortLabel(effort.current)}`, 'effort-button') : null}
          {structured && model.chatSettings?.permissions ? footerButton('mode', <><Icon name={model.chatSettings.plan ? 'list-tree' : model.permissions === 'bypass' ? 'unlock' : 'shield'} /><span class="chip-text">{model.chatSettings.plan ? 'Plan' : permissionLabel(model.permissions)}</span></>, `Permissions: ${model.chatSettings.plan ? 'Plan mode' : permissionLabel(model.permissions)}`, 'mode-button') : null}
          <span class="spacer" />
          <button type="button" class="icon-button" aria-label="Mention a file" title="Mention a file (@)" disabled={!connected}
            onClick={() => { const spacer = text && !/\s$/.test(text) ? ' ' : ''; update(`${text}${spacer}@`); }}><Icon name="mention" /></button>
          <button type="button" class="icon-button" aria-label="Commands" title="Commands (/)" disabled={!connected} onClick={() => update('/')}><span class="slash-glyph" aria-hidden="true">/</span></button>
          {model.running ? (
            <button type="button" id="stop-button" class="send stop" aria-label="Stop (Esc)" title="Stop (Esc)" onClick={() => post({ type: 'cancel', restoreDraft: !text })}><Icon name="debug-stop" /></button>
          ) : null}
          {!model.running || text.trim() ? (
            <button type="button" id="send-button" class="send" aria-label={model.running ? 'Send into the running turn' : 'Send (Enter)'} title={model.running ? 'Steer (Enter)' : 'Send (Enter)'}
              disabled={!connected || (!text.trim() && !attachments.length)} onClick={send}><Icon name={model.running ? 'debug-step-into' : 'arrow-up'} /></button>
          ) : null}
        </div>
      </div>
      <div class="composer-status">
        {account && (account.problem || account.usage?.windows?.length || account.usage?.label || account.label.toLowerCase() !== providerName.toLowerCase()) ? (
          <button type="button" class="status-account" title={`${account.label}: accounts and usage`} onClick={() => props.onOpenScreen('accounts')}>
            <Icon name={account.problem ? 'warning' : 'account'} />{account.label.toLowerCase() !== providerName.toLowerCase() ? <span class="status-label">{account.label}</span> : null}
            <UsageBars account={account} compact />
          </button>
        ) : model.accountUsage ? <span class="muted">{model.accountUsage}</span> : null}
        <span class="spacer" />
        {busy && !installing ? <span class="muted busy"><Icon name="loading" spin /> {busy}</span> : null}
        {tokens ? <span class="muted" title="Tokens used by the last turn">{tokens}</span> : null}
      </div>
    </div>
  );
}
