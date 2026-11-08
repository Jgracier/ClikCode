import { describe, expect, it } from 'vitest';
import type { HarnessSession } from '../session/model.js';
import { leaveProvider, restoreNativeThread } from '../session/native-thread.js';
import { returnPrompt } from './thread-return.js';

function chat(): HarnessSession {
  return {
    id: 'chat', route: 'local', provider: 'anthropic', nativeHarness: 'claude',
    accountId: 'claude-a', nativeThreadAccountId: 'claude-a', nativeSessionId: 'claude-thread',
    model: 'opus', effort: 'high', workspace: '/work', status: 'active',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    messages: [{ role: 'user', content: 'first request' }, { role: 'assistant', content: 'first answer' }],
  };
}

describe('returning to a vendor thread', () => {
  it('resumes its original id and carries only turns made on the other harness', () => {
    const session = chat();
    leaveProvider(session);
    expect(session.nativeSessionId).toBeUndefined();
    session.nativeHarness = 'codex';
    session.provider = 'openai';
    session.messages!.push({ role: 'user', content: 'second request' }, { role: 'assistant', content: 'second answer' });
    leaveProvider(session);
    session.nativeHarness = 'claude';
    session.provider = 'anthropic';
    const through = restoreNativeThread(session, 'claude');
    expect(through).toBe(2);
    expect(session.nativeSessionId).toBe('claude-thread');
    expect(session.nativeThreadAccountId).toBe('claude-a');
    expect(session.nativeThreads?.claude).toBeUndefined();
    const prompt = returnPrompt(session, session.messages!, through!, 'third request', 48 * 1024);
    expect(prompt).toContain('second request');
    expect(prompt).toContain('second answer');
    expect(prompt).not.toContain('first request');
    expect(prompt).not.toContain('first answer');
    expect(prompt).toContain('<current_request>\nthird request\n</current_request>');
  });

  it('delivers every turn missed on each return of a longer journey (Claude, Codex, Claude, Codex, Claude)', () => {
    const session = chat();
    const turn = (n: number) => session.messages!.push({ role: 'user', content: `request ${n}` }, { role: 'assistant', content: `answer ${n}` });
    const go = (harness: string, provider: string) => { session.nativeHarness = harness; session.provider = provider; };
    leaveProvider(session); go('codex', 'openai'); turn(2); turn(3);
    leaveProvider(session); go('claude', 'anthropic');
    // Back on Claude: its thread holds turn 1; it is sent 2 and 3 and nothing else.
    let through = restoreNativeThread(session, 'claude');
    expect(through).toBe(2);
    let prompt = returnPrompt(session, session.messages!, through!, 'request 4', 48 * 1024);
    expect(prompt).toContain('request 2');
    expect(prompt).toContain('answer 3');
    // The thread now holds 2 and 3 and 4; Claude answers 4 itself, then leaves again.
    session.nativeSessionId = 'claude-thread';
    turn(4);
    leaveProvider(session); go('codex', 'openai'); turn(5); turn(6);
    leaveProvider(session); go('claude', 'anthropic');
    through = restoreNativeThread(session, 'claude');
    expect(through).toBe(8);
    prompt = returnPrompt(session, session.messages!, through!, 'request 7', 48 * 1024);
    expect(prompt).toContain('request 5');
    expect(prompt).toContain('answer 6');
    expect(prompt).not.toContain('request 4');
    expect(prompt).not.toContain('request 2');
  });

  it('does not restore after an earlier message changes', () => {
    const session = chat();
    leaveProvider(session);
    session.messages![0]!.content = 'edited first request';
    expect(restoreNativeThread(session, 'claude')).toBeUndefined();
    expect(session.nativeSessionId).toBeUndefined();
  });

  it('does not restore across a workspace change', () => {
    const session = chat();
    leaveProvider(session);
    session.workspace = '/other';
    expect(restoreNativeThread(session, 'claude')).toBeUndefined();
  });
});
