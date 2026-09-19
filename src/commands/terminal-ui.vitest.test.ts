import { describe, expect, it } from 'vitest';
import { terminalCellWidth } from './markdown-render';
import { commandPaletteMatches, interleaveResponseContent, rightLabeledRule, waitingInputActions } from './terminal-ui';

describe('full-screen waiting input', () => {
  it('keeps scrolling available while a provider turn is running', () => {
    expect(waitingInputActions('\u001b[A\u001b[5~\u001b[B\u001b[6~')).toEqual([
      'scroll-up', 'page-up', 'scroll-down', 'page-down',
    ]);
  });

  it('keeps escape and control-c as cancellation without treating other keys as actions', () => {
    expect(waitingInputActions(`x\u001b\u0003`)).toEqual(['cancel', 'cancel']);
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
