import { describe, expect, it } from 'vitest';
import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import type { ToolContext } from '../tool-contract.js';
import { staticInstructions } from '../context.js';
import { defaultTools } from './registry.js';

function chat(id: string, name: string, content: string): HarnessSession {
  const at = new Date().toISOString();
  return {
    id, route: 'local', accountId: null, provider: 'google', model: 'gemini-3', effort: 'medium', permissionMode: 'ask',
createdAt: at, updatedAt: at, status: 'active', nativeHarness: 'gemini', name,
    messages: [{ role: 'user', content }, { role: 'assistant', content: 'ok' }],
  } as HarnessSession;
}

describe("ClikCode's agent sees other conversations", () => {
  it('has the conversation tools, read-only, and leaves this chat out of search', async () => {
    const state = await readState();
    state.sessions.push(chat('other-chat-0001', 'Billing webhook', 'the stripe webhook signature fails'), chat('this-chat-0002', 'Here', 'stripe webhook here too'));
    await writeState(state);
    const tools = defaultTools().filter((tool) => ['search_conversations', 'read_conversation', 'active_conversations'].includes(tool.name));
    expect(tools.map((tool) => [tool.name, tool.class])).toEqual([
      ['search_conversations', 'read'], ['read_conversation', 'read'], ['active_conversations', 'read'],
    ]);
    const search = tools[0]!;
    expect(search.label({ query: 'stripe webhook' })).toBe('Search conversation "stripe webhook"');
    const result = await search.run({ query: 'stripe webhook' }, { sessionId: 'this-chat-0002' } as ToolContext);
    expect(result.output).toContain('Billing webhook');
    expect(result.output).not.toContain('Here —');
  });

  it('is told when to search other chats', () => {
    for (const guidance of [true, false]) {
      expect(staticInstructions(guidance)).toContain('search_conversations');
    }
  });
});
