import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { synchronizeNativeTranscript } from './handoff.js';

describe('reopening a vendor thread after an interrupted turn', () => {
  it('keeps journaled subagent work when the native transcript contains only the answer text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-handoff-checkpoint-'));
    try {
      const workspace = join(root, 'work');
      const config = join(root, 'claude');
      const project = workspace.replace(/[^a-zA-Z0-9]/g, '-');
      const directory = join(config, 'projects', project);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'thread.jsonl'), [
        { type: 'user', message: { content: [{ type: 'text', text: 'inspect' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial finding' }] } },
      ].map((line) => JSON.stringify(line)).join('\n'));
      const now = new Date().toISOString();
      const session = {
        id: 'chat', route: 'local', provider: 'anthropic', accountId: 'account', nativeHarness: 'claude',
        nativeSessionId: 'thread', workspace, model: 'opus', effort: 'medium', permissionMode: 'ask',
        createdAt: now, updatedAt: now, status: 'active',
        pendingTurn: { prompt: 'inspect', response: 'Partial finding', startedAt: now, updatedAt: now, outputStarted: true,
          activities: [
            { responseOffset: 0, event: { kind: 'tool-start', label: 'Agent(inspect)', id: 'agent' } },
            { responseOffset: 0, event: { kind: 'tool-done', label: 'Read(a.ts)', id: 'child', parentId: 'agent', output: ['found clue'] } },
          ],
        },
      } as HarnessSession;
      const state = { accounts: [{ id: 'account', nativeProfile: { env: 'CLAUDE_CONFIG_DIR', path: config } }] } as HarnessState;
      expect(await synchronizeNativeTranscript(state, session)).toBe(true);
      expect(session.pendingTurn).toBeUndefined();
      expect(session.messages?.at(-1)?.activities?.map((activity) => activity.event.label)).toEqual(['Agent(inspect)', 'Read(a.ts)']);
      expect(session.messages?.at(-1)?.activities?.[1]?.event.output).toEqual(['found clue']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
