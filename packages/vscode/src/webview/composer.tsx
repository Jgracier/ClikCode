/** The message box: text with / commands and @ files, attached selections
 * and images, and the footer that chooses provider·model, effort and
 * permissions for this chat. */
import { usageLabelIsSpent } from '../../../../src/tui/render/usage-words';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { chatModelLabel, currentProvider, providerDisplayName, type ChatModel } from '../model';
import type { IdeSlashCommand } from '../protocol';
import { commandPaletteMatches, type PaletteEntry } from '../../../../src/tui/command-palette';
import type { Mention } from '../webview-protocol';
import { selectionBlock } from '../editor-context';
import { post, request, save, saved, uid } from './bus';
import { formatTurnUsage, titleCase } from './format';
import { EffortMenu, effortLabel, knownProviders, ModeMenu, permissionLabel, providerChoosesModel, ProviderModelPicker } from './picker';
import { Icon, KeyList, type ListRow } from './ui';

type Menu = 'provider' | 'model' | 'effort' | 'mode' | undefined;

export interface ComposerHandle {
  focus(): void;
  hasText(): boolean;
  insert(text: string): void;
  setDraft(text: string): void;
  mention(mention: Mention): void;
  /** The editor's current selection (none: nothing selected). */
  selection(mention: Mention | undefined): void;
}

interface Attachment { key: string; kind: 'selection' | 'image'; label: string; mention?: Mention; path?: string }

const sameRange = (left: Mention | undefined, right: Mention): boolean =>
  left?.path === right.path && left.startLine === right.startLine && left.endLine === right.endLine;

const lineCount = (mention: Mention): number => (mention.endLine ?? 1) - (mention.startLine ?? 1) + 1;

/** The command list, for the conversation on the provider and model it had
 * when read: another provider has other commands (its own skills, its own
 * built-ins). */
let slashCache: { key: string; at: number; commands: readonly PaletteEntry[] } | undefined;
/** The vendor lists behind the values (models, efforts) load in the
 * background; a list read this long ago is read again for what arrived. */
const SLASH_FRESH_MS = 20_000;

/** A bridge command row as the terminal palette's entry, so the same matcher
 * (command-palette.ts) ranks and completes it. */
export function paletteEntry(item: IdeSlashCommand): PaletteEntry {
  return {
    label: item.command, value: item.command, detail: item.description,
    ...(item.argHint ? { argHint: item.argHint } : {}), ...(item.group ? { group: item.group } : {}),
    ...(item.aliases?.length ? { aliases: item.aliases } : {}),
    ...(item.argValues?.length ? { argValues: () => item.argValues! } : {}),
  };
}

/** The prompts ↑ and ↓ step through: this conversation's own, oldest first,
 * repeats in a row once -- as the terminal recalls what was typed, though
 * read from the transcript so every tab and window on it has them. */
export function promptHistory(messages: ReadonlyArray<{ role: string; content: string }>): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || !message.content.trim()) continue;
    if (prompts[prompts.length - 1] !== message.content) prompts.push(message.content);
  }
  return prompts.slice(-200);
}

/** The @ or / token the caret is in, if any. A / command is the whole first
 * line up to the caret, its argument included, so `/model op` lists models. */
export function tokenAtCaret(text: string, caret: number): { kind: '@' | '/'; query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const slash = /^\/([\w:-]*(?: [^\n]*)?)$/.exec(before);
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
  /** The editor's selection, sent with the next message unless excluded; a
   * message takes it once, and a new selection offers it again. */
  const [selection, setSelection] = useState<{ mention: Mention; included: boolean }>();
  const [menu, setMenu] = useState<Menu>();
  const [suggestions, setSuggestions] = useState<ListRow[]>([]);
  const [dismissedToken, setDismissedToken] = useState<string>();
  /** Where ↑/↓ are in the history, and the draft they left. */
  const recall = useRef<{ index: number; draft: string }>();
  const history = useMemo(() => promptHistory(model.messages), [model.messages]);
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
    selection: (mention) => setSelection(mention ? { mention, included: true } : undefined),
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
      const cacheKey = `${model.sessionId}|${model.providerId}|${model.model}`;
      const cached = slashCache;
      const load = cached?.key === cacheKey && Date.now() - cached.at < SLASH_FRESH_MS ? Promise.resolve(cached.commands)
        : request<IdeSlashCommand[]>({ method: 'query', query: 'slash-commands' }).then((commands) => {
          const entries = commands.map(paletteEntry);
          slashCache = { key: cacheKey, at: Date.now(), commands: entries };
          return entries;
        });
      load.then((commands) => {
        if (!live) return;
        const line = `/${token.query}`;
        const rows: ListRow[] = [];
        let group: string | undefined;
        for (const item of commandPaletteMatches(line, commands).slice(0, 80)) {
          if (!item.completes && item.group && item.group !== group) { group = item.group; const heading = group; rows.push({ key: `h:${heading}`, heading: true, render: () => <>{heading}</> }); }
          // A value row runs its whole command line; a command that takes
          // values or a required argument is filled in so they can be chosen.
          const run = (command: string): void => { setText(''); save({ draft: '' }); setSuggestions([]); post({ type: 'send', text: command, id: uid() }); };
          const fill = Boolean(!item.completes && ((item.argHint && !/^\[/.test(item.argHint)) || item.argValues));
          rows.push({
            key: item.value,
            onSelect: () => {
              if (item.completes) run(item.value);
              // The command's own free-text argument, as typed.
              else if (line.includes(' ')) run(line.trim());
              else if (fill) replace(`${item.value} `);
              else run(item.value);
            },
            render: () => (
              <div class="row">
                <span class="row-main">
                  <span class={`row-label${item.completes ? '' : ' mono'}`}>{item.completes ? item.label : item.value}{!item.completes && item.argHint ? <span class="muted"> {item.argHint}</span> : null}</span>
                  {item.detail ? <span class="row-detail">{item.detail}</span> : null}
                </span>
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
  }, [tokenKey, token?.query, model.sessionId, model.providerId, model.model]);

  const send = (): void => {
    const offered = selection?.included && !attachments.some((item) => sameRange(item.mention, selection.mention))
      ? [{ kind: 'selection' as const, mention: selection.mention }] : [];
    if (!text.trim() && !attachments.length) return;
    const message = composeMessage(text, [...attachments, ...offered]);
    if (!message || !connected) return;
    post({ type: 'send', text: message, id: uid() });
    recall.current = undefined;
    setText('');
    setAttachments([]);
    if (offered.length) setSelection({ mention: selection!.mention, included: false });
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
    // ↑ on the first line and ↓ on the last step through earlier prompts, as
    // in the terminal; Ctrl+P / Ctrl+N anywhere. ↓ past the newest gives
    // back the draft that was there.
    const element = textarea.current;
    const up = (event.key === 'ArrowUp' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) || (event.ctrlKey && event.key === 'p');
    const down = (event.key === 'ArrowDown' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) || (event.ctrlKey && event.key === 'n');
    if (element && (up || down) && element.selectionStart === element.selectionEnd) {
      const onFirstLine = !text.slice(0, element.selectionStart).includes('\n');
      const onLastLine = !text.slice(element.selectionEnd).includes('\n');
      if ((up && (event.ctrlKey || onFirstLine) && history.length) || (down && (event.ctrlKey || onLastLine) && recall.current)) {
        const at = recall.current ?? { index: history.length, draft: text };
        const index = up ? Math.max(0, at.index - 1) : at.index + 1;
        event.preventDefault();
        if (index >= history.length) { recall.current = undefined; update(at.draft); return; }
        recall.current = { index, draft: at.draft };
        update(history[index]!);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape' && model.running) {
      event.preventDefault();
      // A pending approval is what Esc answers first (denied), as in the terminal.
      if (model.approvals[0]) post({ type: 'approve', id: model.approvals[0].id, approved: false });
      else post({ type: 'cancel', restoreDraft: !text });
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
            <div key={item.id} class="queued-item">
              <Icon name={item.command ? 'terminal-cmd' : 'clock'} /><span class="queued-text" title={item.text}>{item.text}</span>
              <span class="muted">queued</span>
              <button type="button" class="icon-button tiny" title="Edit: take it back into the message box" aria-label="Edit queued message"
                onClick={() => { post({ type: 'unqueue', id: item.id }); props.handle.current?.insert(item.text); }}><Icon name="edit" /></button>
              <button type="button" class="icon-button tiny" title="Remove from the queue" aria-label="Remove queued message"
                onClick={() => post({ type: 'unqueue', id: item.id })}><Icon name="close" /></button>
            </div>
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
        {selection && !attachments.some((item) => sameRange(item.mention, selection.mention)) ? (
          <div class={`selection-context${selection.included ? '' : ' excluded'}`}>
            <button type="button" class="link small" aria-pressed={selection.included}
              title={selection.included ? 'Sent with your next message. Click to leave it out.' : 'Click to send it with your next message.'}
              onClick={() => setSelection({ ...selection, included: !selection.included })}>
              <Icon name={selection.included ? 'eye' : 'eye-closed'} />
              <span>{lineCount(selection.mention)} line{lineCount(selection.mention) === 1 ? '' : 's'} selected</span>
              <span class="muted">{selection.mention.label.split(/[\\/]/).pop()}</span>
            </button>
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
          onInput={(event) => { const element = event.target as HTMLTextAreaElement; recall.current = undefined; setText(element.value); setCaret(element.selectionStart); save({ draft: element.value }); setDismissedToken(undefined); }}
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
          {model.accountUsage ? (
            <button type="button" class={`composer-usage${usageLabelIsSpent(model.accountUsage) ? ' spent' : ''}`} title="Accounts and usage" onClick={() => props.onOpenScreen('accounts')}>{model.accountUsage}</button>
          ) : null}
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
        {account && (account.problem || account.label.toLowerCase() !== providerName.toLowerCase()) ? (
          <button type="button" class="status-account" title={`${account.label}: accounts and usage`} onClick={() => props.onOpenScreen('accounts')}>
            <Icon name={account.problem ? 'warning' : 'account'} />{account.label.toLowerCase() !== providerName.toLowerCase() ? <span class="status-label">{account.label}</span> : null}
          </button>
        ) : null}
        <span class="spacer" />
        {busy && !installing ? <span class="muted busy"><Icon name="loading" spin /> {busy}</span> : null}
        {tokens ? <span class="muted" title="Tokens used by the last turn">{tokens}</span> : null}
      </div>
    </div>
  );
}
