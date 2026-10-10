import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../agent/line-diff.js';
import type { HarnessSession } from '../../session/model.js';
import { stateDirectory } from '../../session/store/paths.js';
import { appendTurnChanges, turnMessageIndex, type TurnChangeRecord } from '../../session/turn-changes.js';
import { changesPath, fileTurnRows, fileTurnsText, isChangesPath } from './file-changes.js';
import { resolveSlashCommand } from './registry.js';

const edit = (file: string, additions = 1, removals = 0): FileDiff => ({ path: file, additions, removals, lines: [] } as unknown as FileDiff);

describe('/changes <path>', () => {
  it('tells a turn number from a path', () => {
    expect(isChangesPath('')).toBe(false);
    expect(isChangesPath('3')).toBe(false);
    expect(isChangesPath('src/a.ts')).toBe(true);
    expect(changesPath('src/a.ts', '/work')).toBe(path.resolve('/work/src/a.ts'));
  });

  it('lists the turns of every conversation that edited the file, newest first', async () => {
    const work = '/work/project';
    const sessions = [
      { id: 'aaaaaaaa-1', name: 'Footer fix', workspace: work },
      { id: 'bbbbbbbb-2', name: 'Search command', workspace: work },
      { id: 'cccccccc-3', name: 'Elsewhere', workspace: '/other' },
    ] as HarnessSession[];
    // A relative path in a record is its conversation's workspace's.
    await appendTurnChanges(stateDirectory(), 'aaaaaaaa-1', { at: '2026-10-10T09:00:00Z', prompt: 'fix the footer', changes: [edit('src/a.ts', 2, 1)] });
    await appendTurnChanges(stateDirectory(), 'aaaaaaaa-1', { at: '2026-10-10T09:30:00Z', prompt: 'and the tests', changes: [edit(path.join(work, 'src/a.test.ts'))] });
    await appendTurnChanges(stateDirectory(), 'bbbbbbbb-2', { at: '2026-10-10T11:00:00Z', prompt: 'add search', changes: [edit(path.join(work, 'src/a.ts'), 5, 0)] });
    // Same relative name, another workspace: another file.
    await appendTurnChanges(stateDirectory(), 'cccccccc-3', { at: '2026-10-10T11:30:00Z', prompt: 'unrelated', changes: [edit('src/a.ts')] });
    const rows = await fileTurnRows({ sessions }, path.join(work, 'src/a.ts'), Date.parse('2026-10-10T12:00:00Z'));
    expect(rows.map((row) => [row.sessionId, row.turnsAgo, row.additions, row.removals])).toEqual([['bbbbbbbb-2', 1, 5, 0], ['aaaaaaaa-1', 2, 2, 1]]);
    expect(rows[0]).toMatchObject({ label: '60m ago · Search command bbbbbbbb', detail: 'turn 1 · "add search" · +5 -0' });
    const text = fileTurnsText(path.join(work, 'src/a.ts'), rows);
    expect(text.split('\n')[0]).toContain('2 turns edited it, newest first');
    expect(fileTurnsText('/nowhere.ts', [])).toBe('No recorded turn in any conversation edited /nowhere.ts.');
  });

  it("finds a turn's prompt in the transcript, newest first, so a repeated prompt finds its own copy", () => {
    const messages = [
      { role: 'user', content: 'continue' }, { role: 'assistant', content: 'a' },
      { role: 'user', content: 'fix it' }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'continue' }, { role: 'assistant', content: 'c' },
    ];
    const records = ['continue', 'fix it', 'continue'].map((prompt) => ({ at: '', prompt, changes: [] }) as TurnChangeRecord);
    expect(turnMessageIndex(messages, records, 1)).toBe(4);
    expect(turnMessageIndex(messages, records, 2)).toBe(2);
    expect(turnMessageIndex(messages, records, 3)).toBe(0);
    expect(turnMessageIndex(messages, [{ at: '', prompt: 'never sent', changes: [] }], 1)).toBeUndefined();
  });

  it('is available with a path even where a plain-text CLI records no turns', () => {
    const textCli = { command: 'x', provider: 'x', displayName: 'Aider', transport: 'text-cli', localAuth: [], binary: 'x' } as never;
    const changes = resolveSlashCommand('changes')!;
    const session = { id: 's', route: 'local' } as HarnessSession;
    expect(changes.availability(session, textCli).available).toBe(false);
    expect(changes.availability(session, textCli, '2').available).toBe(false);
    expect(changes.availability(session, textCli, 'src/a.ts').available).toBe(true);
  });
});
