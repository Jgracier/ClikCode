/** Shared pieces: codicons, the logo, and a keyboard-driven list used by every
 * menu and picker in the panel. */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export function Icon({ name, label, spin }: { name: string; label?: string; spin?: boolean }): JSX.Element {
  return <i class={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`} {...(label ? { 'aria-label': label, role: 'img' } : { 'aria-hidden': 'true' })} />;
}

export function Logo({ size = 40 }: { size?: number }): JSX.Element {
  return (
    <svg class="logo" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" />
      <path class="logo-mark" d="M9 8l-2 1.5L9 11" /><path class="logo-mark" d="M15 8l2 1.5L15 11" /><path class="logo-mark" d="M12.8 7.5l-1.6 4" />
    </svg>
  );
}

export function IconButton(props: { icon: string; label: string; onClick: (event: MouseEvent) => void; disabled?: boolean; active?: boolean; class?: string; id?: string }): JSX.Element {
  return (
    <button type="button" id={props.id} class={`icon-button${props.active ? ' active' : ''}${props.class ? ` ${props.class}` : ''}`}
      title={props.label} aria-label={props.label} disabled={props.disabled} onClick={props.onClick}>
      <Icon name={props.icon} />
    </button>
  );
}

export interface ListRow {
  key: string;
  /** A section heading, not choosable. */
  heading?: boolean;
  disabled?: boolean;
  render: () => ComponentChildren;
  onSelect?: () => void;
}

/** A list the arrow keys walk, Enter chooses from, and the mouse can use too.
 * `inputRef` is the search field that keeps focus while the keys move the
 * highlight, as VS Code's own quick pick does. */
export function KeyList(props: {
  rows: ListRow[];
  label: string;
  inputRef?: { current: HTMLInputElement | null };
  onEscape?: () => void;
  onBack?: () => void;
  /** → on a row: open it (a provider's models). */
  onForward?: (key: string) => void;
  class?: string;
  emptyText?: string;
  id?: string;
}): JSX.Element {
  const choosable = props.rows.filter((row) => !row.heading && !row.disabled);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const activeKey = choosable[Math.min(active, choosable.length - 1)]?.key;
  const rowsKey = choosable.map((row) => row.key).join('\u0000');
  useEffect(() => { setActive(0); }, [rowsKey]);
  useLayoutEffect(() => {
    const element = listRef.current?.querySelector('[data-active="true"]');
    (element as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeKey]);
  const idFor = (key: string): string => `${props.id ?? 'list'}-row-${key.replace(/[^\w-]/g, '_')}`;

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(choosable.length - 1, value + 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); return; }
    if (event.key === 'PageDown') { event.preventDefault(); setActive((value) => Math.min(choosable.length - 1, value + 8)); return; }
    if (event.key === 'PageUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 8)); return; }
    if (event.key === 'Enter' && !event.isComposing) {
      const row = choosable.find((item) => item.key === activeKey);
      if (row?.onSelect) { event.preventDefault(); row.onSelect(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onEscape?.(); return; }
    const input = props.inputRef?.current;
    if (event.key === 'ArrowRight' && props.onForward && activeKey && (!input || input.selectionStart === input.value.length)) {
      event.preventDefault();
      props.onForward(activeKey);
      return;
    }
    const atStart = !input || (input.selectionStart === 0 && input.selectionEnd === 0);
    if ((event.key === 'ArrowLeft' && atStart && !input?.value) || (event.key === 'Backspace' && input && !input.value)) {
      if (props.onBack) { event.preventDefault(); props.onBack(); }
    }
  };

  // The search field's keys go to the handler of the latest render (a ref
  // set while rendering), never one an effect has not re-attached yet: typed
  // fast, Enter would otherwise choose from the list before the filtering.
  const latest = useRef(onKey);
  latest.current = onKey;
  useEffect(() => {
    const input = props.inputRef?.current;
    if (!input) return undefined;
    const handler = (event: KeyboardEvent): void => latest.current(event);
    input.addEventListener('keydown', handler);
    return () => input.removeEventListener('keydown', handler);
  }, [props.inputRef?.current]);
  useEffect(() => {
    props.inputRef?.current?.setAttribute('aria-activedescendant', activeKey ? idFor(activeKey) : '');
  });

  return (
    <div ref={listRef} class={`keylist${props.class ? ` ${props.class}` : ''}`} role="listbox" aria-label={props.label} id={props.id}
      tabIndex={props.inputRef ? -1 : 0} onKeyDown={props.inputRef ? undefined : onKey}>
      {props.rows.length === 0 && props.emptyText ? <div class="keylist-empty">{props.emptyText}</div> : null}
      {props.rows.map((row) => {
        if (row.heading) return <div key={row.key} class="keylist-heading" role="presentation">{row.render()}</div>;
        const isActive = row.key === activeKey;
        return (
          <div key={row.key} id={idFor(row.key)} role="option" aria-selected={isActive} aria-disabled={row.disabled || undefined}
            class={`keylist-row${isActive ? ' active' : ''}${row.disabled ? ' disabled' : ''}`} data-active={isActive ? 'true' : undefined}
            data-key={row.key}
            onMouseMove={() => { const index = choosable.indexOf(row); if (index >= 0 && index !== active) setActive(index); }}
            onClick={(event) => { if ((event.target as HTMLElement).closest('[data-row-action]')) return; if (!row.disabled) row.onSelect?.(); }}>
            {row.render()}
          </div>
        );
      })}
    </div>
  );
}

/** A floating panel over the composer; closes on Escape or a click outside. */
export function Popover(props: { onClose: () => void; children: ComponentChildren; label: string; class?: string; id?: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node) && !(event.target as HTMLElement).closest('[data-popover-anchor]')) props.onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    const focusable = ref.current?.querySelector<HTMLElement>('input, [role="listbox"], button');
    focusable?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);
  return <div ref={ref} class={`popover${props.class ? ` ${props.class}` : ''}`} role="dialog" aria-label={props.label} id={props.id}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); } }}>{props.children}</div>;
}

export function Meter({ usedPct, label }: { usedPct: number; label: string }): JSX.Element {
  const used = Math.max(0, Math.min(100, Math.round(usedPct)));
  const level = used >= 90 ? 'high' : used >= 70 ? 'mid' : 'low';
  return (
    <div class={`meter meter-${level}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={label}>
      <div class="meter-fill" style={{ width: `${used}%` }} />
    </div>
  );
}

export function Switch(props: { checked: boolean; label: string; onChange: (value: boolean) => void; disabled?: boolean; id?: string }): JSX.Element {
  return (
    <button type="button" role="switch" id={props.id} aria-checked={props.checked} aria-label={props.label} disabled={props.disabled}
      class={`switch${props.checked ? ' on' : ''}`} onClick={() => props.onChange(!props.checked)}>
      <span class="switch-knob" />
    </button>
  );
}
