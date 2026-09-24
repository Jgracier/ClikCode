import { describe, expect, it } from 'vitest';
import { codexActivityForItem, codexPermissionSettings, codexSteerParams, completedAgentMessageUpdate } from './codex-app-server';

describe('Codex app-server protocol mapping', () => {
  it('preserves native ids so tool completion updates the start row', () => {
    const item = { type: 'commandExecution', id: 'tool-1', command: 'git status' };
    expect(codexActivityForItem(item, false)).toEqual({ kind: 'tool-start', label: 'git status', category: 'run', id: 'tool-1' });
    expect(codexActivityForItem(item, true)).toEqual({ kind: 'tool-done', label: 'git status', category: 'run', id: 'tool-1' });
    expect(codexActivityForItem({ ...item, exitCode: 1 }, true))
      .toEqual({ kind: 'tool-error', label: 'git status', category: 'run', id: 'tool-1' });
  });

  it('marks a collab call as a sub-agent the chat can show while it runs', () => {
    expect(codexActivityForItem({
      type: 'collabAgentToolCall', id: 'agent-1', tool: 'spawn_agent', prompt: 'review the tests',
    }, false)).toEqual({ kind: 'tool-start', label: 'spawn_agent(review the tests)', agent: true, id: 'agent-1' });
  });

  it('maps Ask, Auto, and Bypass without weakening their approval policy', () => {
    expect(codexPermissionSettings('ask')).toEqual({
      approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user',
    });
    expect(codexPermissionSettings('auto')).toEqual({
      approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review',
    });
    expect(codexPermissionSettings('bypass')).toEqual({
      approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user',
    });
  });

  it('targets the active turn when steering without starting a second turn', () => {
    expect(codexSteerParams('thread-1', 'turn-1', 'Focus on the failing test.')).toEqual({
      threadId: 'thread-1', expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'Focus on the failing test.', text_elements: [] }],
    });
  });

  it('shows a completed message immediately when deltas were absent or incomplete', () => {
    expect(completedAgentMessageUpdate('', 'Complete response')).toEqual({ text: 'Complete response', mode: 'append' });
    expect(completedAgentMessageUpdate('Complete ', 'Complete response')).toEqual({ text: 'response', mode: 'append' });
    expect(completedAgentMessageUpdate('Complete response', 'Complete response')).toBeUndefined();
  });
});
