import { afterEach, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { aiPermissions } from './permissions.js';

afterEach(() => { vi.restoreAllMocks(); });

const ID = '9e2a1c00-0000-4000-8000-0000000000a1';

it('`clikcode permissions <mode>` changes only the global default, not the chat that changed last; --chat changes that chat', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  const state = await readState();
  const now = new Date().toISOString();
  state.sessions.push({
    id: ID, route: 'local', accountId: null, provider: 'anthropic', model: 'sonnet', permissionMode: 'ask',
    createdAt: now, updatedAt: now, status: 'active', nativeHarness: 'claude', name: 'Elsewhere', messages: [],
  } as unknown as HarnessSession);
  await writeState(state);

  await aiPermissions('bypass');
  let after = await readState({ transcripts: [ID] });
  expect(after.globalSettings.permissionMode).toBe('bypass');
  expect(after.sessions.find((session) => session.id === ID)!.permissionMode).toBe('ask');

  await aiPermissions('auto', { chat: ID });
  after = await readState({ transcripts: [ID] });
  expect(after.sessions.find((session) => session.id === ID)!.permissionMode).toBe('auto');
  expect(after.globalSettings.permissionMode).toBe('bypass');
});
