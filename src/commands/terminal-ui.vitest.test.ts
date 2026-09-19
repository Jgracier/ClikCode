import { describe, expect, it } from 'vitest';
import { terminalCellWidth } from './markdown-render';
import { commandPaletteMatches, editWaitingComposer, responseTimeline, rightLabeledRule, transientAssistantRequired, upsertActivityEvent, waitingInputActions, waitingSpinnerFrame } from './terminal-ui';

describe('full-screen waiting input', () => {
  it('pulses a compact 4x4 square without changing its shape', () => {
    const first = waitingSpinnerFrame(0);
    const held = waitingSpinnerFrame(1);
    const alternate = waitingSpinnerFrame(2);
    expect(first).toEqual([
      [true, false, true, false],
      [false, true, false, true],
      [true, false, true, false],
      [false, true, false, true],
    ]);
    expect(held).toEqual(first);
    expect(alternate.flat()).toEqual(first.flat().map((active) => !active));
    expect(first.flat()).toHaveLength(16);
  });

  it('keeps scrolling available while a provider turn is running', () => {
    expect(waitingInputActions('\u001b[A\u001b[5~\u001b[B\u001b[6~')).toEqual([
      'scroll-up', 'page-up', 'scroll-down', 'page-down',
    ]);
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
});

describe('streamed response chronology', () => {
  it('keeps tool activity at the response offset where it occurred', () => {
    expect(responseTimeline('I will inspect it.\n\nThe issue is fixed.', [
      { kind: 'activity', responseOffset: 19, lines: ['tool read file'] },
      { kind: 'activity', responseOffset: 19, lines: ['done read file'] },
    ])).toEqual([
      { kind: 'markdown', block: { kind: 'paragraph', text: 'I will inspect it.', quoteDepth: 0, indent: 0, sourceEnd: 20 } },
      { kind: 'activity', responseOffset: 19, lines: ['tool read file'] },
      { kind: 'activity', responseOffset: 19, lines: ['done read file'] },
      { kind: 'markdown', block: { kind: 'paragraph', text: 'The issue is fixed.', quoteDepth: 0, indent: 0, sourceEnd: 39 } },
    ]);
  });

  it('waits for a complete compound Markdown block before inserting live events', () => {
    const markdown = '- parent\n  - child\n- sibling\n\nAfter.';
    const parts = responseTimeline(markdown, [
      { kind: 'steer', responseOffset: 12, sequence: 1, text: 'Check the nested item' },
      { kind: 'activity', responseOffset: 12, sequence: 2, lines: ['tool inspect'] },
    ]);
    expect(parts.map((part) => part.kind)).toEqual([
      'markdown', 'markdown', 'markdown', 'steer', 'activity', 'markdown',
    ]);
    expect(parts[3]).toMatchObject({ kind: 'steer', text: 'Check the nested item' });
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

  it('collapses a tool-only burst instead of letting it dominate the viewport', () => {
    const parts = responseTimeline('Done.', Array.from({ length: 7 }, (_, index) => ({
      kind: 'activity' as const, responseOffset: 0, lines: [`done tool ${index + 1}`],
    })));
    expect(parts).toEqual([
      { kind: 'activity', responseOffset: 0, lines: ['… 3 earlier tool calls'] },
      { kind: 'activity', responseOffset: 0, lines: ['done tool 4'] },
      { kind: 'activity', responseOffset: 0, lines: ['done tool 5'] },
      { kind: 'activity', responseOffset: 0, lines: ['done tool 6'] },
      { kind: 'activity', responseOffset: 0, lines: ['done tool 7'] },
      { kind: 'markdown', block: { kind: 'paragraph', text: 'Done.', quoteDepth: 0, indent: 0, sourceEnd: 5 } },
    ]);
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
