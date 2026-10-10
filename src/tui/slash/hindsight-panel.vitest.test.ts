import { describe, expect, it } from 'vitest';
import { hindsightPanelText, promptNumberedMessages } from './hindsight-panel.js';
import { INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt.js';
import { resolveSlashCommand } from './registry.js';

const user = (content: string) => ({ role: 'user' as const, content });
const answer = (content: string) => ({ role: 'assistant' as const, content });

describe('/hindsight', () => {
  it('is a registry command', () => {
    expect(resolveSlashCommand('hindsight')?.handlerKey).toBe('hindsight');
  });

  it('numbers topics by prompt, as /fork @N and /redo @N take them, newest first with their files', () => {
    const messages = [
      user('Fix the quota reprint in the footer'), answer('Fixed.'),
      user('ok do it'), answer('Done.'),
      // Not the user's: ClikCode's own continuation is not counted.
      user(INTERRUPTED_TURN_REQUEST), answer('Carried on.'),
      user('Add a search command for conversations'), answer('Added.'),
    ];
    expect(promptNumberedMessages(messages).filter((message) => message.role === 'user').map((message) => message.index)).toEqual([1, 2, 3]);
    const now = Date.parse('2026-10-10T12:00:00Z');
    const text = hindsightPanelText(messages, [
      { at: '2026-10-10T10:00:00Z', prompt: 'Fix the quota reprint in the footer', changes: [{ path: 'src/footer.ts', additions: 3, removals: 1, lines: [] } as never] },
      { at: '2026-10-10T11:30:00Z', prompt: 'Add a search command for conversations', changes: [{ path: 'src/search.ts', additions: 9, removals: 0, lines: [] } as never] },
    ], { originFallback: 'grok', now });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Hindsight · 2 topics, newest first');
    // Newest first: prompt 3, then prompts 1-2.
    expect(text.indexOf('Add a search command')).toBeLessThan(text.indexOf('Fix the quota reprint'));
    expect(text).toMatch(/\n\s+3 {2}answered · 30m ago · grok\n\s+Add a search command for conversations\n\s+files: src\/search\.ts \+9 -0/);
    expect(text).toMatch(/\n\s+1–2 {2}answered · 2h ago · grok\n\s+Fix the quota reprint in the footer {2}\(\+1 more\)\n\s+files: src\/footer\.ts \+3 -1/);
    expect(lines.at(-1)).toContain('/fork @N');
    expect(lines.at(-1)).toContain('/redo @N');
  });

  it('says when there is nothing yet', () => {
    expect(hindsightPanelText([], [], { originFallback: 'grok' })).toBe('Hindsight\nNo prompts in this conversation yet.');
  });
});
