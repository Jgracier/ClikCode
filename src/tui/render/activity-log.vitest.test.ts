import { describe, expect, it } from 'vitest';
import { activityLifecyclePhase, rebaseActivityOffsets, toolStatusVerb, transientAssistantRequired, upsertActivityEvent } from './activity-log';

describe('the activity log', () => {
  it('updates repeated tool progress in place and ignores reasoning as chat activity', () => {
    const started = upsertActivityEvent([], 3, 12, { kind: 'tool-start', id: 'call-1', label: 'search\nrepository' });
    const repeated = upsertActivityEvent(started, 3, 12, { kind: 'tool-start', id: 'call-1', label: 'search repository' });
    const completed = upsertActivityEvent(repeated, 3, 18, { kind: 'tool-done', id: 'call-1', label: 'search repository' });
    const withThinking = upsertActivityEvent(completed, 3, 18, { kind: 'thinking', label: 'internal summary' });

    expect(started).toHaveLength(1);
    expect(repeated).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.event).toMatchObject({ kind: 'tool-done', id: 'call-1', label: 'search repository' });
    expect(withThinking).toEqual(completed);
  });

  it('pairs an id-less tool completion even when prose advanced its response offset', () => {
    const started = upsertActivityEvent([], 3, 4, { kind: 'tool-start', label: 'files updated' });
    const completed = upsertActivityEvent(started, 3, 19, { kind: 'tool-done', label: 'files updated' });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ responseOffset: 4, event: { kind: 'tool-done', label: 'files updated' } });
  });

  it('keeps the status on a remaining parallel tool until all tools finish', () => {
    // The status line names the newest open call.
    let state = activityLifecyclePhase(new Map(), { kind: 'tool-start', id: 'one', label: 'read files', category: 'read' });
    state = activityLifecyclePhase(state.activeTools, { kind: 'tool-start', id: 'two', label: 'Bash(npm test)', category: 'run' });
    expect(state.phase).toBe('running tests');
    expect(state.category).toBe('run');
    state = activityLifecyclePhase(state.activeTools, { kind: 'thinking', label: 'reviewed output' });
    expect(state.phase).toBe('running tests');
    state = activityLifecyclePhase(state.activeTools, { kind: 'tool-done', id: 'two', label: 'Bash(npm test)', category: 'run' });
    // Falls back to the one still running, which is a read naming no file.
    expect(state.phase).toBe('reading');
    expect(state.category).toBe('read');
    state = activityLifecyclePhase(state.activeTools, { kind: 'tool-error', id: 'one', label: 'read files' });
    expect(state.phase).toBe('thinking');
  });

  it('says what the open call is working on, from its label alone', () => {
    expect(toolStatusVerb({ label: 'Read(src/tui/app.ts)', category: 'read' })).toBe('reading app.ts');
    expect(toolStatusVerb({ label: 'Edit(/repo/src/prompter.ts)', category: 'edit' })).toBe('editing prompter.ts');
    expect(toolStatusVerb({ label: 'Bash(pnpm vitest run src)', category: 'run' })).toBe('running tests');
    expect(toolStatusVerb({ label: 'git status --short', category: 'run' })).toBe('running git');
    expect(toolStatusVerb({ label: '$ git log --oneline', category: 'run' })).toBe('running git');
    expect(toolStatusVerb({ label: 'Bash(CI=1 /usr/bin/make build)', category: 'run' })).toBe('running make');
    expect(toolStatusVerb({ label: 'Grep(TODO)', category: 'search' })).toBe('searching');
    expect(toolStatusVerb({ label: 'Task(review the diff)' })).toBe('waiting on agent');
    expect(toolStatusVerb({ label: 'mcp__linear__list_issues' })).toBe('running mcp__linear__list_issues');
  });

  it('records when a call started and keeps it through its later frames', () => {
    const started = upsertActivityEvent([], 0, 0, { kind: 'tool-start', id: 'a', label: 'Bash(ls)', category: 'run' }, 1, 1_000);
    const done = upsertActivityEvent(started, 0, 5, { kind: 'tool-done', id: 'a', label: 'Bash(ls)' }, 2, 9_000);
    expect(done[0]!.startedAt).toBe(1_000);
  });

  it('retains source activity beyond the visual summary limit', () => {
    let entries = [] as ReturnType<typeof upsertActivityEvent>;
    for (let index = 0; index < 60; index += 1) {
      entries = upsertActivityEvent(entries, 3, index, { kind: 'tool-done', id: String(index), label: `tool ${index}` });
    }
    expect(entries).toHaveLength(60);
    expect(entries[0]?.event?.label).toBe('tool 0');
  });

  it('rebases tool offsets when replacement text rewrites the streamed prefix', () => {
    const entries = upsertActivityEvent([], 3, 12, { kind: 'tool-done', id: 'one', label: 'inspect' });
    expect(rebaseActivityOffsets(entries, 3, 'Original response', 'Changed response')[0]?.responseOffset).toBe(0);
    expect(rebaseActivityOffsets(entries, 3, 'Original', 'Original extended')[0]?.responseOffset).toBe(8);
  });

  it('creates the live assistant anchor before prose so tools appear as they happen', () => {
    const entries = upsertActivityEvent([], 3, 0, { kind: 'tool-start', id: 'call-1', label: 'inspect' });
    expect(transientAssistantRequired('', true, 3, entries)).toBe(true);
    expect(transientAssistantRequired('', false, 3, entries)).toBe(false);
    expect(transientAssistantRequired('A', true, 3, [])).toBe(true);
    expect(transientAssistantRequired('', true, 3, [])).toBe(false);
  });
});
