import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { carryBlockedSubagent, locateAgentTranscript } from './subagent-recovery.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import type { EndedWork } from '../harness/transport/handoff-work.js';

const account = (id: string, path: string): AiHarnessAccount => ({ id, provider: 'anthropic', label: id, authKind: 'vendor-cli', status: 'ready', models: [], nativeProfile: { env: 'CLAUDE_CONFIG_DIR', path } });

describe('a blocked subagent moving to the available account', () => {
  it('refreshes only its transcript and identity, preserving other agents on both accounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-child-carry-'));
    try {
      const source = account('a', join(root, 'a')); const target = account('b', join(root, 'b'));
      const project = '-repo';
      const from = join(source.nativeProfile!.path, 'projects', project, 'thread', 'subagents');
      const to = join(target.nativeProfile!.path, 'projects', project, 'thread', 'subagents');
      await mkdir(from, { recursive: true }); await mkdir(to, { recursive: true });
      await writeFile(join(source.nativeProfile!.path, 'projects', project, 'thread.jsonl'), '{}\n');
      await writeFile(join(from, 'agent-child.jsonl'), '{"progress":"migration done, verification pending"}\n');
      await writeFile(join(from, 'agent-child.meta.json'), '{"toolUseId":"launch"}');
      await writeFile(join(to, 'agent-child.jsonl'), '{}');
      await writeFile(join(to, 'agent-healthy.jsonl'), 'still running');
      const session = { nativeHarness: 'claude', nativeSessionId: 'thread', workspace: '/repo' } as HarnessSession;
      const work = { id: 'child', kind: 'agent', label: 'Migration', outcome: 'cut-off', tail: '', nativeSessionId: 'thread' } as EndedWork;
      expect(await carryBlockedSubagent(work, session, source, target)).toBe(true);
      expect(await readFile(join(to, 'agent-child.jsonl'), 'utf8')).toContain('verification pending');
      expect(await readFile(join(to, 'agent-child.meta.json'), 'utf8')).toContain('launch');
      expect(await readFile(join(to, 'agent-healthy.jsonl'), 'utf8')).toBe('still running');
      expect(await readFile(join(from, 'agent-child.jsonl'), 'utf8')).toContain('migration done');
      expect(await carryBlockedSubagent({ ...work, id: '../escape' }, session, source, target)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('an agent whose process ended on the same account', () => {
  it('is resumed natively when Claude kept its history, and started again from its replay when not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-same-account-'));
    try {
      const one = account('a', join(root, 'a'));
      const dir = join(one.nativeProfile!.path, 'projects', '-repo', 'thread', 'subagents');
      await mkdir(dir, { recursive: true });
      await writeFile(join(one.nativeProfile!.path, 'projects', '-repo', 'thread.jsonl'), '{}\n');
      await writeFile(join(dir, 'agent-child.jsonl'), '{}\n');
      const session = { nativeHarness: 'claude', nativeSessionId: 'thread', workspace: '/repo' } as HarnessSession;
      const work = { id: 'child', kind: 'agent', label: 'Migration', outcome: 'cut-off', tail: '' } as EndedWork;
      expect(await carryBlockedSubagent(work, session, one, one)).toBe(true);
      expect(await locateAgentTranscript(work, session, one)).toBe(join(dir, 'agent-child.jsonl'));
      expect(await carryBlockedSubagent({ ...work, id: 'unknown' }, session, one, one)).toBe(false);
      expect(await locateAgentTranscript({ id: '../x' }, session, one)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
