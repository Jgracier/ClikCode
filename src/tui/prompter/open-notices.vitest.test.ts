import { expect, it, vi } from 'vitest';
import { clearNotice, postNotice } from '../../agent/computer/notices.js';
import { stateDirectory } from '../../session/store/paths.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { announceOpenNotices } from './notices.js';

const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 50); });

it('a turn starts with one line naming the open notices, and none when there are none', async () => {
  const p = { transientNotice: undefined, showTransientNotice: vi.fn(), paintCurrent: vi.fn() };
  announceOpenNotices(p as unknown as TerminalHarnessPrompter);
  await settle();
  expect(p.showTransientNotice).not.toHaveBeenCalled();
  await postNotice(stateDirectory(), { key: 'tui-test', title: 'Writes held', message: 'Renew the unlock.' }, { desktop: async () => false });
  try {
    announceOpenNotices(p as unknown as TerminalHarnessPrompter);
    await settle();
    expect(p.showTransientNotice).toHaveBeenCalledWith(expect.stringMatching(/^Notice: Writes held: Renew the unlock\./), expect.any(Number));
  } finally { await clearNotice(stateDirectory(), 'tui-test'); }
});
