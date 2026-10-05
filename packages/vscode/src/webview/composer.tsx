/** The message box: text with / commands and @ files, attached selections
 * and images, and the footer that chooses provider·model, effort and
 * permissions for this chat. */
import { clikCodeNoticeBody, isClikCodeNotice } from '../../../../src/session/clikcode-notice';
import { COPIED_MS } from '../../../../src/harness/protocol/timings';
import { usageLabelIsSpent } from '../../../../src/tui/render/usage-words';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { chatModelLabel, currentProvider, providerDisplayName, queuedRowLabel, stopAndSendReady, type ChatModel } from '../model';
import type { IdeSlashCommand } from '../protocol';
import { commandPaletteMatches, type PaletteEntry } from '../../../../src/tui/command-palette';
import { pastePlaceholder } from '../../../../src/harness/protocol/turn-flow';
import { compactCount } from '../../../../src/harness/protocol/format';
import { buttonTitle } from '../../../../src/harness/protocol/wording';
import type { Mention } from '../webview-protocol';
import { problemsBlock, selectionBlock, splitEditorContext } from '../editor-context';
import { post, request, save, saved, uid } from './bus';
import { estimatedTokens, formatTurnUsage, titleCase } from './format';
import { AccountMenu, choose, EffortMenu, effortLabel, knownProviders, ModeMenu, modelWithEffort, permissionLabel, providerChoosesModel, ProviderModelPicker } from './picker';
import { Icon, KeyList, type ListRow } from './ui';

type Menu = 'provider' | 'model' | 'effort' | 'mode' | 'account' | undefined;

export interface ComposerHandle {
  focus(): void;
  hasText(): boolean;
  insert(text: string): void;
  setDraft(text: string): void;
  mention(mention: Mention): void;
  /** Opens the account menu under the message box. */
  accounts(): void;
}

/** A chip above the message box: lines referenced, an image, or a long
 * paste held as `[Pasted text #1 +40 lines]` (its `text` goes with the
 * message). */
interface Attachment { key: string; kind: 'selection' | 'image' | 'pasted'; label: string; mention?: Mention; path?: string; preview?: string; text?: string }

const sameRange = (left: Mention | undefined, right: Mention): boolean =>
  left?.path === right.path && left.startLine === right.startLine && left.endLine === right.endLine;


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
    // A notice ClikCode sent in the user's place is not something they typed.
    const typed = message.role === 'user' && !isClikCodeNotice(message.content) ? splitEditorContext(message.content).text : '';
    if (!typed.trim()) continue;
    if (prompts[prompts.length - 1] !== typed) prompts.push(typed);
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

/** What is sent: the typed text, then each attachment in order -- a long
 * paste's own text, a referenced range of lines as a fenced block (with the
 * problems VS Code reports in it), an image's path (ClikCode attaches image
 * paths it finds in a message). */
export function composeMessage(text: string, attachments: ReadonlyArray<{ kind: 'selection' | 'image' | 'pasted'; mention?: Mention; path?: string; text?: string }>): string {
  const blocks = attachments.flatMap((attachment) => {
    if (attachment.kind === 'pasted') return attachment.text?.trim() ? [attachment.text.replace(/\r\n/g, '\n').replace(/\n+$/, '')] : [];
    if (attachment.kind === 'image' && attachment.path) return [attachment.path];
    const mention = attachment.mention;
    if (!mention) return [];
    const problems = mention.problems?.length ? [problemsBlock(mention.label, mention.problems)] : [];
    if (!mention.text) return [`@${mention.label}`];
    return [selectionBlock({ path: mention.label, languageId: mention.languageId ?? '', startLine: mention.startLine ?? 1, endLine: mention.endLine ?? 1, text: mention.text }), ...problems];
  });
  return [text.trim(), ...blocks].filter(Boolean).join('\n\n');
}

export function Composer(props: {
  model: ChatModel;
  handle: { current: ComposerHandle | null };
  onError: (message: string) => void;
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
    // Enter again: nothing typed, a message already waiting in the queue --
    // stop the turn, and what waits is sent next at once.
    if (!text.trim() && !attachments.length && stopAndSendReady(model)) { post({ type: 'cancel', restoreDraft: false }); return; }
    if (!text.trim() && !attachments.length) return;
    const message = composeMessage(text, attachments);
    if (!message || !connected) return;
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
  const account = model.currentAccount;
  const busy = model.busy;
  const installing = busy && /^(installing|waiting for another ClikCode to finish installing)/i.test(busy);
  // What streamed since the vendor last counted is an estimate (`~`), as in
  // the terminal, until its own count covers it.
  const estimate = model.running && model.live ? estimatedTokens(model.live.text.length - (model.usageTextAt ?? 0)) : 0;
  // The context window has its own ring beside this; the line keeps to tokens.
  const usage = model.turnUsage && { ...model.turnUsage, contextUsed: undefined, contextWindow: undefined, contextPercent: undefined };
  const tokens = formatTurnUsage(usage, estimate) || undefined;

  // Enter on an empty box stops the turn and sends what waits: the hint goes
  // on the first message that would go, and only while Enter would do it.
  const stopAndSend = stopAndSendReady(model) && !text.trim() && !attachments.length;
  const firstWaiting = model.queued.findIndex((item) => !item.notification && !item.command);
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
      {model.signIn ? <SignInCard signIn={model.signIn} /> : null}
      {installing ? (
        <div class="install-card" role="status">
          <div class="install-text"><Icon name="cloud-download" /> {titleCase(busy!.replace(/…$/, ''))}…</div>
          <div class="progress indeterminate"><div /></div>
        </div>
      ) : null}
      {model.queued.length ? (
        <div class="queued" aria-label="Queued messages">
          {model.queued.map((item, index) => item.notification ? (
            // A notice ClikCode owes the agent (a background task's result,
            // work that was stopped): not the user's to edit.
            <div key={item.id} class="queued-item clikcode-notice"><Icon name="bell" /><span class="queued-text" title={clikCodeNoticeBody(item.text)}>ClikCode notice</span><span class="muted">next turn</span></div>
          ) : (
            <div key={item.id} class="queued-item">
              <Icon name={item.command ? 'terminal-cmd' : 'clock'} /><span class="queued-text" title={item.text}>{item.text}</span>
              <span class="muted">{queuedRowLabel(model, item, index === firstWaiting && stopAndSend)}</span>
              <button type="button" class="icon-button tiny" title="Edit: take it back into the message box" aria-label="Edit queued message"
                onClick={() => { post({ type: 'unqueue', id: item.id }); props.handle.current?.insert(item.text); }}><Icon name="edit" /></button>
              <button type="button" class="icon-button tiny" title="Remove from the queue" aria-label="Remove queued message"
                onClick={() => post({ type: 'unqueue', id: item.id })}><Icon name="close" /></button>
            </div>
          ))}
        </div>
      ) : null}
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
          <div class="attachments">
            {attachments.map((attachment) => (
              <span key={attachment.key} class={`attachment${attachment.preview ? ' with-thumb' : ''}${attachment.kind === 'pasted' ? ' pasted' : ''}`} title={attachment.mention?.label ?? attachment.path}>
                {attachment.preview ? <img class="attachment-thumb" src={attachment.preview} alt="" /> : <Icon name={attachment.kind === 'image' ? 'file-media' : attachment.kind === 'pasted' ? 'clippy' : 'code'} />}
                {attachment.kind === 'pasted' ? (
                  <button type="button" class="attachment-expand" title="Put the pasted text back in the message box, to edit" onClick={() => expandPaste(attachment)}>{attachment.label}</button>
                ) : <span>{attachment.label}</span>}
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
          {footerButton('provider', <><span class="chip-text">{providerName}</span><Icon name="chevron-down" /></>, `Provider: ${providerName}`, 'provider-button')}
          {/* Model and effort are one choice, as in Claude Code: `Opus Medium`. */}
          {providerChoosesModel(model.providerId)
            ? footerButton('model', <><span class="chip-text">{modelWithEffort(modelName, effort?.current)}</span><Icon name="chevron-down" /></>, `Model and effort: ${modelWithEffort(modelName, effort?.current)}`, 'model-button')
            : effort ? footerButton('effort', <><Icon name="lightbulb" /><span class="chip-text">{effort.current && effort.current !== 'default' ? effortLabel(effort.current) : 'Effort'}</span></>, `Reasoning effort: ${effortLabel(effort.current)}`, 'effort-button') : null}
          <span class="spacer" />
          {model.accountUsage ? (
            <span class={`composer-usage${usageLabelIsSpent(model.accountUsage) ? ' spent' : ''}`} title="This account's usage">{model.accountUsage}</span>
          ) : null}
          <button type="button" class="icon-button" aria-label="Mention a file" title="Mention a file (@)" disabled={!connected}
            onClick={() => { const spacer = text && !/\s$/.test(text) ? ' ' : ''; update(`${text}${spacer}@`); }}><Icon name="mention" /></button>
          <button type="button" class="icon-button" aria-label="Commands" title="Commands (/)" disabled={!connected} onClick={() => update('/')}><span class="slash-glyph" aria-hidden="true">/</span></button>
          {model.running ? (
            <button type="button" id="stop-button" class="send stop" aria-label="Stop" title="Stop" onClick={() => post({ type: 'cancel', restoreDraft: !text })}><Icon name="debug-stop" /></button>
          ) : null}
          {stopAndSend ? (
            <button type="button" id="send-button" class="send" data-stop-and-send="true" aria-label={buttonTitle('sendNow')} title={buttonTitle('sendNow')}
              disabled={!connected} onClick={send}><Icon name="debug-step-over" /></button>
          ) : !model.running || text.trim() ? (
            <button type="button" id="send-button" class="send" aria-label={model.running ? 'Send into the running turn' : 'Send (Enter)'} title={model.running ? 'Steer (Enter)' : 'Send (Enter)'}
              disabled={!connected || (!text.trim() && !attachments.length)} onClick={send}><Icon name={model.running ? 'debug-step-into' : 'arrow-up'} /></button>
          ) : null}
        </div>
      </div>
      <div class="composer-status">
        {menu === 'account' ? <AccountMenu model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {menu === 'mode' ? <ModeMenu model={model} onClose={() => setMenu(undefined)} onError={props.onError} /> : null}
        {/* The Gateway has no account of its own: its button is for its credit. */}
        {account || model.providerId === 'gateway' ? (
          <button type="button" id="account-button" class={`status-account${menu === 'account' ? ' open' : ''}`} data-popover-anchor aria-haspopup="dialog" aria-expanded={menu === 'account'}
            title={account ? `${account.label}: this provider's accounts` : 'Gateway credit'} disabled={!connected} onClick={() => setMenu(menu === 'account' ? undefined : 'account')}>
            <Icon name={account?.problem ? 'warning' : account ? 'account' : 'credit-card'} /><span class="status-label">{account?.label ?? 'Credit'}</span><Icon name="chevron-down" />
          </button>
        ) : null}
        {/* Permissions belong to how this chat runs, beside whose account it runs on. */}
        {model.chatSettings?.swarm ? (
          <button type="button" id="swarm-button" class={`status-account${model.chatSettings.swarm.enabled ? ' open' : ''}`} aria-pressed={model.chatSettings.swarm.enabled}
            title={model.chatSettings.swarm.enabled ? 'Swarm is on. Turn it off and this chat does its own work.' : 'Swarm is off. Turn it on and this chat can hand work to other accounts that have usage left.'}
            disabled={!connected} onClick={() => choose({ kind: 'swarm', enabled: !model.chatSettings?.swarm?.enabled }).catch((failure: Error) => props.onError(failure.message))}>
            <Icon name="hubot" /><span class="status-label">{model.chatSettings.swarm.enabled ? 'Turn swarm off' : 'Turn swarm on'}</span>
          </button>
        ) : null}
        {model.chatSettings?.permissions ? (
          <button type="button" id="mode-button" class={`status-account${menu === 'mode' ? ' open' : ''}`} data-popover-anchor aria-haspopup="dialog" aria-expanded={menu === 'mode'}
            title={`Permissions: ${model.chatSettings.plan ? 'Plan mode' : permissionLabel(model.permissions)}`} disabled={!connected} onClick={() => setMenu(menu === 'mode' ? undefined : 'mode')}>
            <Icon name={model.chatSettings.plan ? 'list-tree' : model.permissions === 'bypass' ? 'unlock' : 'shield'} />
            <span class="status-label">{model.chatSettings.plan ? 'Plan' : permissionLabel(model.permissions)}</span><Icon name="chevron-down" />
          </button>
        ) : null}
        <span class="spacer" />
        {busy && !installing && !model.signIn ? <span class="muted busy"><Icon name="loading" spin /> {busy}</span> : null}
        {/* One figure under the box: the context ring, the turn's tokens on
            hover; the tokens themselves only where no ring is reported. */}
        {model.context ? <ContextMeter context={model.context} tokens={tokens} />
          : tokens ? <span class="muted turn-tokens" title={model.running ? 'Tokens used by this turn so far' : 'Tokens used by the last turn'}>{tokens}</span> : null}
      </div>
    </div>
  );
}

/** How full the conversation's context window is, as a ring that fills; the
 * figures on hover, the breakdown (/context) on click. */
function ContextMeter({ context, tokens }: { context: NonNullable<ChatModel['context']>; tokens?: string }): JSX.Element {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const percent = context.percent;
  const figures = context.used ? `${compactCount(context.used)}${context.window ? ` of ${compactCount(context.window)}` : ''} tokens` : '';
  const label = `Context ${percent < 10 ? percent.toFixed(1) : Math.round(percent)}% used${figures ? ` (${figures})` : ''}`;
  return (
    <button type="button" class={`context-meter${percent >= 90 ? ' high' : percent >= 70 ? ' warn' : ''}`} title={`${label}${tokens ? `\nLast turn: ${tokens}` : ''}\nClick for the breakdown.`} aria-label={label}
      onClick={() => post({ type: 'send', text: '/context', id: uid() })}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={radius} class="context-track" />
        <circle cx="8" cy="8" r={radius} class="context-fill" stroke-dasharray={`${(percent / 100) * circumference} ${circumference}`} transform="rotate(-90 8 8)" />
      </svg>
      <span>{percent > 0 && percent < 1 ? '<1' : Math.round(percent)}%</span>
    </button>
  );
}

/** A sign-in in progress: its link opened in the browser and its code to
 * confirm there, once the vendor gives one; questions it asks come up as
 * sheets over it. Cancel ends it. Nothing is typed into a terminal. */
function SignInCard({ signIn }: { signIn: NonNullable<ChatModel['signIn']> }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div class="install-card signin-link" role="status" id="sign-in-link">
      <div class="install-text"><Icon name="key" /> {signIn.url ? `Sign in to ${signIn.name} in your browser` : `Signing in to ${signIn.name}…`}</div>
      {signIn.code ? (
        <div class="signin-code">
          <span class="muted">Confirm this code there</span>
          <code data-code>{signIn.code}</code>
          <button type="button" class="icon-button tiny" title={copied ? 'Copied' : 'Copy code'} aria-label={copied ? 'Copied' : 'Copy code'}
            onClick={() => { void navigator.clipboard?.writeText(signIn.code ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), COPIED_MS); }); }}>
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
        </div>
      ) : null}
      <div class="banner-actions">
        {signIn.url ? <button type="button" class="secondary" data-open onClick={() => post({ type: 'signInOpen', url: signIn.url! })}>Open the page again</button> : null}
        <button type="button" class="secondary" data-cancel onClick={() => post({ type: 'signInCancel', id: signIn.id })}>Cancel</button>
      </div>
      <div class="progress indeterminate"><div /></div>
    </div>
  );
}
