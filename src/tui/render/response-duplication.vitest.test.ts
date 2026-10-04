import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { transientAssistantRequired } from './activity-log.js';

const noEntries: never[] = [];

describe('the live answer slot', () => {
  it('is drawn while the answer is still streaming', () => {
    expect(transientAssistantRequired('partial ans', true, 3, noEntries)).toBe(true);
  });

  it('is dropped once that same answer is saved in the transcript', () => {
    // checkpoint.complete() folds the response into session.messages while
    // liveResponse still holds it; any paint in between drew it twice.
    expect(transientAssistantRequired('the full answer', false, 4, noEntries, 'the full answer')).toBe(false);
  });

  it('ignores trailing whitespace differences between stream and saved text', () => {
    expect(transientAssistantRequired('the full answer\n\n', false, 4, noEntries, 'the full answer')).toBe(false);
  });

  it('ignores an internal paragraph break the stream inserted around a tool call', () => {
    // appendText() inserts a blank line between text blocks a tool call split
    // apart, but checkpoint.complete() persists the vendor's own `result`
    // field, which joins the same two blocks without that inserted break.
    // Real content, same words -- only the separator differs -- so this must
    // still be recognized as the same answer, not drawn a second time.
    expect(transientAssistantRequired(
      'First I checked the file.\n\nThen I fixed the bug.', false, 4, noEntries,
      'First I checked the file. Then I fixed the bug.',
    )).toBe(false);
  });

  it('drops it when the saved message merely ends with the streamed text', () => {
    expect(transientAssistantRequired('tail part', false, 4, noEntries, 'head part\ntail part')).toBe(false);
  });

  it('keeps drawing while a turn is in flight, even if text matches', () => {
    // Mid-turn the transcript holds the PREVIOUS answer; suppressing here
    // would hide the reply being streamed right now.
    expect(transientAssistantRequired('same words', true, 4, noEntries, 'same words')).toBe(true);
  });

  it('keeps it when the saved message is a different answer', () => {
    expect(transientAssistantRequired('new answer', false, 4, noEntries, 'an older answer')).toBe(true);
  });

  it('keeps it when nothing is saved yet', () => {
    expect(transientAssistantRequired('first answer', false, 4, noEntries, undefined)).toBe(true);
  });

  it('still anchors tools that arrive before any prose', () => {
    const entries = [{ anchor: 3, responseOffset: 0, lines: ['reading a file'] }] as never[];
    expect(transientAssistantRequired('', true, 3, entries)).toBe(true);
  });
});

describe('the session modes, and selection mode', () => {
  it('lives in modes.ts alone: the prompter never spells a mouse mode out', async () => {
    // The screen-opening write spelled the escapes inline, so it escaped the
    // first pass at gating them behind SELECTION_MODE and re-enabled tracking
    // on every new prompter -- defeating /select.
    const prompter = await readFile(new URL('../prompter.ts', import.meta.url), 'utf8');
    const inline = prompter.split('\n').filter((line) => /\?100[0236]h|_MOUSE_TRACKING/.test(line)
      && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'));
    expect(inline, 'prompter must go through sessionModesOn / redrawPreamble').toEqual([]);
  });

  it('asks for the mouse on taking the screen, after a resize, and back from a hand-over -- unless /select gave it back', async () => {
    const { SELECTION_MODE, redrawPreamble, sessionModesOff, sessionModesOn } = await import('../modes.js');
    const { terminalModes } = await import('../restore.js');
    const mouse = '\u001b[?1000h\u001b[?1002h\u001b[?1003h';
    try {
      expect(sessionModesOn(true)).toContain(mouse);
      expect(redrawPreamble('resize')).toBe('\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?25l\u001b[?7l\u001b[2J\u001b[H');
      // A hand-over switches everything off and the record says so, so
      // taking the screen back switches it all on again.
      expect(sessionModesOff(false)).toContain('\u001b[?1000l');
      expect(terminalModes.wheelReporting || terminalModes.bracketedPaste).toBe(false);
      expect(sessionModesOn()).toContain(`\u001b[?2004h${mouse}`);
      expect(terminalModes.wheelReporting && terminalModes.bracketedPaste).toBe(true);
      SELECTION_MODE.active = true;
      expect(sessionModesOn()).not.toContain('?1000h');
      expect(redrawPreamble('resize')).not.toContain('?1000h');
      expect(redrawPreamble('resize')).toContain('\u001b[2J\u001b[H');
    } finally {
      SELECTION_MODE.active = false;
    }
    expect(redrawPreamble('repair')).toBe('\u001b[?25l\u001b[?7l\u001b[2J\u001b[H');
    // A reply settling never clears.
    expect(redrawPreamble(undefined)).toBe('\u001b[?25l\u001b[?7l');
  });
});
