import { describe, expect, it } from 'vitest';
import { terminalCellWidth } from './width';
import { liveConversationLines, rightLabeledRule, runningChatLine } from './waiting';
import { appendThought, liveWaitKind, waitingSpinnerGlyph, withWorkspacePaths } from '../../harness/protocol/activity-view';
import { waitingSpinnerFrame } from '../../harness/protocol/activity-view';
import { visibleTail } from './width';
import { thoughtLabel } from '../../harness/protocol/activity-events';

describe('the waiting band', () => {
  it('packs four animation phases of a logical 4x4 grid into two Braille cells', () => {
    const frames = Array.from({ length: 4 }, (_, frame) => waitingSpinnerFrame(frame));
    expect(new Set(frames.map((frame) => JSON.stringify(frame))).size).toBe(4);
    expect(waitingSpinnerFrame(4)).toEqual(frames[0]);
    expect(frames.every((frame) => frame.flat().length === 16 && frame.flat().filter(Boolean).length === 8)).toBe(true);
    const glyphs = Array.from({ length: 4 }, (_, frame) => waitingSpinnerGlyph(frame));
    expect(new Set(glyphs).size).toBe(4);
    expect(glyphs.every((glyph) => [...glyph].length === 2 && terminalCellWidth(glyph) === 2)).toBe(true);
    expect(runningChatLine('$ npm test', 0, 'command')).toMatch(/ {2}\$ npm test$/);
    expect(runningChatLine('Task(review)', 0, 'agent')).toContain('agent Task(review)');
    expect(runningChatLine('Bash(npm test)', 0, 'command')).not.toBe(runningChatLine('Bash(npm test)', 1, 'command'));
    expect(runningChatLine('Read a.ts', 0, 'tool', 'read')).not.toMatch(/\(\d/);
  });

  it('shows a chat row for a command or a sub-agent and for nothing else', () => {
    expect(liveWaitKind({ kind: 'tool-start', label: 'git status', category: 'run' })).toBe('command');
    expect(liveWaitKind({ kind: 'tool-start', label: 'Task(review the tests)' })).toBe('agent');
    expect(liveWaitKind({ kind: 'tool-start', label: 'followup_task(check the build)' })).toBe('agent');
    expect(liveWaitKind({ kind: 'tool-start', label: 'Task: review the tests', agent: true })).toBe('agent');
    // A shell command whose text is the word "task" is still a command.
    expect(liveWaitKind({ kind: 'tool-start', label: 'task', category: 'run' })).toBe('command');
    expect(liveWaitKind({ kind: 'tool-start', label: 'Read(src/app.ts)', category: 'read' })).toBeUndefined();
    expect(liveWaitKind({ kind: 'tool-done', label: 'git status', category: 'run' })).toBeUndefined();
  });

  it('keeps real live content in the final row on compact mobile viewports', () => {
    expect(liveConversationLines(['user', '', 'streamed response', ''], true)).toEqual([
      'user', '', 'streamed response',
    ]);
    expect(liveConversationLines(['user', '', '· running tool', '', ''], true)).toEqual([
      'user', '', '· running tool',
    ]);
    expect(liveConversationLines(['user', ''], false)).toEqual(['user', '']);
  });

  it('right-aligns usage and title labels without changing the border width', () => {
    expect(rightLabeledRule(40, '5h 88% left · weekly 66% left')).toBe('─'.repeat(10) + ' 5h 88% left · weekly 66% left');
    expect(terminalCellWidth(rightLabeledRule(40, '5h 88% left · weekly 66% left'))).toBe(40);
    expect(rightLabeledRule(30, 'Fix session persistence')).toBe('─'.repeat(6) + ' Fix session persistence');
  });

  it('keeps a visible rule when a label must be truncated', () => {
    const line = rightLabeledRule(12, 'an extremely long title');
    expect(terminalCellWidth(line)).toBe(12);
    expect(line.startsWith('───')).toBe(true);
  });

  it('names the call and leaves the clock to the status line', () => {
    expect(runningChatLine('Bash(make)', 0, 'command', 'run')).not.toMatch(/\(\d/);
  });

  it('accumulates reasoning fragments into one thought instead of replacing it', () => {
    let thought = appendThought(undefined, 'Let');
    for (const fragment of [' me', ' check', ' the', ' tests', '.']) thought = appendThought(thought, fragment);
    expect(thought?.text).toBe('Let me check the tests.');
    // Trimmed fragments still read as words.
    expect(appendThought(appendThought(undefined, 'Reading'), 'files')?.text).toBe('Reading files');
    // A transport that sends the running total replaces it, never doubles it.
    const total = appendThought(appendThought(undefined, 'Plan: read'), 'Plan: read the config');
    expect(total?.text).toBe('Plan: read the config');
    // A new reasoning item starts afresh; the bare placeholder changes nothing.
    const first = appendThought(undefined, 'first idea', 'r1');
    expect(appendThought(first, 'second idea', 'r2')).toEqual({ id: 'r2', text: 'second idea' });
    expect(appendThought(first, 'thinking', 'r1')).toBe(first);
  });

  it('rebuilds a long thought from running totals cut to their newest words', () => {
    // thoughtLabel sends a thought past 240 characters as `…` and its tail.
    // Each event was appended whole, so the row and the expanded reasoning
    // repeated the same sentences over and over.
    const words = Array.from({ length: 120 }, (_, index) => `word${index}`);
    let thought: ReturnType<typeof appendThought>;
    for (let count = 1; count <= words.length; count += 1) thought = appendThought(thought, thoughtLabel(words.slice(0, count).join(' ')), 'r1');
    expect(thought?.text).toBe(words.join(' '));
  });

  it('keeps the newest words of a thought that does not fit', () => {
    expect(visibleTail('short', 10)).toBe('short');
    expect(visibleTail('the start of a long thought and its end', 12)).toBe('…and its end');
    expect(terminalCellWidth(visibleTail('the start of a long thought and its end', 12))).toBeLessThanOrEqual(12);
  });
});

describe('a vendor row\'s paths', () => {
  it('read relative to the chat\'s workspace, as ClikCode\'s own agent writes them', () => {
    const event = { kind: 'tool-start' as const, label: 'Read /home/me/app/src/a.ts', diff: [{ path: '/home/me/app/src/a.ts', lines: [], additions: 0, removals: 0 }] };
    expect(withWorkspacePaths(event, '/home/me/app')).toMatchObject({ label: 'Read src/a.ts', diff: [{ path: 'src/a.ts' }] });
    expect(withWorkspacePaths({ kind: 'tool-start' as const, label: 'Read /etc/hosts' }, '/home/me/app').label).toBe('Read /etc/hosts');
    expect(withWorkspacePaths({ kind: 'tool-start' as const, label: 'Read /home/me/application/x' }, '/home/me/app').label).toBe('Read /home/me/application/x');
  });
});
