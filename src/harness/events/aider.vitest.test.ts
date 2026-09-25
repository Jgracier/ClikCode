import { describe, expect, it } from 'vitest';
import { aiderHistoryReply, aiderLine, aiderStdoutReply } from './aider';
import { createStreamState } from './adapters';

// Real Aider 0.86.2 output for `--message "Reply with only the word ok"`.
const STDOUT = [
  '', 'Aider v0.86.2', 'Main model: openrouter/anthropic/claude-haiku-4.5 with diff edit format, ', 'infinite output',
  'Weak model: openrouter/anthropic/claude-haiku-4-5', 'Git repo: none', 'Repo-map: disabled', '', 'ok', '',
  'Tokens: 2.6k sent, 4 received. Cost: $0.0026 message, $0.0026 session.',
].join('\n');
const HISTORY = [
  '', '# aider chat started at 2026-09-25 07:17:59', '',
  '> /home/u/.local/bin/aider --no-git --message Reply with only the word ok  ', '> Aider v0.86.2  ',
  '> Main model: openrouter/anthropic/claude-haiku-4.5 with diff edit format, infinite output  ', '',
  '#### Reply with only the word ok  ', '', 'ok', '',
  '> Tokens: 2.6k sent, 4 received. Cost: $0.0026 message, $0.0026 session.',
].join('\n');

describe('aider', () => {
  it('streams only the answer, not the banner or the cost footer', () => {
    const state = createStreamState();
    const shown = STDOUT.split('\n').map((line) => aiderLine(line, state).response?.text ?? '').join('');
    expect(shown.trim()).toBe('ok');
    expect(aiderStdoutReply(STDOUT)).toBe('ok');
  });

  it('keeps the model-warning banner out too', () => {
    const warned = ['Warning for openrouter/x: Unknown context window size ', 'and costs, using sane defaults.', 'Did you mean one of these?',
      '- openrouter/anthropic/claude-3-haiku', 'You can skip this check with --no-show-model-warnings', 'https://aider.chat/docs/llms/warnings.html', STDOUT].join('\n');
    expect(aiderStdoutReply(warned)).toBe('ok');
  });

  it('reads the last reply from the chat history file, keeping the model’s own quotes', () => {
    expect(aiderHistoryReply(HISTORY)).toBe('ok');
    const later = `${HISTORY}\n\n#### and now?  \n\nSee below:\n\n> a quoted line from the model\n\nDone.\n\n> Applied edit to x.py  \n> Tokens: 1k sent, 9 received. Cost: $0.001 message, $0.003 session.`;
    expect(aiderHistoryReply(later)).toBe('See below:\n\n> a quoted line from the model\n\nDone.');
    expect(aiderHistoryReply('# aider chat started')).toBeUndefined();
  });
});

describe('session titles from models that drop the tags', () => {
  it('takes a first `Title:` line as the title', async () => {
    const { extractSessionTitle } = await import('../../session/title');
    expect(extractSessionTitle('Title: Remembering LANTERN\n\nYou asked me to remember LANTERN.')).toEqual({ title: 'Remembering LANTERN', text: 'You asked me to remember LANTERN.' });
    expect(extractSessionTitle('**Title:** Build fix\nDone.')).toEqual({ title: 'Build fix', text: 'Done.' });
    expect(extractSessionTitle('The title: of the book is Dune.').title).toBeUndefined();
  });
});
