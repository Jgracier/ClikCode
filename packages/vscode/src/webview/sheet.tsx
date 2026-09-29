/** The terminal's pickers, drawn in the panel.
 *
 * Settings, the account manager, harness options, tools and MCP servers,
 * the conversation list with its row actions -- every picker ClikCode's
 * terminal has reaches the editor as a `ui-request` with the same rows. They
 * open here as a sheet over the chat (quick picks only when no chat is on
 * screen), with the terminal's keys: arrows, Enter, ← back, Esc out; a row's
 * actions as buttons, a setting with a few values as a segmented control. */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { IdePickItem, IdeUiRequest, IdeUiResult } from '../protocol';
import { clean } from './format';
import { Icon, KeyList, type ListRow } from './ui';

export interface OpenQuestion { id: string; request: IdeUiRequest }

const ACTION_ICONS: Record<string, string> = {
  reauthenticate: 'key', disconnect: 'debug-disconnect', history: 'history', verified: 'pass', rename: 'edit', fork: 'repo-forked',
  archive: 'archive', 'clear-provider': 'discard',
};

function actionIcon(value: string): string {
  if (ACTION_ICONS[value]) return ACTION_ICONS[value]!;
  if (value.startsWith('provider:') || value.startsWith('global:')) return 'pin';
  return 'ellipsis';
}

/** A title that names a screen -- Settings, Accounts -- fills the panel; a
 * short choice floats as a menu. */
export interface InlineTarget { title: string; label: string; value: string; steps: number }

/** A segmented setting is cycled one value per answer (the terminal's ←/→);
 * a click on a value further along keeps answering until it is reached. */
export function inlineStep(target: InlineTarget | undefined, request: IdeUiRequest): { index: number } | 'done' | undefined {
  if (!target || request.kind !== 'pick' || request.title !== target.title) return undefined;
  const index = request.items.findIndex((item) => item.label === target.label && item.inline);
  const item = request.items[index];
  if (!item?.inline || item.inline.current === target.value || target.steps <= 0) return 'done';
  return { index };
}

export function Sheet(props: { question: OpenQuestion; items?: readonly IdePickItem[]; answer: (result: IdeUiResult) => void; setInlineTarget?: (target: InlineTarget) => void }): JSX.Element {
  const { request } = props.question;
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); props.answer({ cancelled: true }); }
    };
    const panel = panelRef.current;
    panel?.addEventListener('keydown', onKey);
    return () => panel?.removeEventListener('keydown', onKey);
  }, [props.question.id]);
  return (
    <div class="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.answer({ cancelled: true }); }}>
      <div ref={panelRef} class="sheet" role="dialog" aria-modal="true" aria-label={request.kind === 'pick' ? request.title : request.prompt}>
        {request.kind === 'input'
          ? <InputSheet prompt={request.prompt} answer={props.answer} />
          : <PickSheet title={request.title} items={props.items ?? request.items} canGoBack={request.canGoBack} answer={props.answer} setInlineTarget={props.setInlineTarget} />}
      </div>
    </div>
  );
}

function InputSheet(props: { prompt: string; answer: (result: IdeUiResult) => void }): JSX.Element {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const secret = /key|token|secret|password/i.test(props.prompt);
  return (
    <form class="input-sheet" onSubmit={(event) => { event.preventDefault(); props.answer({ text }); }}>
      <label class="sheet-title" for="sheet-input">{props.prompt.replace(/\s*[›:]\s*$/, '')}</label>
      <input id="sheet-input" ref={input} type={secret ? 'password' : 'text'} value={text} autocomplete="off" spellcheck={false}
        onInput={(event) => setText((event.target as HTMLInputElement).value)} />
      <div class="sheet-actions">
        <button type="button" class="secondary" onClick={() => props.answer({ cancelled: true })}>Cancel</button>
        <button type="submit" class="primary">OK</button>
      </div>
    </form>
  );
}

function PickSheet(props: { title: string; items: readonly IdePickItem[]; canGoBack: boolean; answer: (result: IdeUiResult) => void; setInlineTarget?: (target: InlineTarget) => void }): JSX.Element {
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState<number>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, [props.title]);
  const query = search.trim().toLowerCase();
  const long = props.items.length > 4;

  const rows = useMemo((): ListRow[] => {
    const result: ListRow[] = [];
    let group: string | undefined;
    props.items.forEach((item, index) => {
      const detail = clean(item.detail);
      if (query && !`${item.label} ${detail}`.toLowerCase().includes(query)) return;
      if (item.group && item.group !== group) {
        group = item.group;
        const heading = item.group;
        result.push({ key: `h:${index}`, heading: true, render: () => <>{heading}</> });
      }
      const current = /(^|·\s*)current\b/.test(detail);
      const shownDetail = detail.replace(/(^|\s*·\s*)current\b/, '').replace(/^\s*·\s*/, '').trim();
      result.push({
        key: `i:${index}`,
        onSelect: () => props.answer({ index }),
        render: () => (
          <div class="row sheet-row">
            <span class="row-check">{current ? <Icon name="check" /> : null}</span>
            <span class="row-main">
              <span class="row-label">{item.label.trim()}{item.argHint ? <span class="muted"> {item.argHint}</span> : null}</span>
              {shownDetail && !item.inline ? <span class="row-detail">{shownDetail}</span> : null}
            </span>
            {item.inline ? (
              <span class="segmented" role="radiogroup" aria-label={item.label} data-row-action>
                {item.inline.choices.map((choice) => (
                  <button key={choice.value} type="button" role="radio" aria-checked={choice.value === item.inline!.current}
                    class={choice.value === item.inline!.current ? 'on' : ''}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (choice.value === item.inline!.current) return;
                      props.setInlineTarget?.({ title: props.title, label: item.label, value: choice.value, steps: item.inline!.choices.length });
                      props.answer({ index });
                    }}>
                    {choice.label}
                  </button>
                ))}
              </span>
            ) : null}
            <span class="row-actions" data-row-action>
              {(item.actions ?? []).map((action) => (
                <button key={action.value} type="button" class="icon-button" title={action.label} aria-label={`${action.label}: ${item.label.trim()}`}
                  onClick={(event) => { event.stopPropagation(); props.answer({ index, action: action.value }); }}>
                  <Icon name={actionIcon(action.value)} />
                </button>
              ))}
              {item.deleteAction ? (confirming === index ? (
                <button type="button" class="danger small" onClick={(event) => { event.stopPropagation(); props.answer({ index, action: item.deleteAction!.value }); }}>
                  {item.deleteAction.label}?
                </button>
              ) : (
                <button type="button" class="icon-button" title={item.deleteAction.label} aria-label={`${item.deleteAction.label}: ${item.label.trim()}`}
                  onClick={(event) => { event.stopPropagation(); setConfirming(index); }}>
                  <Icon name="trash" />
                </button>
              )) : null}
            </span>
          </div>
        ),
      });
    });
    return result;
  }, [props.items, query, confirming]);

  return (
    <div class={`pick-sheet${props.items.length > 10 ? ' tall' : ''}`}>
      <div class="sheet-head">
        {props.canGoBack
          ? <button type="button" class="icon-button" aria-label="Back" title="Back" onClick={() => props.answer({ cancelled: true, back: true })}><Icon name="arrow-left" /></button>
          : null}
        <span class="sheet-title">{props.title}</span>
        <button type="button" class="icon-button" aria-label="Close" title="Close (Esc)" onClick={() => props.answer({ cancelled: true })}><Icon name="close" /></button>
      </div>
      {long ? (
        <div class="search">
          <Icon name="search" />
          <input ref={input} type="text" value={search} placeholder="Filter…" aria-label={`Filter ${props.title}`}
            onInput={(event) => setSearch((event.target as HTMLInputElement).value)} />
        </div>
      ) : <input ref={input} class="visually-hidden" aria-label={props.title} readOnly />}
      <KeyList id="sheet-list" rows={rows} label={props.title} inputRef={input} emptyText="Nothing matches."
        onEscape={() => props.answer({ cancelled: true })}
        onBack={props.canGoBack ? () => props.answer({ cancelled: true, back: true }) : undefined} />
    </div>
  );
}
