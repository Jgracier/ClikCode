import { describe, expect, it } from 'vitest';
import { interleaveResponseContent, waitingInputActions } from './terminal-ui';

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
