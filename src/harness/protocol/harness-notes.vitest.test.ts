import { describe, expect, it } from 'vitest';
import { activityOutput, withoutHarnessNotes } from './activity-events.js';

describe('what a harness appends to a command\'s output', () => {
  it('drops Claude Code\'s cwd notice, which the command never printed', () => {
    expect(activityOutput('Tests  2197 passed\nShell cwd was reset to /home/me/projects', { tail: true }).output).toEqual(['Tests  2197 passed']);
    expect(activityOutput('Shell cwd was reset to /home/me/projects\n', { tail: true })).toEqual({});
  });

  it('keeps the same words when the command itself printed them mid-output', () => {
    const text = 'echo says: Shell cwd was reset to x\nand more';
    expect(withoutHarnessNotes(text)).toBe(text);
  });
});
