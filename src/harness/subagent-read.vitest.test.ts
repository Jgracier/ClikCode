import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeTranscriptRows, findClaudeSubagent, liveSubAgentRows, readClaudeSubagent } from './subagent-read.js';

const line = (value: unknown): string => JSON.stringify(value);
const transcript = [
  line({ type: 'user', isSidechain: true, agentId: 'aa1', message: { role: 'user', content: 'Find the parser' } }),
  line({ type: 'attachment', attachment: { type: 'x' } }),
  line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'Plan: grep first' }, { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'parse' } }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.ts:1\nb.ts:2' }] }] } }),
  'not json',
  line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Found it in a.ts.' }] } }),
].join('\n');

describe('claudeTranscriptRows', () => {
  it('reads prompt, thought, call with its result, and prose in order', () => {
    const rows = claudeTranscriptRows(transcript);
    expect(rows.map((row) => row.kind)).toEqual(['prompt', 'activity', 'activity', 'text']);
    expect(rows[0]).toEqual({ kind: 'prompt', text: 'Find the parser' });
    const call = rows[2] as { kind: 'activity'; event: { kind: string; label: string; output?: string[] } };
    expect(call.event.kind).toBe('tool-done');
    expect(call.event.label).toMatch(/^Grep|parse/);
    expect(call.event.output).toEqual(['a.ts:1', 'b.ts:2']);
    expect(rows[3]).toEqual({ kind: 'text', text: 'Found it in a.ts.' });
  });
  it('leaves a call without a result running', () => {
    const rows = claudeTranscriptRows(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }] } }));
    expect((rows[0] as { event: { kind: string } }).event.kind).toBe('tool-start');
  });
});

describe('findClaudeSubagent', () => {
  it('finds the transcript by the sidecar toolUseId, under any of the project folder names', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'cc-sub-'));
    const dir = join(profile, 'projects', '-w-proj', 'sess1', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-aa1.meta.json'), JSON.stringify({ agentType: 'explore', description: 'Find the parser', toolUseId: 'toolu_1' }));
    writeFileSync(join(dir, 'agent-aa1.jsonl'), transcript);
    writeFileSync(join(dir, 'agent-bb2.meta.json'), JSON.stringify({ toolUseId: 'toolu_2' }));
    expect(await findClaudeSubagent('/w/proj', 'sess1', 'toolu_1', profile)).toMatchObject({ agentId: 'aa1', agentType: 'explore' });
    expect(await findClaudeSubagent('/w/proj', 'sess1', 'toolu_x', profile)).toBeUndefined();
    expect((await readClaudeSubagent('/w/proj', 'sess1', 'toolu_1', profile))?.rows.length).toBe(4);
  });
});

describe('liveSubAgentRows', () => {
  it('keeps only the frames of that parent and merges a call with its result', () => {
    const rows = liveSubAgentRows([
      { kind: 'tool-start', label: '$ ls', id: 'c1', parentId: 'p' },
      { kind: 'tool-start', label: '$ pwd', id: 'c2', parentId: 'other' },
      { kind: 'tool-done', label: 'tool', id: 'c1', parentId: 'p', output: ['x'] },
    ], 'p');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { event: { kind: string } }).event.kind).toBe('tool-done');
  });
});
