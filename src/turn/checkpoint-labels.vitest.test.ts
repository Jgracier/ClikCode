import { describe, expect, it } from 'vitest';
import { activityLabelIsReadOnly, recordPendingActivity } from './checkpoint.js';
import type { HarnessSession } from '../session/model.js';

/** The replay hints read tool rows as formatToolRow writes them, and as
 * rows recorded before it did. */
describe('reading tool rows for replay safety', () => {
  it.each([
    ['$ git status', true], ['$ rg foo src', true], ['$ npm test', false], ['$ ls …', false],
    ['Read src/a.ts', true], ['Grep TODO', true], ['Fetch https://x.dev', true], ['Web search vitest', true],
    ['Edit src/a.ts', false], ['Write src/new.ts', false], ['Agent review the tests', false],
    ['github › get_issue number=1', true], ['github › create_issue title=x', false],
    // Rows from before the shared format.
    ['Bash(git status)', true], ['Read(src/a.ts)', true], ['Edit(src/a.ts)', false], ['Task(review)', false], ['git status', true],
  ])('%s -> read-only %s', (label, readOnly) => {
    expect(activityLabelIsReadOnly(label)).toBe(readOnly);
  });

  it('records every path a file-change row names', () => {
    const session = { pendingTurn: { prompt: 'p', startedAt: '', updatedAt: '' } } as unknown as HarnessSession;
    recordPendingActivity(session, { kind: 'tool-start', label: 'Edit src/a.ts, src/b.ts', category: 'edit', id: 'e' }, 'now');
    recordPendingActivity(session, { kind: 'tool-start', label: 'Edit src/c.ts (3 changes)', category: 'edit', id: 'f' }, 'now');
    expect(session.pendingTurn).toMatchObject({ touchedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'], mutatingActivity: true });
  });
});
