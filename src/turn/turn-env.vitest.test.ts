import { describe, expect, it } from 'vitest';
import { turnEnvironment } from './turn-environment.js';

describe('a harness turn\'s environment', () => {
  it('carries the catalog\'s turnEnv on a turn, not on a management command', () => {
    const harness = { command: 'claude', turnEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } } as never;
    expect(turnEnvironment(harness, undefined, 'ask')).toMatchObject({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
    expect(turnEnvironment(harness, undefined)).not.toHaveProperty('CLAUDE_CODE_ENABLE_TODO_TOOLS');
  });

  it('is switched on for Claude Code in the catalog', async () => {
    const { AI_LOCAL_HARNESSES } = await import('../../packages/clikrouter/src/ai-local-harness.js');
    expect(AI_LOCAL_HARNESSES.find((h) => h.command === 'claude')?.turnEnv).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
  });
});
