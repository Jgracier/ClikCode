import { describe, expect, it } from 'vitest';
import { signalsTeardown, terminalModes } from './restore.js';
import {
  NOTIFY_AFTER_UNFOCUSED_MS, POP_TITLE, notifySequence, progressSequence, shouldNotify, titleSequence, windowTitle,
} from './terminal-signals.js';

describe('what the terminal around the UI is told', () => {
  it('titles the window with the conversation, and whether a turn is working or waiting on the user', () => {
    expect(windowTitle({ running: true, name: 'Fix the parser' })).toBe('working · Fix the parser');
    expect(windowTitle({ running: true, asking: true, name: 'Fix the parser' })).toBe('waiting for you · Fix the parser');
    expect(windowTitle({ running: false, name: 'Fix the parser' })).toBe('Fix the parser');
    expect(windowTitle({ running: false })).toBe('ClikCode');
    expect(windowTitle({ running: true })).toBe('working · ClikCode');
  });

  it('never lets text end the sequence early or start another', () => {
    expect(titleSequence('a\u0007b\u001b]0;evil\nc')).toBe('\u001b]0;a b ]0;evil c\u0007');
    // `4;` after OSC 9 would be a progress command, not a message.
    expect(notifySequence('4; done')).toBe('\u001b]9;4: done\u0007\u0007');
    expect(notifySequence('Approval needed: npm test')).toBe('\u001b]9;Approval needed: npm test\u0007\u0007');
  });

  it('shows indeterminate progress while running, and clears it', () => {
    expect(progressSequence(true)).toBe('\u001b]9;4;3;\u0007');
    expect(progressSequence(false)).toBe('\u001b]9;4;0;\u0007');
  });

  it('notifies only once the terminal has said it lost focus long enough ago', () => {
    const now = 100_000;
    expect(shouldNotify({ since: 0 }, now)).toBe(false);
    expect(shouldNotify({ focused: true, since: 0 }, now)).toBe(false);
    expect(shouldNotify({ focused: false, since: now - NOTIFY_AFTER_UNFOCUSED_MS + 1 }, now)).toBe(false);
    expect(shouldNotify({ focused: false, since: now - NOTIFY_AFTER_UNFOCUSED_MS }, now)).toBe(true);
  });

  it('hands back exactly what it set, once', () => {
    terminalModes.titlePushed = true;
    terminalModes.progress = true;
    expect(signalsTeardown()).toBe(`${progressSequence(false)}${POP_TITLE}`);
    expect(signalsTeardown()).toBe('');
    terminalModes.titlePushed = true;
    expect(signalsTeardown()).toBe(POP_TITLE);
  });
});
