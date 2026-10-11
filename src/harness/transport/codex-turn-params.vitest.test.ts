/** A permission change is the next turn's parameters, not a new app-server; /compact is the vendor's. */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createCodexSession } from './codex-app-server.js';

const SERVER = `
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
  let buf = ''; let n = 0;
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: {} });
    else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'T' } } });
    else if (m.method === 'model/list') send({ id: m.id, result: { data: [{ id: 'gpt-x', model: 'gpt-x', displayName: 'GPT X', supportedReasoningEfforts: [] }], nextCursor: null } });
    else if (m.method === 'thread/compact/start') { send({ id: m.id, result: {} }); send({ method: 'thread/compacted', params: { threadId: 'T', turnId: 'C' } }); }
    else if (m.method === 'turn/start') {
      const turn = 'U' + (++n);
      send({ id: m.id, result: { turn: { id: turn } } });
      send({ method: 'item/completed', params: { threadId: 'T', turnId: turn, item: { type: 'agentMessage', id: 'm' + n, text: JSON.stringify(m.params) } } });
      send({ method: 'turn/completed', params: { threadId: 'T', turn: { id: turn, status: 'completed' } } });
    }
  } });
`;

describe('Codex per-turn parameters and native compaction', () => {
  it('sends the permission mode with each turn and keeps one server across a change', async () => {
    let spawns = 0;
    const models: unknown[] = [];
    const codex = createCodexSession({ spawn: (_b, _a, o) => { spawns += 1; return spawn(process.execPath, ['-e', SERVER], o); } });
    const base = { binary: 'codex', prompt: 'go', cwd: process.cwd(), onSessionModels: (answer: unknown) => { models.push(answer); } };
    try {
      const first = JSON.parse((await codex.runTurn({ ...base, permissionMode: 'ask' as const, effort: 'high' })).text);
      const second = JSON.parse((await codex.runTurn({ ...base, permissionMode: 'bypass' as const })).text);
      expect(spawns).toBe(1);
      expect(first).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' }, effort: 'high' });
      expect(second).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(models).toEqual([{ models: { availableModels: [{ modelId: 'gpt-x', name: 'GPT X' }] } }]);
      expect(await codex.compactThread('T')).toBe(true);
      expect(await codex.compactThread('other')).toBe(false);
    } finally {
      await codex.close();
    }
  });
});
