import { describe, expect, it } from 'vitest';
import { waitingInputActions } from './terminal-ui';

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
