import { EventEmitter } from 'node:events';
import type { Dialog, Page } from 'playwright-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { answerDialog, bindDialogs, HELD_DIALOG_MS, hasPendingDialog, pendingDialogNote, settleWaitingDialog, takeDialogNotices, watchDialogs, withDialogNotices, withDialogs } from './page-dialogs.js';

function fakePage(): { page: Page; raise: (type: string, message: string, defaultValue?: string) => { accepted: string[]; dismissed: number[] } } {
  const events = new EventEmitter();
  const page = Object.assign(events, { waitForTimeout: async () => undefined }) as unknown as Page;
  return {
    page,
    raise: (type, message, defaultValue = '') => {
      const log = { accepted: [] as string[], dismissed: [] as number[] };
      const dialog = { type: () => type, message: () => message, defaultValue: () => defaultValue, accept: async (text?: string) => { log.accepted.push(text ?? ''); }, dismiss: async () => { log.dismissed.push(1); } } as unknown as Dialog;
      events.emit('dialog', dialog);
      return log;
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('dismisses and reports a box on a tab the agent is not working in', () => {
  const { page, raise } = fakePage();
  watchDialogs(page);
  const log = raise('confirm', 'Sure?');
  expect(log.dismissed).toHaveLength(1);
  expect(hasPendingDialog(page)).toBe(false);
  expect(withDialogNotices({ output: 'x' }, page).output).toContain('confirm: "Sure?" (declined)');
});

it('holds a box on a bound tab until the agent answers, then accepts a prompt with its text', async () => {
  const { page, raise } = fakePage();
  bindDialogs(page, true);
  const log = raise('prompt', 'Name?', 'anon');
  expect(log.dismissed).toHaveLength(0);
  expect(pendingDialogNote(page)).toMatch(/prompt box: "Name\?" \(default answer "anon"\).*dialog action/);
  expect(await answerDialog(page, true, 'Ada')).toContain('accepted with 3 characters');
  expect(log.accepted).toEqual(['Ada']);
  expect(hasPendingDialog(page)).toBe(false);
  expect(await answerDialog(page, true)).toContain('No dialog is waiting');
});

it('dismisses a held box that nobody answers', () => {
  const { page, raise } = fakePage();
  bindDialogs(page, true);
  const log = raise('confirm', 'Delete?');
  vi.advanceTimersByTime(HELD_DIALOG_MS + 1);
  expect(log.dismissed).toHaveLength(1);
  expect(hasPendingDialog(page)).toBe(false);
  expect(takeDialogNotices(page).join()).toContain('declined after two minutes');
});

it('closes an alert at once even on a bound tab, and mentions it', () => {
  const { page, raise } = fakePage();
  bindDialogs(page, true);
  const log = raise('alert', 'Saved');
  expect(log.dismissed).toHaveLength(1);
  expect(hasPendingDialog(page)).toBe(false);
  expect(takeDialogNotices(page)).toEqual(['alert: "Saved" (closed)']);
});

it('answers by the click rule during withDialogs, even on a bound tab', async () => {
  const { page, raise } = fakePage();
  bindDialogs(page, true);
  let log!: ReturnType<typeof raise>;
  const { dialogs } = await withDialogs(page, true, async () => { log = raise('confirm', 'Delete?'); }, 0);
  expect(log.accepted).toHaveLength(1);
  expect(dialogs).toEqual(['confirm: "Delete?" (accepted)']);
});

it('accepts a "leave this page" box only for the agent that is leaving, and dismisses any other', async () => {
  const leaving = fakePage();
  bindDialogs(leaving.page, true);
  const first = leaving.raise('beforeunload', '');
  expect(await settleWaitingDialog(leaving.page, true)).toContain('accepted');
  expect(first.accepted).toHaveLength(1);
  const staying = fakePage();
  bindDialogs(staying.page, true);
  const second = staying.raise('confirm', 'Delete?');
  expect(await settleWaitingDialog(staying.page, true)).toContain('dismissed');
  expect(second.dismissed).toHaveLength(1);
});
