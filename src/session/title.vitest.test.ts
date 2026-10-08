import { describe, expect, it } from 'vitest';
import {
  SESSION_TITLE_MAX, StreamingTitle, contextRichEnough, extractSessionTitle, normalizeSessionTitle,
  prepareSessionTitle, sessionTitleSource, shouldRequestTitle, titleStreamForAttempt, withTitleRequest,
} from './title.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import type { AiLocalHarnessDefinition } from '../harness/definition';

/** The catalog's own entry: which source a harness uses is declared there. */
const harness = (command: string): AiLocalHarnessDefinition => localHarnessForCommand(command) as AiLocalHarnessDefinition;
const OPEN = '<clikcode-title>';
const CLOSE = '</clikcode-title>';

describe('naming a conversation', () => {
  it('asks only the harnesses that do not name their own threads', () => {
    expect(sessionTitleSource(harness('claude'))).toBe('vendor');
    expect(sessionTitleSource(harness('aider'))).toBe('none');
    expect(sessionTitleSource(undefined)).toBe('ask');
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

  it('releases an ordinary opening immediately', () => {
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

describe('a replace-mode stream never shows the title tag', () => {
  const ANSWER = '<clikcode-title>Response Test</clikcode-title>\nBANANA';

  /** Feed a stream and return what the user would have seen. */
  const shown = (deltas: readonly string[], mode: 'append' | 'replace'): string => {
    const stream = new StreamingTitle();
    let visible = '';
    for (const delta of deltas) {
      const next = stream.push(delta, mode);
      if (next !== undefined) visible = mode === 'replace' ? next : visible + next;
    }
    const tail = stream.flush();
    return tail === undefined ? visible : visible + tail;
  };

  it('strips the tag from every replace, not just the one that settles it', () => {
    // Some transports re-send the whole answer on each update. Once settled,
    // push used to return that verbatim: the raw tag appeared on screen, and
    // the displayed answer no longer matched the cleaned text that gets
    // persisted -- which is what made the transcript emit the reply twice.
    const cumulative: string[] = [];
    for (let end = 1; end <= ANSWER.length; end += 9) cumulative.push(ANSWER.slice(0, end));
    cumulative.push(ANSWER);
    expect(shown(cumulative, 'replace')).toBe('BANANA');
  });

  it('agrees with what gets persisted, so the transcript sees no new text', () => {
    const stream = new StreamingTitle();
    stream.push(ANSWER, 'replace');
    expect(stream.push(ANSWER, 'replace')).toBe(extractSessionTitle(ANSWER).text);
  });

  it('still passes appended deltas through untouched once settled', () => {
    const stream = new StreamingTitle();
    stream.push('<clikcode-title>T</clikcode-title>\nfirst', 'append');
    expect(stream.push(' and more', 'append')).toBe(' and more');
  });

  it('shows the answer whole however the deltas are cut', () => {
    expect(shown([ANSWER], 'append')).toBe('BANANA');
    expect(shown(ANSWER.match(/.{1,7}/gs) ?? [], 'append')).toBe('BANANA');
    expect(shown([...ANSWER], 'append').trim()).toBe('BANANA');
  });
});

/** An account switch abandons one reply and starts another. Naming belongs to
 * a new chat's own reply, so nothing about the name may cross that seam. */
describe('an account switch mid-turn', () => {
  it('keeps no title from the attempt it abandoned', () => {
    const stream = new StreamingTitle();
    // The exhausted account got as far as opening a title and died there.
    stream.push('<clikcode-title>Half a na', 'append');
    stream.restart();
    stream.push('<clikcode-title>Prod Disk Cleanup</clikcode-title>\nOn it.', 'append');
    expect(stream.title).toBe('Prod Disk Cleanup');
  });

  it('strips the new reply\'s marker instead of passing it through settled', () => {
    const stream = new StreamingTitle();
    stream.push('Looking at the workspace now', 'append');
    expect(stream.title).toBeUndefined();
    stream.restart();
    // Without the restart this returns the delta verbatim, tag included.
    const shown = stream.push('<clikcode-title>Prod Disk Cleanup</clikcode-title>\nOn it.', 'append');
    expect(shown).toBe('On it.');
    expect(shown).not.toContain('<clikcode-title>');
  });

  it('waits until the user has said enough, then asks once', () => {
    const fresh = { name: undefined, titleAttempts: 0, messages: [] };
    expect(contextRichEnough(fresh, 'hi')).toBe(false);
    expect(contextRichEnough(fresh, 'do it')).toBe(false);
    expect(shouldRequestTitle(fresh, 'hi')).toBe(false);
    const waiting = prepareSessionTitle(fresh, 'hi');
    expect(waiting.prompt).toBe('hi');
    expect(waiting.stream).toBeUndefined();
    expect(fresh.titleAttempts).toBe(0);
    const first = prepareSessionTitle(fresh, 'fix the parser');
    expect(first.prompt).toContain(OPEN);
    expect(first.stream).toBeInstanceOf(StreamingTitle);
    expect(fresh.titleAttempts).toBe(1);
    expect(prepareSessionTitle(fresh, 'the login button still fails').prompt).toBe('the login button still fails');
    expect(fresh.titleAttempts).toBe(1);
  });

  it('never re-asks after the one title request was spent', () => {
    const session = { name: undefined, titleAttempts: 1, messages: [] };
    expect(shouldRequestTitle(session, 'fix the parser')).toBe(false);
    const later = prepareSessionTitle(session, 'fix the parser');
    expect(later.prompt).toBe('fix the parser');
    expect(later.stream).toBeUndefined();
    expect(session.titleAttempts).toBe(1);
  });

  it('leaves a chat that already has a name alone', () => {
    const named = { name: 'Prod Disk Cleanup', titleAttempts: 0, messages: [] };
    expect(prepareSessionTitle(named, 'fix the parser').prompt).toBe('fix the parser');
    expect(shouldRequestTitle(named, 'fix the parser')).toBe(false);
    expect(named.titleAttempts).toBe(0);
  });
});

/** One rule, at the top of the retry loop, instead of five retry sites each
 * remembering. The prompt about to be sent is the whole input. */
describe('the title stream for one attempt', () => {
  it('starts one when the prompt asks, and starts it over on the next attempt', () => {
    const asked = withTitleRequest('clean up the prod disk');
    const first = titleStreamForAttempt(undefined, asked);
    expect(first).toBeDefined();
    first!.push('Looking at the workspace', 'append');
    const second = titleStreamForAttempt(first, asked);
    // Same object, but no longer settled: the new reply's marker gets stripped.
    expect(second).toBe(first);
    expect(second!.push('<clikcode-title>Prod Disk Cleanup</clikcode-title>\nOn it.', 'append')).toBe('On it.');
    expect(second!.title).toBe('Prod Disk Cleanup');
  });

  it('drops the filter when a retry replaces the request', () => {
    const stream = titleStreamForAttempt(undefined, withTitleRequest('clean up the prod disk'));
    stream!.push('Looking at the wor', 'append');
    // What the vendor-CLI failover sends instead: carry on with the thread.
    expect(titleStreamForAttempt(stream, 'Continue the interrupted latest request.')).toBeUndefined();
  });

  it('keeps a title it already found, whatever the next prompt says', () => {
    const stream = titleStreamForAttempt(undefined, withTitleRequest('x'));
    stream!.push('<clikcode-title>Prod Disk Cleanup</clikcode-title>\nOn it.', 'append');
    const next = titleStreamForAttempt(stream, 'Continue: read the background command output.');
    expect(next).toBe(stream);
    expect(next!.title).toBe('Prod Disk Cleanup');
  });

  it('never names from a prompt that never asked', () => {
    expect(titleStreamForAttempt(undefined, 'a plain prompt')).toBeUndefined();
  });
});

describe('a turn that did not ask', () => {
  it('does not filter the reply', () => {
    const named = { name: 'Add mc-brain MCP', titleAttempts: 1, messages: [] };
    const { prompt, stream } = prepareSessionTitle(named, 'does that make sense?');
    expect(prompt).not.toContain(OPEN);
    expect(stream).toBeUndefined();
  });

  it('is asked for once, and the request says so', () => {
    expect(withTitleRequest('fix it')).toMatch(/this reply only/);
  });
});

describe('a reply that is not the title marker', () => {
  const LEAKED = '9973 primality\n\nYes — 9973 is prime (√9973 ≈ 99.9, and no prime up to 97 divides it).';

  it('is left as the model wrote it', () => {
    expect(extractSessionTitle(LEAKED)).toEqual({ text: LEAKED });
    expect(extractSessionTitle('Title: Remembering LANTERN\n\nYou asked me to remember LANTERN.')).toEqual({
      text: 'Title: Remembering LANTERN\n\nYou asked me to remember LANTERN.',
    });
  });

  it('streams an ordinary first line straight through', () => {
    const stream = new StreamingTitle();
    expect(stream.push('9973 primality', 'append')).toBe('9973 primality');
    expect(stream.push('\n\nYes — 9973 is prime.', 'append')).toBe('\n\nYes — 9973 is prime.');
    expect(stream.title).toBeUndefined();
  });
});
