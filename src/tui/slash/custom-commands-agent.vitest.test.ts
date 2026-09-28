import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The bridge loads the bundled router, which a source test has not built; the
// catalog's own functions stand in for it, so Claude's command directories are real.
vi.mock('../../runtime/lazy-bridge.js', async (importOriginal) => {
  const router = await import('@clikcode/router/ai-local-harness');
  return { ...(await importOriginal<object>()), localHarnessForCommand: router.localHarnessForCommand };
});

const { customCommandsFor } = await import('./context.js');
const { customCommandPrompt } = await import('../../session/custom-commands.js');

describe('custom slash commands on ClikCode\'s own agent', () => {
  it('reads Claude Code\'s command directories on the Gateway and Local lanes, and expands them', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'cc-cmds-'));
    await mkdir(path.join(workspace, '.claude', 'commands'), { recursive: true });
    await writeFile(path.join(workspace, '.claude', 'commands', 'probe-review.md'), 'Review $ARGUMENTS carefully.\n');
    for (const route of ['gateway', 'clikcode-local'] as const) {
      const command = customCommandsFor({ id: 's', route, workspace } as never, undefined).find((item) => item.name === 'probe-review');
      expect(command, route).toBeDefined();
      expect(customCommandPrompt(command!, 'src/app.ts', undefined)).toContain('Review src/app.ts carefully.');
    }
  });
});
