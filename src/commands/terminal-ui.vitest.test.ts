import { describe, expect, it } from 'vitest';
import { terminalCellWidth } from './markdown-render';
import { activityLifecyclePhase, commandPaletteMatches, composerRightArrowValue, editWaitingComposer, liveConversationLines, pickerConfirmsSelection, pickerDeletesSelection, rebaseActivityOffsets, rightLabeledRule, TerminalInputDecoder, terminalUiSupported, transientAssistantRequired, upsertActivityEvent, waitingInputActions, waitingSpinnerFrame, waitingSpinnerGlyph } from './terminal-ui';

describe('terminal waiting input', () => {
  it('uses the inline renderer only on ANSI-capable interactive terminals', () => {
    expect(terminalUiSupported(true, true, { TERM: 'xterm-256color' })).toBe(true);
    expect(terminalUiSupported(true, true, { WT_SESSION: '1' })).toBe(true);
    expect(terminalUiSupported(true, true, { TERM: 'dumb' })).toBe(false);
    expect(terminalUiSupported(false, true, { TERM: 'xterm' })).toBe(false);
  });
  it('packs four animation phases of a logical 4x4 grid into two Braille cells', () => {
    const frames = Array.from({ length: 4 }, (_, frame) => waitingSpinnerFrame(frame));
    expect(new Set(frames.map((frame) => JSON.stringify(frame))).size).toBe(4);
    expect(waitingSpinnerFrame(4)).toEqual(frames[0]);
    expect(frames.every((frame) => frame.flat().length === 16 && frame.flat().filter(Boolean).length === 8)).toBe(true);
    const glyphs = Array.from({ length: 4 }, (_, frame) => waitingSpinnerGlyph(frame));
    expect(new Set(glyphs).size).toBe(4);
    expect(glyphs.every((glyph) => [...glyph].length === 2 && terminalCellWidth(glyph) === 2)).toBe(true);
  });

  it('does not pretend navigation keys are handled scroll actions', () => {
    expect(waitingInputActions('\u001b[A\u001b[5~\u001b[B\u001b[6~')).toEqual([]);
  });

  it('buffers fragmented Termius escape sequences and UTF-8 characters', () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.push(Buffer.from('\u001b'))).toEqual([]);
    expect(decoder.push(Buffer.from('[D'))).toEqual(['\u001b[D']);
    expect(decoder.push(Buffer.from('\u001bOD\u001b[1;5C'))).toEqual(['\u001b[D', '\u001b[C']);
    const wide = Buffer.from('界');
    expect(decoder.push(wide.subarray(0, 1))).toEqual([]);
    expect(decoder.push(wide.subarray(1))).toEqual(['界']);
    expect(decoder.push(Buffer.from('\u001b'))).toEqual([]);
    expect(decoder.flush()).toEqual(['\u001b']);
    expect(decoder.push(Buffer.from('x'))).toEqual(['x']);
    expect(decoder.push(Buffer.from('\u001by'))).toEqual(['\u001by']);
  });

  it('keeps real live content in the final row on compact mobile viewports', () => {
    expect(liveConversationLines(['user', '', 'streamed response', ''], true)).toEqual([
      'user', '', 'streamed response',
    ]);
    expect(liveConversationLines(['user', '', '· running tool', '', ''], true)).toEqual([
      'user', '', '· running tool',
    ]);
    expect(liveConversationLines(['user', ''], false)).toEqual(['user', '']);
  });

  it('keeps escape and control-c as cancellation without treating other keys as actions', () => {
    expect(waitingInputActions(`x\u001b\u0003`)).toEqual(['cancel-edit', 'cancel-stop']);
  });

  it('edits a real composer during generation instead of discarding typed keys', () => {
    let draft = { value: '', cursor: 0, changed: false };
    for (const key of ['n', 'e', 'x', 't']) draft = editWaitingComposer(draft.value, draft.cursor, key);
    draft = editWaitingComposer(draft.value, draft.cursor, '\u001b[D');
    draft = editWaitingComposer(draft.value, draft.cursor, '!');
    expect(draft).toEqual({ value: 'nex!t', cursor: 4, changed: true });
    expect(editWaitingComposer(draft.value, draft.cursor, '\u007f')).toEqual({ value: 'next', cursor: 3, changed: true });
  });

  it('opens the main slash choices from Right Arrow only when the composer is empty', () => {
    expect(composerRightArrowValue('', false, true)).toBe('/');
    expect(composerRightArrowValue('draft', false, true)).toBeUndefined();
    expect(composerRightArrowValue('', true, true)).toBeUndefined();
  });

  it('uses Right Arrow or Enter to choose and Delete only for destructive row actions', () => {
    expect(['\r', '\n', '\u001b[C'].every(pickerConfirmsSelection)).toBe(true);
    expect(pickerConfirmsSelection('\u001b[3~')).toBe(false);
    expect(pickerDeletesSelection('\u001b[3~')).toBe(true);
  });

  it('reserves confirmation for Enter so Left Arrow can consistently navigate back', () => {
    expect(pickerConfirmsSelection('\r')).toBe(true);
    expect(pickerConfirmsSelection('\u001b[D')).toBe(false);
  });

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

describe('command palette layout', () => {
  it('fully reclaims the palette rows as soon as the slash is deleted', () => {
    const commands = [{ label: '/help', value: '/help' }, { label: '/model', value: '/model' }];
    expect(commandPaletteMatches('/', commands)).toHaveLength(2);
    expect(commandPaletteMatches('', commands)).toEqual([]);
  });
});

describe('composer border labels', () => {
  it('right-aligns usage and title labels without changing the border width', () => {
    expect(rightLabeledRule(40, '5h 88% left · weekly 66% left')).toBe('─'.repeat(10) + ' 5h 88% left · weekly 66% left');
    expect(terminalCellWidth(rightLabeledRule(40, '5h 88% left · weekly 66% left'))).toBe(40);
    expect(rightLabeledRule(30, 'Fix session persistence')).toBe('─'.repeat(6) + ' Fix session persistence');
  });

  it('keeps a visible rule when a label must be truncated', () => {
    const line = rightLabeledRule(12, 'an extremely long title');
    expect(terminalCellWidth(line)).toBe(12);
    expect(line.startsWith('───')).toBe(true);
  });
});
