import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { nativeThreadHoldsConversation } from './native-thread-continuity.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';

describe('resuming a Claude thread', () => {
  it('keeps a compacted chain and rejects a missing parent or transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-chain-'));
    try {
      const workspace = '/tmp/clikcode-chain-workspace';
      const profile = join(root, 'profile');
      const project = join(profile, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
      await mkdir(project, { recursive: true });
      const account = {
        id: 'a', provider: 'anthropic', authKind: 'vendor-cli', credentialRef: 'native:a',
        nativeProfile: { env: 'CLAUDE_CONFIG_DIR', path: profile },
      } as AiHarnessAccount;
      const session = { id: 's', nativeSessionId: 'thread', workspace } as HarnessSession;
      const harness = localHarnessForCommand('claude')!;
      const file = join(project, 'thread.jsonl');
      const line = (value: Record<string, unknown>) => JSON.stringify(value);
      await writeFile(file, [
        line({ type: 'user', uuid: 'old', parentUuid: null }),
        line({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary', parentUuid: null }),
        line({ type: 'user', uuid: 'summary', parentUuid: 'boundary', isCompactSummary: true }),
        line({ type: 'user', uuid: 'now', parentUuid: 'summary' }),
      ].join('\n'));
      expect(await nativeThreadHoldsConversation(session, harness, account)).toBe(true);
      await appendFile(file, `\n${line({ type: 'assistant', uuid: 'reply', parentUuid: 'now' })}\n`);
      expect(await nativeThreadHoldsConversation(session, harness, account)).toBe(true);
      await appendFile(file, `${line({ type: 'user', uuid: 'broken', parentUuid: 'missing' })}\n`);
      expect(await nativeThreadHoldsConversation(session, harness, account)).toBe(false);
      await writeFile(file, line({ type: 'user', uuid: 'now', parentUuid: 'missing' }));
      expect(await nativeThreadHoldsConversation(session, harness, account)).toBe(false);
      await rm(file);
      expect(await nativeThreadHoldsConversation(session, harness, account)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
