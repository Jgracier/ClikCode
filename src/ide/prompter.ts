/** The terminal pickers, answered by the editor's quick picks.
 *
 * Every picker in tui/pickers takes a HarnessPrompter and ends in the same
 * command a typed slash line runs; this prompter makes the editor one more
 * surface for them, so choosing a model in VS Code is the terminal's model
 * picker -- its rows, its checks, its follow-up questions -- and not a second
 * copy of that logic that could drift from it.
 */
import { randomUUID } from 'node:crypto';
import type { HarnessPrompter, PickerOption } from '../harness/prompter.js';
import type { HarnessSession } from '../session/model.js';
import type { IdeEvent, IdePickItem, IdeUiRequest, IdeUiResult } from './protocol.js';
import { sessionEvent } from './session-event.js';

export interface IdeChannel {
  send(event: IdeEvent): void;
}

export function pickItems<T>(options: readonly PickerOption<T>[]): IdePickItem[] {
  return options.map((option) => ({
    label: option.label,
    ...(option.detail ? { detail: option.detail } : {}),
    ...(option.group ? { group: option.group } : {}),
    ...(option.argHint ? { argHint: option.argHint } : {}),
    ...(option.actions?.length ? { actions: option.actions.map(({ label, value }) => ({ label, value })) } : {}),
    ...(option.deleteAction ? { deleteAction: { label: option.deleteAction.label, value: option.deleteAction.value } } : {}),
    ...(option.inline ? { inline: { choices: option.inline.choices.map(({ label, value }) => ({ label, value })), current: option.inline.current } } : {}),
  }));
}

export class IdePrompter implements HarnessPrompter {
  private readonly pending = new Map<string, (result: IdeUiResult) => void>();

  constructor(private readonly channel: IdeChannel) {}

  /** An answer from the editor. Unknown ids are ignored: a request the
   * bridge already gave up on is simply late. */
  answer(id: string, result: IdeUiResult): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(result);
  }

  /** Everything still open is cancelled -- the editor went away. */
  cancelAll(): void {
    for (const [id, resolve] of [...this.pending]) {
      this.pending.delete(id);
      resolve({ cancelled: true });
    }
  }

  private ask(request: IdeUiRequest, id = randomUUID()): Promise<IdeUiResult> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.channel.send({ type: 'ui-request', id, request });
    });
  }

  async question(prompt: string): Promise<string> {
    const result = await this.ask({ kind: 'input', prompt: prompt.replace(/\s*›\s*$/, '') });
    return 'text' in result ? result.text : '';
  }

  async select<T>(
    title: string,
    options: readonly PickerOption<T>[],
    onAction?: (value: T, action: string) => Promise<void>,
    settings?: {
      onBack?: () => void;
      /** The row to start on: the current value, or the row a sub-menu was
       * opened from. Absent or not listed, the first. */
      startAt?: T;
      onEscape?: () => void;
      refreshedOptions?: () => readonly PickerOption<T>[];
      refresh?: Promise<unknown> | readonly Promise<unknown>[];
    },
  ): Promise<T | undefined> {
    let current = options;
    let refresh = settings?.refresh;
    for (;;) {
      if (!current.length) return undefined;
      const id = randomUUID();
      const shown = current;
      const answer = this.ask({ kind: 'pick', title, items: pickItems(shown), canGoBack: Boolean(settings?.onBack) }, id);
      // Rows whose figures are still arriving (account usage) are replaced in
      // the open list, as the terminal repaints them.
      if (refresh && settings?.refreshedOptions) {
        const pendingRefresh = refresh;
        refresh = undefined;
        // Rows can land in stages (known ones, then fresh ones): update at each.
        for (const stage of [pendingRefresh].flat()) {
          void stage.then(() => {
            if (!this.pending.has(id)) return;
            current = settings.refreshedOptions!();
            this.channel.send({ type: 'ui-update', id, items: pickItems(current) });
          }, () => undefined);
        }
      }
      const result = await answer;
      if ('cancelled' in result) {
        if (result.back && settings?.onBack) settings.onBack();
        else settings?.onEscape?.();
        return undefined;
      }
      if (!('index' in result)) return undefined;
      const option = current[result.index];
      if (!option) return undefined;
      if (result.action !== undefined) {
        await onAction?.(option.value, result.action);
        current = settings?.refreshedOptions?.() ?? current;
        continue;
      }
      if (option.inline) {
        const { choices, current: selected } = option.inline;
        const next = choices[(choices.findIndex((choice) => choice.value === selected) + 1) % choices.length];
        if (next) await option.inline.apply(next.value);
        current = settings?.refreshedOptions?.()
          ?? current.map((item) => (item === option && next ? { ...item, inline: { ...option.inline!, current: next.value } } : item));
        continue;
      }
      return option.value;
    }
  }

  render(session: HarnessSession, account?: string, notice?: string): void {
    this.channel.send(sessionEvent(session, account));
    if (notice) this.channel.send({ type: 'notice', message: notice, level: 'info' });
  }

  panel(title: string, body: string): void {
    this.channel.send({ type: 'panel', title, body });
  }

  close(): void {
    this.cancelAll();
  }
}
