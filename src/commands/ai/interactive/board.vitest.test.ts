import { beforeEach, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../../../session/model.js';
import type { HarnessPrompter } from '../../../harness/prompter.js';
import { readState } from '../../../session/state/read.js';
import { writeState } from '../../../session/state/write.js';

const picker = vi.hoisted(() => vi.fn());
vi.mock('../../../tui/pickers/session.js', () => ({ interactiveSessionPicker: picker }));
const { openConversationPicker } = await import('./slash-host.js');

beforeEach(async () => {
  picker.mockReset();
  const state = await readState();
  state.sessions.push({ id: 'original', conversationId: 'original', route: 'local', provider: 'anthropic', nativeHarness: 'claude',
    model: 'sonnet', effort: 'medium', accountId: null, workspace: process.cwd(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'active',
    messages: [{ role: 'user', content: 'existing conversation' }],
  } as HarnessSession);
  await writeState(state);
});

it('offers the normal full command list and dispatches setup against an unsent chat', async () => {
  picker.mockResolvedValueOnce({ command: '/account' }).mockResolvedValueOnce({ command: '/permissions' }).mockResolvedValueOnce({ compose: 'first message' });
  const dispatch = vi.fn(async () => ({}));
  const outcome = await openConversationPicker({ rl: {} as HarnessPrompter, terminal: undefined, beginBuildReplace: () => undefined, dispatch }, 'original');
  const commands = picker.mock.calls[0]![2].map((item: { value: string }) => item.value);
  expect(commands).toEqual(expect.arrayContaining(['/provider', '/model', '/account', '/effort', '/permissions', '/settings', '/new']));
  expect(commands).not.toContain('/resume');
  expect(outcome.id).not.toBe('original');
  expect(outcome.prompt).toBe('first message');
  expect(dispatch.mock.calls).toEqual([[outcome.id, '/account'], [outcome.id, '/permissions']]);
  expect(picker.mock.calls[1]![1]).toBe(outcome.id);
  const original = (await readState({ transcripts: ['original'] })).sessions.find((session) => session.id === 'original');
  expect(original?.messages?.[0]?.content).toBe('existing conversation');
});

it('preserves navigation and turn outcomes from the shared dispatcher', async () => {
  picker.mockResolvedValueOnce({ command: '/new' });
  const dispatch = vi.fn(async () => ({ id: 'selected', draft: 'editable prompt' }));
  expect(await openConversationPicker({ rl: {} as HarnessPrompter, terminal: undefined, beginBuildReplace: () => undefined, dispatch }, 'original'))
    .toEqual({ id: 'selected', draft: 'editable prompt' });
  expect(picker).toHaveBeenCalledTimes(1);
});

it('discards an unused setup chat when history is closed', async () => {
  picker.mockResolvedValueOnce({ command: '/settings' }).mockResolvedValueOnce(undefined);
  const dispatch = vi.fn(async (_id: string, _line: string) => ({}));
  expect(await openConversationPicker({ rl: {} as HarnessPrompter, terminal: undefined, beginBuildReplace: () => undefined, dispatch }, 'original')).toEqual({ id: 'original' });
  const fresh = dispatch.mock.calls[0]![0];
  expect((await readState()).sessions.some((session) => session.id === fresh)).toBe(false);
});
