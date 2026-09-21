import { describe, expect, it } from 'vitest';
import { activityLifecyclePhase, rebaseActivityOffsets, transientAssistantRequired, upsertActivityEvent } from './activity-log';

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

  it('keeps the spinner on a remaining parallel tool until all tools finish', () => {
    let state = activityLifecyclePhase(new Map(), { kind: 'tool-start', id: 'one', label: 'read files' });
    state = activityLifecyclePhase(state.activeTools, { kind: 'tool-start', id: 'two', label: 'run tests' });
    expect(state.phase).toBe('running run tests');
    state = activityLifecyclePhase(state.activeTools, { kind: 'thinking', label: 'reviewed output' });
    expect(state.phase).toBe('running run tests');
    state = activityLifecyclePhase(state.activeTools, { kind: 'tool-done', id: 'two', label: 'run tests' });
    expect(state.phase).toBe('running read files');
    state = activityLifecyclePhase(state.activeTools, { kind: 'tool-error', id: 'one', label: 'read files' });
    expect(state.phase).toBe('thinking');
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
