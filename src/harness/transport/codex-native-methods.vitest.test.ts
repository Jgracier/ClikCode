import { describe, expect, it } from 'vitest';
import { codexTurnPermissionParams, codexTurnStartParams, compactCodexThread, listCodexModels, type CodexRpcPeer } from './codex-native-methods.js';

function scripted(pages: Record<string, Record<string, any>[]>): { peer: CodexRpcPeer; calls: Array<{ method: string; params: Record<string, any> }> } {
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  return {
    calls,
    peer: { request: async (method, params) => { calls.push({ method, params }); return (pages[method] ?? [{}]).shift() ?? {}; } },
  };
}

describe('Codex native app-server methods', () => {
  it('spells the permission mode as per-turn turn/start fields', () => {
    expect(codexTurnPermissionParams('bypass')).toEqual({ approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } });
    expect(codexTurnPermissionParams('auto')).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' } });
    const params = codexTurnStartParams({ threadId: 't1', prompt: 'hi', cwd: '/w', model: 'gpt-x', effort: 'high', permissionMode: 'ask', summary: 'auto' });
    expect(params).toMatchObject({ threadId: 't1', effort: 'high', model: 'gpt-x', summary: 'auto', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } });
  });

  it('compacts the thread natively', async () => {
    const { peer, calls } = scripted({});
    await compactCodexThread(peer, 't1');
    expect(calls).toEqual([{ method: 'thread/compact/start', params: { threadId: 't1' } }]);
  });

  it('lists models and their efforts across pages', async () => {
    const { peer, calls } = scripted({ 'model/list': [
      { data: [{ id: 'a', model: 'gpt-a', displayName: 'A', isDefault: true, hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: 'c2' },
      { data: [{ id: 'b', model: 'gpt-b', displayName: 'B', supportedReasoningEfforts: [] }], nextCursor: null },
    ] });
    const models = await listCodexModels(peer);
    expect(models.map((model) => [model.model, model.efforts, model.isDefault])).toEqual([['gpt-a', ['low', 'high'], true], ['gpt-b', [], false]]);
    expect(calls[1]!.params.cursor).toBe('c2');
  });
});
