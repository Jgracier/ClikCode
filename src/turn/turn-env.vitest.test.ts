import { describe, expect, it } from 'vitest';
import { turnEnvironment } from './turn-environment.js';

describe('a harness turn\'s environment', () => {
  it('carries the catalog\'s turnEnv on a turn, not on a management command', () => {
    const harness = { command: 'claude', turnEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } } as never;
    expect(turnEnvironment(harness, undefined, 'ask')).toMatchObject({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
    expect(turnEnvironment(harness, undefined)).not.toHaveProperty('CLAUDE_CODE_ENABLE_TODO_TOOLS');
  });

  it("tells the ClikDeploy tools a turn reaches the session's mode, on every vendor, and nothing on a management command", () => {
    const harness = { command: 'opencode' } as never;
    for (const mode of ['ask', 'auto', 'bypass'] as const) expect(turnEnvironment(harness, undefined, mode)).toMatchObject({ CLIKDEPLOY_PERMISSION_MODE: mode });
    expect(turnEnvironment(harness, undefined)).not.toHaveProperty('CLIKDEPLOY_PERMISSION_MODE');
  });

  it('is switched on for Claude Code in the catalog', async () => {
    const { AI_LOCAL_HARNESSES } = await import('../../packages/clikrouter/src/ai-local-harness.js');
    expect(AI_LOCAL_HARNESSES.find((h) => h.command === 'claude')?.turnEnv).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
  });

  it('runs Cline\'s session in its own process, never in a hub daemon that outlives the chat', async () => {
    const { AI_LOCAL_HARNESSES } = await import('../../packages/clikrouter/src/ai-local-harness.js');
    const cline = AI_LOCAL_HARNESSES.find((h) => h.command === 'cline')!;
    expect(turnEnvironment(cline as never, undefined, 'ask')).toMatchObject({ CLINE_SESSION_BACKEND_MODE: 'local' });
  });
});
