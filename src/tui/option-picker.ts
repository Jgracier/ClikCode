/** The generic option picker: a titled list, type-to-filter, and per-option
 * actions.
 *
 * Its own module because it was the least entangled 139 lines in prompter.ts
 * -- measured, not guessed: four references to the prompter's own state
 * against twenty-four in the transcript emitter beside it. Everything it
 * needs from the frame is passed in as `host`, so the picker can be reasoned
 * about without the painter and the painter without the picker.
 *
 * Moved verbatim. The behaviour here has not been changed, only relocated,
 * which is the only safe way to move code that draws to a terminal and
 * cannot be verified by a test.
 */

import { stdin as input } from 'node:process';
import chalk from 'chalk';
import type { PickerOption } from '../harness/prompter.js';
import { listenForTerminalKeys } from './input-decoder.js';
import { setTerminalRawMode } from './modes.js';
import { pickerConfirmsSelection, pickerDeletesSelection } from './command-palette.js';

/** What the picker needs from the frame that owns the screen. */
export interface OptionPickerHost {
  paint(
    composer: string, options: readonly PickerOption<string>[], selected: number,
    prompt: string, cursor: number,
    palette?: { capacity?: number; hint?: string; hideCursor?: boolean },
  ): void;
  clearFrame(): void;
  setSelecting(selecting: boolean): void;
  /** For the sub-pickers an option's actions can open. */
  select<T>(
    title: string, options: readonly PickerOption<T>[],
    onAction?: (value: T, action: string) => Promise<void>,
    settings?: OptionPickerSettings,
  ): Promise<T | undefined>;
}

export interface OptionPickerSettings {
  onBack?: () => void;
  onEscape?: () => void;
  refreshedOptions?: () => readonly PickerOption<never>[];
  refresh?: Promise<unknown>;
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
  settings?: {
    onBack?: () => void;
    onEscape?: () => void;
    refreshedOptions?: () => readonly PickerOption<T>[];
    refresh?: Promise<unknown>;
  },
): Promise<T | undefined> {
  if (!options.length) return Promise.resolve(undefined);
  return new Promise((resolveSelection) => {
    host.setSelecting(true);
    let query = '';
    let selected = 0;
    let stopInput: () => void = () => {};
    const capacity = Math.min(options.length, 8) + 2;
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
        label: option.label, detail: option.inline ? inlineDetail(option) : option.detail, value: '',
      }));
      const confirmation = '\u2192/Enter';
      const selectedOption = visible[selected];
      if (selectedOption?.inline) {
        host.paint(title, renderOptions, selected, '', 0, {
          capacity, hideCursor: true,
          hint: `\u2190\u2192 or 1-${selectedOption.inline.choices.length} choose · \u2191\u2193 move · Esc done`,
        });
        return;
      }
      const secondary = selectedOption?.alternates?.length ? ' · Tab history'
        : selectedOption?.actions?.length ? ' · Tab options' : '';
      const destructive = selectedOption?.deleteAction ? ` · Del ${selectedOption.deleteAction.label.toLowerCase()}` : '';
      const hint = query
        ? `"${query}" - ${visible.length} match${visible.length === 1 ? '' : 'es'} · \u2191\u2193 move · ${confirmation} choose${secondary}${destructive} · \u2190 back · Esc exit`
        : `${currentOptions().length} total · \u2191\u2193 move · ${confirmation} choose${secondary}${destructive} · \u2190 back · Esc exit · type to filter`;
      host.paint(title, renderOptions, selected, '', 0, { capacity, hideCursor: true, hint });
    };
    let finished = false;
    const finish = (value: T | undefined, exit: typeof lastPickerExit = 'choose'): void => {
      if (finished) return;
      finished = true;
      host.setSelecting(false);
      stopInput();
      host.clearFrame();
      lastPickerExit = exit;
      // Values chosen on inline rows land before whoever opened the picker
      // reads the settings back.
      void commitAll().then(() => resolveSelection(value));
    };
    // Tab opens optional non-destructive management actions. Right Arrow is
    // deliberately identical to Enter for every picker.
    const openActions = async (option: PickerOption<T>): Promise<void> => {
      if (!option.actions?.length) return;
      stopInput();
      let escaped = false;
      const actionValue = await host.select(
        option.label,
        option.actions.map((action) => ({ label: action.label, value: action.value })),
        undefined,
        { onEscape: () => { escaped = true; } },
      );
      if (escaped) {
        settings?.onEscape?.();
        finish(undefined, 'escape');
        return;
      }
      if (actionValue) {
        await onAction?.(option.value, actionValue);
        // Let the caller rebuild the parent options from authoritative
        // state (for example, Disconnect changes an account's status).
        // Repainting the captured array here would show stale details.
        finish(undefined);
        return;
      }
      if (finished) return;
      setTerminalRawMode(true);
      input.resume();
      stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
      draw();
    };
    const openAlternates = async (option: PickerOption<T>): Promise<void> => {
      if (!option.alternates?.length) return;
      stopInput();
      const value = await host.select(option.label, option.alternates);
      if (value !== undefined) return finish(value);
      if (finished) return;
      setTerminalRawMode(true);
      input.resume();
      stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
      draw();
    };
    const confirmDelete = async (option: PickerOption<T>): Promise<void> => {
      const action = option.deleteAction;
      if (!action) return;
      stopInput();
      const confirmed = await host.select(`${action.label} ${option.label}?`, [
        { label: 'Cancel', value: false },
        { label: `${action.label} ${option.label}`, value: true },
      ]);
      if (confirmed) {
        await onAction?.(option.value, action.value);
        finish(undefined);
        return;
      }
      if (finished) return;
      setTerminalRawMode(true);
      input.resume();
      stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
      draw();
    };
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
      else if (pickerConfirmsSelection(key)) {
        if (current) finish(current.value);
        return;
      }
      else if (key === '\t') {
        const option = visible[selected];
        if (option?.alternates?.length) void openAlternates(option);
        else if (option?.actions?.length) void openActions(option);
        return;
      }
      else if (pickerDeletesSelection(key)) { if (visible[selected]?.deleteAction) void confirmDelete(visible[selected]); return; }
      else if (key === '\u0003') return finish(undefined, 'escape');
      else if (key === '\u001b') { settings?.onEscape?.(); return finish(undefined, 'escape'); }
      else if (key === '\u007f' || key === '\b') { if (!query) return; query = query.slice(0, -1); selected = 0; }
      else if (key.length === 1 && key >= ' ') { query += key; selected = 0; }
      else return;
      draw();
    };
    setTerminalRawMode(true);
    input.resume();
    stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
    draw();
    void settings?.refresh?.then(() => { if (!finished) draw(); }, () => { if (!finished) draw(); });
  });
}
