import { describe, expect, it } from 'vitest';
import { codexActivityForItem, codexErrorKind, codexPermissionSettings, codexSteerParams, completedAgentMessageUpdate } from './codex-app-server';

describe('Codex app-server protocol mapping', () => {
  it('distinguishes a spent subscription from a transient HTTP 429', () => {
    expect(codexErrorKind({ message: 'Rate limited: subscription:free-usage-exhausted', http_status_code: 429 }).errorKind).toBe('quota');
    expect(codexErrorKind({ message: 'HTTP 429 Too Many Requests', http_status_code: 429 }).errorKind).toBe('other');
  });
  it('preserves native ids so tool completion updates the start row', () => {
    const item = { type: 'commandExecution', id: 'tool-1', command: 'git status' };
    expect(codexActivityForItem(item, false)).toEqual({ kind: 'tool-start', label: '$ git status', category: 'run', id: 'tool-1' });
    expect(codexActivityForItem(item, true)).toEqual({ kind: 'tool-done', label: '$ git status', category: 'run', id: 'tool-1' });
    expect(codexActivityForItem({ ...item, exitCode: 1, durationMs: 1200 }, true))
      .toEqual({ kind: 'tool-error', label: '$ git status', category: 'run', id: 'tool-1', exitCode: 1, durationMs: 1200 });
  });

  it('marks a collab call as a sub-agent the chat can show while it runs', () => {
    expect(codexActivityForItem({
      type: 'collabAgentToolCall', id: 'agent-1', tool: 'spawn_agent', prompt: 'review the tests',
    }, false)).toEqual({ kind: 'tool-start', label: 'Agent review the tests', agent: true, id: 'agent-1' });
  });

  it('shows a file change as its paths and its diff, not "files updated"', () => {
    expect(codexActivityForItem({
      type: 'fileChange', id: 'fc', status: 'completed',
      changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n' }],
    }, true)).toMatchObject({ kind: 'tool-done', label: 'Edit src/a.ts', category: 'edit', id: 'fc',
      // Its own file, numbered from the hunk header, with Codex's kind.
      diff: [{ path: 'src/a.ts', change: 'update', additions: 1, removals: 1, lines: [
        { kind: 'removed', text: 'const a = 1;', line: 1 }, { kind: 'added', text: 'const a = 2;', line: 1 },
      ] }],
    });
  });

  it('names an MCP call by server and tool with a short argument summary', () => {
    expect(codexActivityForItem({ type: 'mcpToolCall', id: 'm', server: 'github', tool: 'create_issue', arguments: { title: 'Fix it', labels: ['bug'] } }, false))
      .toMatchObject({ kind: 'tool-start', label: 'github › create_issue title=Fix it labels=["bug"]' });
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
