import { describe, expect, it } from 'vitest';
import { terminalCellWidth } from './markdown-render';
import { anchoredScrollOffset, commandPaletteMatches, editWaitingComposer, responseTimeline, rightLabeledRule, TerminalInputDecoder, transientAssistantRequired, upsertActivityEvent, waitingInputActions, waitingSpinnerFrame, waitingSpinnerGlyph } from './terminal-ui';

describe('full-screen waiting input', () => {
  it('packs four animation phases of a logical 4x4 grid into two Braille cells', () => {
    const frames = Array.from({ length: 4 }, (_, frame) => waitingSpinnerFrame(frame));
    expect(new Set(frames.map((frame) => JSON.stringify(frame))).size).toBe(4);
    expect(waitingSpinnerFrame(4)).toEqual(frames[0]);
    expect(frames.every((frame) => frame.flat().length === 16 && frame.flat().filter(Boolean).length === 8)).toBe(true);
    const glyphs = Array.from({ length: 4 }, (_, frame) => waitingSpinnerGlyph(frame));
    expect(new Set(glyphs).size).toBe(4);
    expect(glyphs.every((glyph) => [...glyph].length === 2 && terminalCellWidth(glyph) === 2)).toBe(true);
  });

  it('keeps scrolling available while a provider turn is running', () => {
    expect(waitingInputActions('\u001b[A\u001b[5~\u001b[B\u001b[6~\u001b[<64;4;8M\u001b[<65;4;8M')).toEqual([
      'scroll-up', 'page-up', 'scroll-down', 'page-down', 'scroll-up', 'scroll-down',
    ]);
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

  it('holds the visible transcript in place while streamed lines are appended', () => {
    expect(anchoredScrollOffset(6, 40, 44, 30)).toBe(10);
    expect(anchoredScrollOffset(0, 40, 44, 30)).toBe(0);
    expect(anchoredScrollOffset(29, 40, 44, 30)).toBe(30);
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
