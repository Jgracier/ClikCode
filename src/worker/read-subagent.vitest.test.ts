import { beforeEach, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../session/model.js';
import { persistentTransports } from '../turn/vendor-process.js';
import { readConversationSubagent } from './read-subagent.js';

beforeEach(() => persistentTransports.clear());

const session = (): HarnessSession => ({ id: 'parent', route: 'local', nativeHarness: 'codex', messages: [{ role: 'assistant', content: '', activities: [
  { responseOffset: 0, event: { kind: 'tool-start', id: 'spawn', label: 'Agent review', agent: true } },
  { responseOffset: 0, event: { kind: 'tool-start', id: 'spawn', label: 'Agent review', agent: true, agentId: 'child-thread' } },
  { responseOffset: 0, event: { kind: 'tool-done', id: 'spawn', label: 'Agent review', agent: true } },
] }] } as HarnessSession);

it('uses the child identity supplied after launch and only reads agents owned by this conversation', async () => {
  const readSubagentThread = vi.fn(async () => [{ kind: 'text', text: 'child answer' }]);
  persistentTransports.set('parent', { transport: 'codex-app-server', session: { readSubagentThread } } as never);
  expect(await readConversationSubagent(session(), undefined, 'unrelated')).toEqual([]);
  expect(readSubagentThread).not.toHaveBeenCalled();
  expect(await readConversationSubagent(session(), undefined, 'spawn')).toEqual([{ kind: 'text', text: 'child answer' }]);
  expect(readSubagentThread).toHaveBeenCalledWith('child-thread');
});

it('uses the current agent route rather than stale vendor metadata', async () => {
  const readSubagentThread = vi.fn(async () => []);
  persistentTransports.set('parent', { transport: 'codex-app-server', session: { readSubagentThread } } as never);
  await readConversationSubagent({ ...session(), route: 'gateway' }, undefined, 'spawn');
  expect(readSubagentThread).not.toHaveBeenCalled();
});
