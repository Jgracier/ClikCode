import { describe, expect, it } from 'vitest';
import {
  SESSION_TITLE_MAX, StreamingTitle, extractSessionTitle, normalizeSessionTitle, sessionTitleSource, withTitleRequest,
} from './session-title';
import type { AiLocalHarnessDefinition } from './types';

const harness = (command: string): AiLocalHarnessDefinition => ({ command } as AiLocalHarnessDefinition);
const OPEN = '<clikcode-title>';
const CLOSE = '</clikcode-title>';

describe('naming a conversation', () => {
  it('asks only the harnesses that do not name their own threads', () => {
    expect(sessionTitleSource(harness('claude'))).toBe('vendor');
    for (const command of ['codex', 'gemini', 'opencode', 'cursor']) {
      expect(sessionTitleSource(harness(command)), command).toBe('ask');
    }
  });

  it('keeps the request out of what the user typed', () => {
    const asked = withTitleRequest('fix the parser');
    expect(asked.startsWith('fix the parser')).toBe(true);
    expect(asked).toContain(String(SESSION_TITLE_MAX));
  });

  it('takes the title off the front of a reply', () => {
    const { title, text } = extractSessionTitle(`${OPEN}Parser crash${CLOSE}\nHere is what I found.`);
    expect(title).toBe('Parser crash');
    expect(text).toBe('Here is what I found.');
  });

  it('leaves a reply that never names anything alone', () => {
    const answer = 'Here is what I found.';
    expect(extractSessionTitle(answer)).toEqual({ text: answer });
  });

  it('cuts an over-long title on a word boundary', () => {
    expect(normalizeSessionTitle('"  Scrolling   and cursor placement on phones. "'))
      .toBe('Scrolling and');
    expect(normalizeSessionTitle('supercalifragilisticexpialidocious')).toHaveLength(SESSION_TITLE_MAX);
    expect(normalizeSessionTitle('   ')).toBeUndefined();
  });
});

describe('a title arriving one delta at a time', () => {
  it('shows nothing until the tag has closed, then only the answer', () => {
    const stream = new StreamingTitle();
    expect(stream.push(`${OPEN}Parser`, 'append')).toBeUndefined();
    expect(stream.push(' crash', 'append')).toBeUndefined();
    expect(stream.push(`${CLOSE}\nHere is`, 'append')).toBe('Here is');
    expect(stream.push(' what I found.', 'append')).toBe(' what I found.');
    expect(stream.title).toBe('Parser crash');
  });

  it('releases the head as soon as it is clear no title is coming', () => {
    const stream = new StreamingTitle();
    expect(stream.push('Here', 'append')).toBe('Here');
    expect(stream.push(' is what I found.', 'append')).toBe(' is what I found.');
    expect(stream.title).toBeUndefined();
  });

  it('strips the tag from a reply that is re-sent whole each time', () => {
    const stream = new StreamingTitle();
    expect(stream.push(`${OPEN}Parser crash${CLOSE}\nHere`, 'replace')).toBe('Here');
    expect(stream.push(' is what I found.', 'append')).toBe(' is what I found.');
    expect(stream.title).toBe('Parser crash');
  });

  it('hands back what it was holding when the stream ends mid-tag', () => {
    const stream = new StreamingTitle();
    expect(stream.push(`${OPEN}Parser`, 'append')).toBeUndefined();
    expect(stream.flush()).toBe(`${OPEN}Parser`);
    expect(stream.title).toBeUndefined();
  });

  it('gives up on a model that opens with the tag and never closes it', () => {
    const stream = new StreamingTitle();
    const long = `${OPEN}${'a'.repeat(200)}`;
    expect(stream.push(long, 'append')).toBe(long);
    expect(stream.title).toBeUndefined();
  });
});
