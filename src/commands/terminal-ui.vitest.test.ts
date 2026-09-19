import { describe, expect, it } from 'vitest';
import { terminalCellWidth } from './markdown-render';
import { commandPaletteMatches, editWaitingComposer, interleaveResponseContent, rightLabeledRule, transientAssistantRequired, upsertActivityEvent, waitingInputActions, waitingSpinnerFrame } from './terminal-ui';

describe('full-screen waiting input', () => {
  it('alternates opposite dots in a stable ASCII square', () => {
    expect([waitingSpinnerFrame(0), waitingSpinnerFrame(1), waitingSpinnerFrame(2)]).toEqual([
      '[o . / . o]', '[. o / o .]', '[o . / . o]',
    ]);
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
    expect(interleaveResponseContent('I will inspect it. The issue is fixed.', [
      { responseOffset: 19, lines: ['tool read file'] },
      { responseOffset: 19, lines: ['done read file'] },
    ])).toEqual([
      { kind: 'text', text: 'I will inspect it. ' },
      { kind: 'activity', lines: ['tool read file'] },
      { kind: 'activity', lines: ['done read file'] },
      { kind: 'text', text: 'The issue is fixed.' },
    ]);
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

  it('collapses a tool-only burst instead of letting it dominate the viewport', () => {
    const parts = interleaveResponseContent('Done.', Array.from({ length: 7 }, (_, index) => ({
      responseOffset: 0, lines: [`done tool ${index + 1}`],
    })));
    expect(parts).toEqual([
      { kind: 'activity', lines: ['… 3 earlier tool calls'] },
      { kind: 'activity', lines: ['done tool 4'] },
      { kind: 'activity', lines: ['done tool 5'] },
      { kind: 'activity', lines: ['done tool 6'] },
      { kind: 'activity', lines: ['done tool 7'] },
      { kind: 'text', text: 'Done.' },
    ]);
  });

  it('creates the live assistant anchor before prose so tools appear as they happen', () => {
    const entries = upsertActivityEvent([], 3, 0, { kind: 'tool-start', id: 'call-1', label: 'inspect' });
    expect(transientAssistantRequired('', true, 3, entries)).toBe(true);
    expect(transientAssistantRequired('', false, 3, entries)).toBe(false);
    expect(transientAssistantRequired('A', true, 3, [])).toBe(true);
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
    expect(rightLabeledRule(40, '5h 12% used · weekly 34% used')).toBe('─'.repeat(10) + ' 5h 12% used · weekly 34% used');
    expect(terminalCellWidth(rightLabeledRule(40, '5h 12% used · weekly 34% used'))).toBe(40);
    expect(rightLabeledRule(30, 'Fix session persistence')).toBe('─'.repeat(6) + ' Fix session persistence');
  });

  it('keeps a visible rule when a label must be truncated', () => {
    const line = rightLabeledRule(12, 'an extremely long title');
    expect(terminalCellWidth(line)).toBe(12);
    expect(line.startsWith('───')).toBe(true);
  });
});
