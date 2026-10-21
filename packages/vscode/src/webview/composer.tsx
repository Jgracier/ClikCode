/** The message box: text with / commands and @ files, attached selections
 * and images, and the footer that chooses provider·model, effort and
 * permissions for this chat. */
import { usageLabelIsSpent } from '../../../../src/tui/render/usage-words';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { chatModelLabel, enterAgainReady, preparing, providerDisplayName, type ChatModel } from '../model';
import { pastePlaceholder } from '../../../../src/harness/protocol/turn-flow';
import { buttonTitle } from '../../../../src/harness/protocol/wording';
import type { Mention } from '../webview-protocol';
import { post, request, save, saved, uid } from './bus';
import { formatTurnUsage, titleCase } from './format';
import { AccountMenu, agentName, EffortMenu, effortLabel, knownProviders, ModeMenu, modelWithEffort, providerChoosesModel, ProviderModelPicker } from './picker';
import { MachineMenu } from './screens';
import { focusHere, Icon, KeyList, type ListRow } from './ui';
import { composeMessage, promptHistory, sameRange, tokenAtCaret, type Attachment } from './composer-text';
import { commandRows, fileRows } from './composer-suggestions';
import { AttachmentChips, BusyLine, ContextMeter, QueueRows, SignInCard, StatusButtons, type Menu } from './composer-parts';

export { composeMessage, paletteEntry, promptHistory, tokenAtCaret } from './composer-text';

export interface ComposerHandle {
  focus(): void;
  hasText(): boolean;
  insert(text: string): void;
  setDraft(text: string): void;
  mention(mention: Mention): void;
  /** Opens the account menu under the message box. */
  accounts(): void;
}


export function Composer(props: {
  model: ChatModel;
  handle: { current: ComposerHandle | null };
  onError: (message: string) => void;
  onOpenHistory?: () => void;
}): JSX.Element {
  const { model } = props;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(saved().draft ?? '');
  const [caret, setCaret] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menu, setMenu] = useState<Menu>();
  const [suggestions, setSuggestions] = useState<ListRow[]>([]);
  const [dismissedToken, setDismissedToken] = useState<string>();
  /** Where ↑/↓ are in the history, and the draft they left. */
  const recall = useRef<{ index: number; draft: string }>();
  /** Long pastes held as chips in this message so far: their numbers. */
  const pastes = useRef(0);
  const history = useMemo(() => promptHistory(model.messages), [model.messages]);
  const connected = model.connection === 'ready' && Boolean(model.sessionId);
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
    // A draft the bridge restores (a turn that failed) can arrive while the
    // user is in an editor: the caret is placed, the keyboard left alone.
    requestAnimationFrame(() => {
      focusHere(textarea.current);
      textarea.current?.setSelectionRange(at, at);
    });
  };

  props.handle.current = {
    focus: () => textarea.current?.focus(),
    hasText: () => Boolean(text.trim()) || attachments.length > 0,
    insert: (value) => update(text ? `${text.replace(/\s*$/, '')}\n\n${value}` : value),
    setDraft: (value) => update(text.trim() ? `${value}\n\n${text}` : value),
    mention: (mention) => {
      if (mention.text) {
        setAttachments((items) => [...items, { key: uid(), kind: 'selection', label: `${mention.label.split('/').pop()}:${mention.startLine}${mention.endLine !== mention.startLine ? `-${mention.endLine}` : ''}`, mention }]);
        textarea.current?.focus();
      } else {
        const spacer = text && !/\s$/.test(text) ? ' ' : '';
        update(`${text}${spacer}@${mention.label} `);
      }
    },
    accounts: () => setMenu('account'),
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
    const run = (command: string): void => {
      setText(''); save({ draft: '' }); setSuggestions([]);
      if (/^\/permissions?$/i.test(command.trim())) setMenu('mode');
      else post({ type: 'send', text: command, id: uid() });
    };
    const shown = (rows: ListRow[]): void => { if (live) setSuggestions(rows); };
    if (token.kind === '/') {
      commandRows(token.query, `${model.sessionId}|${model.providerId}|${model.model}`, { replace, run }).then(shown, () => setSuggestions([]));
      return () => { live = false; };
    }
    const timer = setTimeout(() => { fileRows(token.query, { replace }).then(shown, () => setSuggestions([])); }, 80);
    return () => { live = false; clearTimeout(timer); };
  }, [tokenKey, token?.query, model.sessionId, model.providerId, model.model]);

  const send = (): void => {
    // Enter again: nothing typed, a message already waiting. It goes into
    // the chat. The turn, and any sub-agent it started, keeps running.
    if (!text.trim() && !attachments.length && enterAgainReady(model)) { post({ type: 'send-queued' }); return; }
    if (!text.trim() && !attachments.length) return;
    const message = composeMessage(text, attachments);
    if (!message) return;
    if (!attachments.length && /^\/permissions?$/i.test(message.trim())) {
      setText(''); save({ draft: '' }); setSuggestions([]); setMenu('mode');
      return;
    }
    // Not connected is the controller's to wait out (send awaits the start):
    // the message is drawn at once and comes back as a draft if it fails.
    post({ type: 'send', text: message, id: uid() });
    recall.current = undefined;
    pastes.current = 0;
    setText('');
    setAttachments([]);
    save({ draft: '' });
    setSuggestions([]);
  };

  // Esc during a turn (stop, or deny a pending approval) is the page's
  // (main.tsx): it bubbles there unless the suggestions took it.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft' && !text && !attachments.length && !suggestions.length && props.onOpenHistory) {
      event.preventDefault();
      props.onOpenHistory();
      return;
    }
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
    } else if (event.key === 'Backspace' && !text && attachments.length) {
      setAttachments((items) => items.slice(0, -1));
    }
  };

  /** Images become attachments the agent reads from a private folder, each
   * shown as a thumbnail until it is sent. */
  const attachImages = (files: readonly File[]): void => {
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const preview = String(reader.result);
        const data = preview.split(',')[1] ?? '';
        request<string>({ method: 'saveImage', name: file.name || 'pasted.png', dataBase64: data }).then((path) => {
          setAttachments((items) => [...items, { key: uid(), kind: 'image', label: file.name || 'image', path, preview }]);
        }, (failure: Error) => props.onError(failure.message));
      };
      reader.readAsDataURL(file);
    }
  };

  /** A reference to lines, as a chip: `interactive.ts:50-51`. */
  const attachLines = (mention: Mention): void => {
    if (attachments.some((item) => sameRange(item.mention, mention))) return;
    const range = `${mention.startLine}${mention.endLine !== mention.startLine ? `-${mention.endLine}` : ''}`;
    setAttachments((items) => [...items, { key: uid(), kind: 'selection', label: `${mention.label.split(/[\\/]/).pop()}:${range}`, mention }]);
  };

  /** Text typed in at the caret, as a paste would have put it. */
  const insertAtCaret = (value: string): void => {
    const element = textarea.current;
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? text.length;
    update(`${text.slice(0, start)}${value}${text.slice(end)}`, start + value.length);
  };

  /** A long paste held as a chip (pastePlaceholder decides how long), as
   * Claude Code holds it: the box keeps what is being said about it. */
  const holdPaste = (pasted: string): boolean => {
    const label = pastePlaceholder(pasted, pastes.current + 1);
    if (!label) return false;
    pastes.current += 1;
    setAttachments((items) => [...items, { key: uid(), kind: 'pasted', label, text: pasted }]);
    textarea.current?.focus();
    return true;
  };

  /** A held paste put back into the box, to edit as text. */
  const expandPaste = (attachment: Attachment): void => {
    setAttachments((items) => items.filter((item) => item !== attachment));
    insertAtCaret(attachment.text ?? '');
  };

  /** A paste is what it refers to: an image is attached; lines copied from a
   * file become a reference to those lines, and copied files references to
   * them (pastedReference); a long text is held as a chip; anything else is
   * the text itself. */
  const onPaste = (event: ClipboardEvent): void => {
    const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
    if (images.length) { event.preventDefault(); attachImages(images); return; }
    const pasted = event.clipboardData?.getData('text/uri-list') || event.clipboardData?.getData('text/plain') || '';
    if (!pasted.includes('\n') && !/^file:\/\//i.test(pasted.trim())) {
      if (holdPaste(pasted)) event.preventDefault();
      return;
    }
    event.preventDefault();
    request<{ lines?: Mention; files?: Mention[] }>({ method: 'paste', text: pasted }).then((found) => {
      if (found.lines) { attachLines(found.lines); return; }
      if (found.files?.length) {
        for (const file of found.files.filter((item) => item.image)) {
          setAttachments((items) => [...items, { key: uid(), kind: 'image', label: file.label.split(/[\\/]/).pop() ?? file.label, path: file.path }]);
        }
        const others = found.files.filter((item) => !item.image);
        if (others.length) insertAtCaret(`${others.map((item) => `@${item.label}`).join(' ')} `);
        return;
      }
      if (!holdPaste(pasted)) insertAtCaret(pasted);
    }, () => { if (!holdPaste(pasted)) insertAtCaret(pasted); });
  };

  /** Dropped on the message box: files from the Explorer or a tab (VS Code
   * hands those over while Shift is held) become @-mentions; images from
   * anywhere become attachments. */
  const [dropping, setDropping] = useState(false);
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDropping(false);
    if (!connected) return;
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const images = [...transfer.files].filter((file) => file.type.startsWith('image/'));
    if (images.length) { attachImages(images); return; }
    const uris = (transfer.getData('text/uri-list') || transfer.getData('text/plain')).split(/\r?\n/).filter((line) => /^[a-z][\w+.-]*:/i.test(line.trim()));
    if (!uris.length) {
      if (transfer.files.length) props.onError('Only images can be dropped from outside VS Code. Hold Shift and drag files from the Explorer to mention them.');
      return;
    }
    request<Mention[]>({ method: 'mentions', uris }).then((mentions) => {
      if (!mentions.length) return;
      const spacer = text && !/\s$/.test(text) ? ' ' : '';
      update(`${text}${spacer}${mentions.map((mention) => `@${mention.label}`).join(' ')} `);
    }, (failure: Error) => props.onError(failure.message));
  };

  const providerName = providerDisplayName(model, knownProviders()) ?? 'Choose provider';
  const modelName = chatModelLabel(model, providerName);
  const effort = model.chatSettings?.effort;
  const showSuggestions = suggestions.length > 0 && !menu;
  const busy = model.busy;
  const installing = busy && /^(installing|waiting for another ClikCode to finish installing)/i.test(busy);
  // The last turn's tokens, once it has ended: a running turn shows what it
  // is doing and for how long, as the terminal's waiting line does, not a
  // count. The context window has its own ring beside this.
  const usage = !model.running && model.turnUsage && { ...model.turnUsage, contextUsed: undefined, contextWindow: undefined, contextPercent: undefined };
  const tokens = (usage && formatTurnUsage(usage)) || undefined;

  // Enter on an empty box puts the oldest waiting message into the chat.
  // The hint goes on that message, and only while Enter would do it.
  const enterAgain = enterAgainReady(model) && !text.trim() && !attachments.length;
  const firstWaiting = model.queued.findIndex((item) => !item.command);
  const placeholder = !connected ? 'ClikCode is not connected'
    : model.running ? (model.chatSettings?.send === 'queue' ? 'Queue a message for after this turn…' : 'Steer the running turn…')
      : `Ask ${providerDisplayName(model, knownProviders()) ?? 'ClikCode'} anything`;

  const footerButton = useMemo(() => (name: Menu, content: JSX.Element, label: string, id: string) => (
    <button type="button" id={id} class={`chip-button${menu === name ? ' open' : ''}`} data-popover-anchor aria-haspopup="dialog" aria-expanded={menu === name}
      title={label} aria-label={label} disabled={!connected} onClick={() => setMenu(menu === name ? undefined : name)}>
      {content}
    </button>
  ), [menu, connected]);

  return (
    <div class="composer-wrap">
      {/* A thin rule between the conversation and the composer, from where
          the working spinner sits to the account's usage and its reset at the
          right, as the terminal draws the rule above its own composer. */}
      <div class="composer-rule">
        <span class="rule-line" aria-hidden="true" />
        {model.accountUsage ? (
          <span class={`composer-usage${usageLabelIsSpent(model.accountUsage) ? ' spent' : ''}`} id="composer-usage"
            title={model.accountUsageDetail ? `This account's usage\n${model.accountUsageDetail}` : "This account's usage"}>
            <span class="usage-figure">{model.accountUsage}</span>
            {model.accountUsageNext ? <span class="usage-reset"> · {model.accountUsageNext}</span> : null}
          </span>
        ) : null}
      </div>
      {model.signIn ? <SignInCard signIn={model.signIn} /> : null}
      {installing ? (
        <div class="install-card" role="status">
          <div class="install-text"><Icon name="cloud-download" /> {titleCase(busy!.replace(/…$/, ''))}…</div>
          <div class="progress indeterminate"><div /></div>
        </div>
      ) : null}
      {model.queued.length ? <QueueRows model={model} enterAgain={enterAgain} firstWaiting={firstWaiting} /> : null}
      <div class={`composer-box${dropping ? ' dropping' : ''}`} data-running={model.running ? 'true' : undefined}
        onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; if (!dropping) setDropping(true); }}
        onDragLeave={(event) => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={onDrop}>
        {dropping ? <div class="drop-hint" aria-hidden="true"><Icon name="cloud-upload" /> Drop to attach · hold Shift to drop files from VS Code</div> : null}
        {menu === 'provider' ? <ProviderModelPicker mode="provider" model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {menu === 'model' ? <ProviderModelPicker key={model.providerId} mode="model" model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {menu === 'effort' ? <EffortMenu model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {showSuggestions ? (
          <div class="popover suggestions" role="dialog" aria-label={token?.kind === '/' ? 'Commands' : 'Files'}>
            <KeyList id="suggestions" rows={suggestions} label={token?.kind === '/' ? 'Commands' : 'Files'} inputRef={textarea as unknown as { current: HTMLInputElement | null }} onEscape={() => setDismissedToken(tokenKey)} />
          </div>
        ) : null}
        {attachments.length ? (
          <AttachmentChips attachments={attachments} onExpand={expandPaste} onRemove={(attachment) => setAttachments((items) => items.filter((item) => item !== attachment))} />
        ) : null}
        <textarea id="composer-input" ref={textarea} rows={1} value={text} placeholder={placeholder} aria-label="Message ClikCode"
          aria-autocomplete="list" aria-controls={showSuggestions ? 'suggestions' : undefined}
          onInput={(event) => { const element = event.target as HTMLTextAreaElement; recall.current = undefined; setText(element.value); setCaret(element.selectionStart); save({ draft: element.value }); setDismissedToken(undefined); }}
          onKeyUp={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart)}
          onClick={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={onKeyDown} onPaste={onPaste} />
        <div class="composer-footer">
          {footerButton('provider', <><span class="chip-text">{providerName}</span><Icon name="chevron-down" /></>, `Provider: ${providerName}`, 'provider-button')}
          {/* Model and effort are one choice, as in Claude Code: `Opus Medium`. */}
          {providerChoosesModel(model.providerId)
            ? footerButton('model', <>{model.agentId ? <><Icon name="hubot" />{agentName(model.agentId) ? <span class="chip-text">{agentName(model.agentId)} ·</span> : null}</> : null}<span class="chip-text">{modelWithEffort(modelName, effort?.current)}</span><Icon name="chevron-down" /></>,
              `${model.agentId ? `Agent: ${agentName(model.agentId) ?? 'selected'} · ` : ''}Model and effort: ${modelWithEffort(modelName, effort?.current)}`, 'model-button')
            : effort ? footerButton('effort', <><Icon name="lightbulb" /><span class="chip-text">{effort.current && effort.current !== 'default' ? effortLabel(effort.current) : 'Effort'}</span></>, `Reasoning effort: ${effortLabel(effort.current)}`, 'effort-button') : null}
          <span class="spacer" />
          <button type="button" class="icon-button" aria-label="Mention a file" title="Mention a file (@)" disabled={!connected}
            onClick={() => { const spacer = text && !/\s$/.test(text) ? ' ' : ''; update(`${text}${spacer}@`); }}><Icon name="mention" /></button>
          <button type="button" class="icon-button" aria-label="Commands" title="Commands (/)" disabled={!connected} onClick={() => update('/')}><span class="slash-glyph" aria-hidden="true">/</span></button>
          {model.running || preparing(model) ? (
            <button type="button" id="stop-button" class="send stop" aria-label={model.live?.stopping ? 'Stopping' : 'Stop'} title={model.live?.stopping ? 'Stopping' : 'Stop'}
              onClick={() => post({ type: 'cancel', restoreDraft: !text })}><Icon name="debug-stop" /></button>
          ) : null}
          {enterAgain ? (
            <button type="button" id="send-button" class="send" data-stop-and-send="true" aria-label={buttonTitle('sendNow')} title={buttonTitle('sendNow')}
              disabled={!connected} onClick={send}><Icon name="debug-step-over" /></button>
          ) : !model.running || text.trim() ? (
            <button type="button" id="send-button" class="send" aria-label={model.running ? 'Send into the running turn' : 'Send (Enter)'}
              title={model.running ? 'Steer (Enter)' : 'Send (Enter)'}
              disabled={!text.trim() && !attachments.length} onClick={send}><Icon name={model.running ? 'debug-step-into' : 'arrow-up'} /></button>
          ) : null}
        </div>
      </div>
      <div class="composer-status">
        {menu === 'account' ? <AccountMenu model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {menu === 'mode' ? <ModeMenu model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {menu === 'machines' ? <MachineMenu model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        <StatusButtons model={model} menu={menu} setMenu={setMenu} connected={connected} />
        <button type="button" id="machines-button" class={`status-account${menu === 'machines' ? ' open' : ''}`} data-popover-anchor aria-haspopup="dialog" aria-expanded={menu === 'machines'}
          title={`Machine: ${model.machine ?? 'This machine'}`} onClick={() => setMenu(menu === 'machines' ? undefined : 'machines')}>
          <Icon name="remote" /><span class="status-label">{model.machine ?? 'This machine'}</span><Icon name="chevron-down" />
        </button>
        <span class="spacer" />
        <BusyLine label={busy && !installing && !model.signIn ? busy : undefined} />
        {model.chatCost ? <span class="muted status-cost" title="What this chat has cost so far">{model.chatCost}</span> : null}
        {/* Context ring: fills as context window is used; figures on hover, breakdown on click. */}
        {model.context ? <ContextMeter context={model.context} tokens={tokens} />
          : tokens ? <span class="muted turn-tokens" title="Tokens used by the last turn">{tokens}</span> : null}
      </div>
    </div>
  );
}

