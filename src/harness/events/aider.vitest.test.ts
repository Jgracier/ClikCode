import { describe, expect, it } from 'vitest';
import { aiderHistoryReply, aiderLine, aiderStdoutReply } from './aider.js';
import { createStreamState } from './adapters.js';

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

  it('keeps a single-model banner, the large-repository notice and a reasoning model’s thoughts out', () => {
    // Real Aider output for a free OpenRouter model inside a 1,900-file repository.
    const stdout = ['Model: openrouter/baidu/ernie-5.5-flash-preview:free with whole edit format', 'Git repo: .git with 1,902 files',
      'Warning: For large repos, consider using --subtree-only and .aiderignore',
      'See: https://aider.chat/docs/faq.html#can-i-use-aider-in-a-large-mono-repo', 'Repo-map: using 4096 tokens, auto refresh',
      '--------------', '► **THINKING**', 'The user asks me to reply with exactly "PONG".', '', '------------', '► **ANSWER**', '', 'PONG', '',
      'Tokens: 2.6k sent, 4 received.'].join('\n');
    expect(aiderStdoutReply(stdout)).toBe('PONG');
    expect(aiderStdoutReply(stdout.replace(/-{14}[^]*ANSWER\*\*\n/, ''))).toBe('PONG');
    // The other spelling of a model's thoughts, in stdout and in the history file.
    const tagged = ['<thinking-content-7bbeb8e1441453ad>', '', 'Just reply PONG.', '', '</thinking-content-7bbeb8e1441453ad>', '', 'PONG'].join('\n');
    expect(aiderStdoutReply(`Model: x with whole edit format\n${tagged}\n\nTokens: 2.6k sent, 4 received.`)).toBe('PONG');
    expect(aiderHistoryReply(`#### Reply with exactly: PONG  \n\n${tagged}\n\n> Tokens: 2.6k sent, 4 received.  `)).toBe('PONG');
  });

  it('reads the last reply from the chat history file, keeping the model’s own quotes', () => {
    expect(aiderHistoryReply(HISTORY)).toBe('ok');
    const later = `${HISTORY}\n\n#### and now?  \n\nSee below:\n\n> a quoted line from the model\n\nDone.\n\n> Applied edit to x.py  \n> Tokens: 1k sent, 9 received. Cost: $0.001 message, $0.003 session.`;
    expect(aiderHistoryReply(later)).toBe('See below:\n\n> a quoted line from the model\n\nDone.');
    expect(aiderHistoryReply('# aider chat started')).toBeUndefined();
  });
});
