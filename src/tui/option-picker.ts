/** The generic option picker: a titled list, type-to-filter, and per-option
 * actions. Everything it needs from the frame that owns the screen is passed
 * in as `host`, so the picker can be reasoned about without the painter and
 * the painter without the picker. */

import chalk from 'chalk';
import type { PickerOption, PickerSettings } from '../harness/prompter.js';
import { takeTerminalKeys } from './input-decoder.js';
import { keyHintFor } from '../harness/protocol/wording.js';
import { pickerConfirmsSelection, pickerDeletesSelection } from './command-palette.js';

/** How a list is drawn under the composer. `capacity` is its rows, or how
 * to work them out again on every paint -- the board fills the screen, and a
 * resize repaints it at the new height without asking the board. */
export interface PaletteLayout {
  capacity?: number | (() => number);
  hint?: string;
  hideCursor?: boolean;
  headings?: boolean;
}

/** What the picker needs from the frame that owns the screen. */
export interface OptionPickerHost {
  paint(
    composer: string, options: readonly PickerOption<string>[], selected: number,
    prompt: string, cursor: number, palette?: PaletteLayout,
  ): void;
  clearFrame(): void;
  setSelecting(selecting: boolean): void;
  /** Ctrl+L: the next paint redraws the whole screen, whatever the terminal
   * lost (a mobile resize, a remote redraw). */
  repair?(): void;
  /** For the sub-pickers an option's actions can open. */
  select<T>(
    title: string, options: readonly PickerOption<T>[],
    onAction?: (value: T, action: string) => Promise<void>,
    settings?: PickerSettings<T>,
  ): Promise<T | undefined>;
}

/** A second screen opened from a list -- a sub-list, a row's actions, a
 * delete confirmation -- has the keyboard until it closes. `open` returns
 * true when it settled the list; otherwise the list takes the keyboard back,
 * unless it finished meanwhile. */
export function asideOpener(list: {
  stopInput(): void; listen(): void; finished(): boolean; aside?(open: boolean): void;
}): (open: () => Promise<boolean>) => Promise<void> {
  return async (open) => {
    list.stopInput();
    list.aside?.(true);
    try {
      if (await open()) return;
    } finally {
      list.aside?.(false);
    }
    if (!list.finished()) list.listen();
  };
}

/** The confirmation every row's delete gets: Cancel first. */
export function confirmRowDelete(host: OptionPickerHost, option: PickerOption<unknown>, action: { label: string }): Promise<boolean | undefined> {
  return host.select(`${action.label} ${option.label}?`, [
    { label: 'Cancel', value: false },
    { label: `${action.label} ${option.label}`, value: true },
  ]);
}

/** Rows can land after a list opens, in stages (known ones, then fresh
 * ones): redraw at each, whether it resolved or not. */
export function redrawOnRefresh(refresh: PickerSettings<unknown>['refresh'], redraw: () => void): void {
  for (const stage of [refresh ?? []].flat()) void stage.then(redraw, redraw);
}

/** How the last picker closed. A menu that opened a sub-picker reopens
 * itself unless the user left with Esc (see the Settings loop): ← goes back
 * one level, Esc leaves them all. */
export let lastPickerExit: 'choose' | 'back' | 'escape' = 'choose';

/** The value an inline row moves to: the next one, wrapping. Two values is a
 * flip; three or four cycle. A current value that is not among the choices
 * (stale state, a level the vendor dropped) moves to the first. */
export function nextInlineChoice<C extends { value: string }>(choices: readonly C[], current: string, step = 1): C {
  const at = choices.findIndex((choice) => choice.value === current);
  const from = at < 0 ? (step > 0 ? -1 : 0) : at;
  return choices[(from + step + choices.length) % choices.length]!;
}

export function runOptionPicker<T>(
  host: OptionPickerHost,
  title: string,
  options: readonly PickerOption<T>[],
  onAction?: (value: T, action: string) => Promise<void>,
  settings?: PickerSettings<T>,
): Promise<T | undefined> {
  if (!options.length) return Promise.resolve(undefined);
  return new Promise((resolveSelection, rejectSelection) => {
    host.setSelecting(true);
    let query = '';
    const same = (left: T, right: T): boolean => Object.is(left, right)
      || (typeof left === 'object' && typeof right === 'object' && JSON.stringify(left) === JSON.stringify(right));
    // Without a row named, the one marked "· current" -- every picker that
    // sets something marks the value in force -- so Enter on opening keeps
    // it rather than changing it to whatever happens to be listed first.
    const marked = options.findIndex((option) => /(?:^|·)\s*current\s*(?:·|$)/.test(option.detail ?? ''));
    let selected = settings?.startAt === undefined ? Math.max(0, marked)
      : Math.max(0, options.findIndex((option) => same(option.value, settings.startAt as T)));
    let stopInput: () => void = () => {};
    // Section headings take a row each, so a short list counts them too.
    const headings = options.filter((option, index) => option.group && option.group !== options[index - 1]?.group).length;
    const capacity = Math.min(options.length + headings, settings?.rows ?? 8) + 2;
    const currentOptions = (): readonly PickerOption<T>[] => settings?.refreshedOptions?.() ?? options;
    const visibleOptions = (): readonly PickerOption<T>[] => {
      const current = currentOptions();
      if (!query) return current;
      const needle = query.toLowerCase();
      return current.filter((option) =>
        option.label.toLowerCase().includes(needle)
        || (option.detail ?? '').toLowerCase().includes(needle));
    };
    /** The value each inline row is on now -- flipped here, not by rebuilding
     * the list, so the cursor stays on the row being changed. */
    const inlineNow = new Map<PickerOption<T>, string>();
    const inlineValue = (option: PickerOption<T>): string => inlineNow.get(option) ?? option.inline!.current;
    const inlineDetail = (option: PickerOption<T>): string => option.inline!.choices.map((choice) => (
      choice.value === inlineValue(option) ? chalk.bold.cyan(`● ${choice.label}`) : chalk.dim(`○ ${choice.label}`)
    )).join('  ');
    const draw = (): void => {
      const visible = visibleOptions();
      if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
      const renderOptions = visible.map((option) => ({
        label: option.label, detail: option.inline ? inlineDetail(option) : option.detail, value: '', group: option.group,
      }));
      const confirmation = keyHintFor('enter', 'choose');
      const selectedOption = visible[selected];
      if (selectedOption?.inline) {
        host.paint(title, renderOptions, selected, '', 0, {
          capacity, hideCursor: true,
          hint: `${keyHintFor(`\u2190\u2192 or 1-${selectedOption.inline.choices.length}`, 'choose')} · ${keyHintFor('\u2191\u2193', 'move')} · ${keyHintFor('esc', 'done')}`,
        });
        return;
      }
      const secondary = selectedOption?.alternates?.length ? ` · ${keyHintFor('tab', 'history')}`
        : selectedOption?.actions?.length ? ` · ${keyHintFor('tab', 'options')}` : '';
      const destructive = selectedOption?.deleteAction ? ` · ${keyHintFor('del', selectedOption.deleteAction.label.toLowerCase())}` : '';
      const inner = selectedOption?.inner?.options.length ? ` · ${keyHintFor('\u2192', selectedOption.inner.title.toLowerCase())}` : '';
      const keys = `${keyHintFor('\u2191\u2193', 'move')} · ${confirmation}${inner}${secondary}${destructive} · ${keyHintFor('\u2190', 'back')} · ${keyHintFor('esc', 'exit')}`;
      const hint = query
        ? `"${query}" - ${visible.length} match${visible.length === 1 ? '' : 'es'} · ${keys}`
        : `${settings?.totalItems ?? currentOptions().length} total · ${keys} · type to filter`;
      host.paint(title, renderOptions, selected, '', 0, { capacity, hideCursor: true, headings: true, hint });
    };
    let finished = false;
    /** The keyboard, taken on opening and again whenever a screen this one
     * opened hands it back. */
    const listen = (): void => {
      stopInput = takeTerminalKeys((key) => { if (!finished) handleKey(key); });
      draw();
    };
    const finish = (value: T | undefined, exit: typeof lastPickerExit = 'choose'): void => {
      if (finished) return;
      finished = true;
      host.setSelecting(false);
      stopInput();
      host.clearFrame();
      lastPickerExit = exit;
      // Values chosen on inline rows land before whoever opened the picker
      // reads the settings back.
      void commitAll().then(() => failure === undefined ? resolveSelection(value) : rejectSelection(failure));
    };
    /** A row action that failed (a sign-out the vendor refused) closes the
     * list and reaches whoever opened it, which says what went wrong --
     * dropped, the list just reappeared as if the key did nothing. */
    let failure: unknown;
    const runAction = async (value: T, action: string): Promise<void> => {
      try {
        await onAction?.(value, action);
      } catch (error) {
        failure = error;
      }
      finish(undefined);
    };
    const openAside = asideOpener({ stopInput: () => stopInput(), listen, finished: () => finished });
    /** A list inside a row (its history, its sub-agents): a value chosen
     * there is this picker's answer. */
    const openList = (listTitle: string, list: readonly PickerOption<T>[]): Promise<void> => openAside(async () => {
      const value = await host.select(listTitle, list);
      if (value === undefined) return false;
      finish(value);
      return true;
    });
    // Tab opens optional non-destructive management actions. Right Arrow is
    // deliberately identical to Enter for every picker.
    const openActions = (option: PickerOption<T>): Promise<void> => openAside(async () => {
      let escaped = false;
      const actionValue = await host.select(
        option.label,
        (option.actions ?? []).map((action) => ({ label: action.label, value: action.value })),
        undefined,
        { onEscape: () => { escaped = true; } },
      );
      if (escaped) {
        settings?.onEscape?.();
        finish(undefined, 'escape');
        return true;
      }
      if (!actionValue) return false;
      // Let the caller rebuild the parent options from authoritative
      // state (for example, Disconnect changes an account's status).
      // Repainting the captured array here would show stale details.
      await runAction(option.value, actionValue);
      return true;
    });
    const confirmDelete = (option: PickerOption<T>, action: { label: string; value: string }): Promise<void> => openAside(async () => {
      if (!await confirmRowDelete(host, option, action)) return false;
      await runAction(option.value, action.value);
      return true;
    });
    /** An inline row's choice is shown at once and applied when the cursor
     * leaves the row or the picker closes -- not on every step, which turned
     * Bypass on for a moment on the way from Ask to Auto. */
    const applied = new Map<PickerOption<T>, string>();
    const choose = (option: PickerOption<T>, value: string): void => {
      if (!applied.has(option)) applied.set(option, option.inline!.current);
      inlineNow.set(option, value);
      draw();
    };
    const step = (option: PickerOption<T>, by: number): void => choose(option, nextInlineChoice(option.inline!.choices, inlineValue(option), by).value);
    let committing = Promise.resolve();
    const commit = (option: PickerOption<T> | undefined): Promise<void> => {
      if (!option?.inline) return committing;
      committing = committing.then(async () => {
        const was = applied.get(option);
        const value = inlineValue(option);
        if (was === undefined || was === value) return;
        applied.set(option, value);
        try {
          await option.inline!.apply(value);
        } catch {
          // Not applied -- show what is actually in effect, not what was hoped.
          inlineNow.set(option, was);
          applied.set(option, was);
          if (!finished) draw();
        }
      });
      return committing;
    };
    const commitAll = async (): Promise<void> => { for (const option of applied.keys()) await commit(option); };
    const handleKey = (key: string): void => {
      if (key === '\u000c') { host.repair?.(); draw(); return; }
      const visible = visibleOptions();
      const current = visible[selected];
      if (current?.inline) {
        // On a row of a few values, ←/→ and the digits choose among them.
        if (key === '\u001b[D') { step(current, -1); return; }
        if (key === '\u001b[C') { step(current, 1); return; }
        const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
        if (digit >= 0 && digit < current.inline.choices.length) { choose(current, current.inline.choices[digit]!.value); return; }
        if (pickerConfirmsSelection(key)) {
          if (!applied.has(current) || inlineValue(current) === applied.get(current)) step(current, 1);
          void commit(current);
          return;
        }
      }
      if (key === '\u001b[A' || key === '\u001b[B') void commit(current);
      if (key === '\u001b[A') selected = visible.length ? (selected - 1 + visible.length) % visible.length : 0;
      else if (key === '\u001b[B') selected = visible.length ? (selected + 1) % visible.length : 0;
      else if (key === '\u001b[D') { settings?.onBack?.(); finish(undefined, 'back'); return; }
      // Right goes into a row's inner list where it has one (the board's rule).
      else if (key === '\u001b[C' && current?.inner?.options.length) { void openList(current.inner.title, current.inner.options); return; }
      else if (pickerConfirmsSelection(key)) {
        if (current) finish(current.value);
        return;
      }
      else if (key === '\t') {
        const option = visible[selected];
        if (option?.alternates?.length) void openList(option.label, option.alternates);
        else if (option?.actions?.length) void openActions(option);
        return;
      }
      else if (pickerDeletesSelection(key, query)) { const action = visible[selected]?.deleteAction; if (action) void confirmDelete(visible[selected]!, action); return; }
      else if (key === '\u0003') return finish(undefined, 'escape');
      else if (key === '\u001b') { settings?.onEscape?.(); return finish(undefined, 'escape'); }
      else if (key === '\u007f' || key === '\b') { if (!query) return; query = query.slice(0, -1); selected = 0; }
      else if (key.length === 1 && key >= ' ') { query += key; selected = 0; }
      else return;
      draw();
    };
    listen();
    redrawOnRefresh(settings?.refresh, () => { if (!finished) draw(); });
  });
}
