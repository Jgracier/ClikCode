import { describe, expect, it } from 'vitest';
import { codexActivityForItem, codexPermissionSettings } from './codex-app-server';

describe('Codex app-server protocol mapping', () => {
  it('preserves native ids so tool completion updates the start row', () => {
    const item = { type: 'commandExecution', id: 'tool-1', command: 'git status' };
    expect(codexActivityForItem(item, false)).toEqual({ kind: 'tool-start', label: 'git status', id: 'tool-1' });
    expect(codexActivityForItem(item, true)).toEqual({ kind: 'tool-done', label: 'git status', id: 'tool-1' });
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
});
