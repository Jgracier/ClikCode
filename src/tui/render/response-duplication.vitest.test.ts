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

describe('every mouse-tracking enable site is gated', () => {
  it('spells the modes out only in named constants', async () => {
    // The screen-opening write spelled the escapes inline, so it escaped the
    // first pass at gating them behind SELECTION_MODE and re-enabled tracking
    // on every new prompter -- defeating /select.
    const modes = await readFile(new URL('../modes.ts', import.meta.url), 'utf8');
    const declarations = modes.split('\n').filter((line) =>
      line.includes('?1003h') && line.includes('export const'));
    expect(declarations).toHaveLength(2);

    const prompter = await readFile(new URL('../prompter.ts', import.meta.url), 'utf8');
    const inline = prompter.split('\n').filter((line) =>
      line.includes('?1003h') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'));
    expect(inline, 'prompter must use the constants, not raw escapes').toEqual([]);
  });

  it('checks selection mode wherever the prompter enables tracking', async () => {
    const lines = (await readFile(new URL('../prompter.ts', import.meta.url), 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      if (!/\b(ENABLE|OPENING)_MOUSE_TRACKING\b/.test(line)) continue;
      if (line.includes('import ')) continue;
      expect(line, `ungated enable at line ${index + 1}: ${line.trim()}`).toContain('SELECTION_MODE.active');
    }
  });
});
