import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession } from './model.js';
import { fullRecordNote, fullRecordPath, writeFullRecord } from './full-record.js';

const now = '2026-10-21T00:00:00.000Z';
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

const chat = (turns: number): HarnessSession => ({
  id: 'conv-1', route: 'local', accountId: null, provider: 'anthropic', model: 'opus', nativeHarness: 'claude', effort: 'high',
  createdAt: now, updatedAt: now, status: 'active', workspace: '/w', name: 'Long chat',
  messages: Array.from({ length: turns }, (_, index) => [
    { role: 'user' as const, content: `request number ${index + 1}` },
    { role: 'assistant' as const, content: `answer number ${index + 1}` },
  ]).flat(),
});

describe('the file that holds a whole conversation', () => {
  it('has every request and answer, however long the chat, readable by any provider', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-record-'));
    const path = await writeFullRecord(chat(300), dir);
    expect(path).toBe(fullRecordPath(dir, 'conv-1'));
    const text = await readFile(path!, 'utf8');
    for (const index of [1, 150, 300]) {
      expect(text).toContain(`request number ${index}`);
      expect(text).toContain(`answer number ${index}`);
    }
    expect((await stat(path!)).mode & 0o077).toBe(0);
  });

  it('is rewritten at the next handoff, not appended to', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-record-'));
    await writeFullRecord(chat(3), dir);
    await writeFullRecord(chat(5), dir);
    const text = await readFile(fullRecordPath(dir, 'conv-1'), 'utf8');
    expect(text.match(/request number 1\b/g)).toHaveLength(1);
    expect(text).toContain('request number 5');
  });

  it('is undefined, not an error, where it cannot be written', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-record-'));
    await writeFile(join(dir, 'a-file'), 'x');
    // A directory cannot be made inside a file.
    expect(await writeFullRecord(chat(1), join(dir, 'a-file', 'state'))).toBeUndefined();
  });

  it('is named in a line that points at the file, not at a tool', () => {
    expect(fullRecordNote('/state/records/x.md')).toContain('/state/records/x.md');
    expect(fullRecordNote('/state/records/x.md')).not.toMatch(/search_conversations|read_conversation/);
  });
});
