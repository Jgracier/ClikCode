/** The picker host: how option pickers, the conversation board and slash palettes borrow the prompter's frame. */
import { lifecycle } from '../../runtime/lifecycle-log.js';
import type { PickerOption, PickerSettings } from '../../harness/prompter.js';
import { runOptionPicker, type OptionPickerHost } from '../option-picker.js';
import { runConversationBoard, type BoardResult, type ConversationBoardSettings } from '../conversation-board.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { EMPTY_COMPOSER } from './state.js';

/** Remove a completed palette/picker as one frame. Painting an empty
 * composer here left its borders/status rows alive while the selected slash
 * command ran, which looked like a composer floating above blank space. */
export function clearInteractiveFrame(this: TerminalHarnessPrompter): void {
  this.renderFrame([], [], 0, 1, true);
}

/** Provider/model/effort pickers share the same frame and palette layout as
 * slash commands, so the conversation stays visible above them.
 *
 * Type-to-filter: letters, digits and space narrow the list live by
 * substring match against label and detail (title, provider, status), and
 * the arrows move through what is visible -- so a long list (/resume, with
 * every discovered vendor chat) stays findable, and no letter is a key
 * alias that would collide with a filter query. */
export function select<T>(
  this: TerminalHarnessPrompter,
  title: string,
  options: readonly PickerOption<T>[],
  onAction?: (value: T, action: string) => Promise<void>,
  settings?: PickerSettings<T>,
): Promise<T | undefined> {
  lifecycle('window.picker.open', { title: title.slice(0, 80), options: options.length });
  return runOptionPicker<T>(this.pickerHost(), title, options, onAction, settings)
    .finally(() => lifecycle('window.picker.close', { title: title.slice(0, 80) }));
}

export function board(this: TerminalHarnessPrompter, settings: ConversationBoardSettings): Promise<BoardResult | undefined> {
  lifecycle('window.board.open');
  return runConversationBoard(this.pickerHost(), settings).finally(() => lifecycle('window.board.close'));
}

export function pickerHost(this: TerminalHarnessPrompter): OptionPickerHost {
  return {
    paint: (composer, pickerOptions, selected, prompt, cursor, palette) =>
      this.paint(composer, pickerOptions, selected, prompt, cursor, palette),
    clearFrame: () => this.clearInteractiveFrame(),
    // The board's frame stays until the next paint replaces it (option-picker.ts keepFrame).
    keepFrame: () => undefined,
    repair: () => { this.requestRedraw('repair'); this.forgetScreenPosition(); },
    // A closed picker is not the frame to come back to: resume() and any
    // repaint after it used to draw the finished list again (with the
    // palette's hint under it) before the next frame replaced it.
    setSelecting: (selecting) => {
      this.selecting = selecting;
      if (!selecting) this.composer = EMPTY_COMPOSER;
    },
    select: (subTitle, subOptions, subAction, subSettings) => this.select(subTitle, subOptions, subAction, subSettings),
  };
}
