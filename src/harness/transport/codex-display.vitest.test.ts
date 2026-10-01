/** What a Codex turn shows beyond its text: tool results, web actions,
 * declined calls, warnings, retry reasons, a patch as it is made. Shapes
 * from codex 0.155.1's app-server v2 schema. */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { codexActivityForItem, createCodexSession } from './codex-app-server.js';
import type { HarnessActivityEvent } from '../prompter.js';

describe('Codex items', () => {
  it('shows what an MCP call returned, and why one failed', () => {
    expect(codexActivityForItem({ type: 'mcpToolCall', id: 'm', server: 'docs', tool: 'search', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'Found 3 pages' }] } }, true))
      .toMatchObject({ kind: 'tool-done', output: ['Found 3 pages'] });
    expect(codexActivityForItem({ type: 'mcpToolCall', id: 'm', server: 'docs', tool: 'search', arguments: {}, status: 'failed', error: { message: 'server not reachable' } }, true))
      .toMatchObject({ kind: 'tool-error', output: ['server not reachable'] });
    expect(codexActivityForItem({ type: 'dynamicToolCall', id: 'd', tool: 'lookup', success: false, contentItems: [{ type: 'inputText', text: 'no such key' }] }, true))
      .toMatchObject({ kind: 'tool-error', output: ['no such key'] });
  });

  it('names what a web search did', () => {
    const label = (action: Record<string, unknown>) => codexActivityForItem({ type: 'webSearch', id: 'w', query: '', action }, true)!.label;
    expect(label({ type: 'search', query: 'acp spec' })).toMatch(/acp spec/);
    expect(label({ type: 'openPage', url: 'https://example.com/a' })).toMatch(/https:\/\/example\.com\/a/);
    expect(label({ type: 'findInPage', url: 'https://example.com/a', pattern: 'usage' })).toMatch(/"usage" in https:\/\/example\.com\/a/);
  });

  it('reads a declined command as declined, not done', () => {
    expect(codexActivityForItem({ type: 'commandExecution', id: 'c', command: 'rm -rf build', status: 'declined' }, true))
      .toMatchObject({ kind: 'tool-error', output: ['declined'], category: 'run' });
  });
});

it("says Codex's warnings and why it retries, and refreshes an edit's patch while it is made", async () => {
  const send = (method: string, params: Record<string, unknown>) => ({ method, params: { threadId: 'T', turnId: '{{turn}}', ...params } });
  const steps = [
    send('warning', { message: 'model_reasoning_effort is not supported by this model' }),
    send('error', { error: { message: 'stream disconnected before completion' }, willRetry: true }),
    send('item/started', { item: { type: 'fileChange', id: 'f', status: 'inProgress', changes: [] } }),
    send('item/fileChange/patchUpdated', { itemId: 'f', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] }),
    send('item/completed', { item: { type: 'agentMessage', id: 'm', text: 'Done.' } }),
    { method: 'turn/completed', params: { threadId: 'T', turn: { id: '{{turn}}', status: 'completed' } } },
  ];
  const server = `
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    const steps = ${JSON.stringify(steps)};
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: {} });
      else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'T' } } });
      else if (m.method === 'turn/start') { send({ id: m.id, result: { turn: { id: 'U1' } } }); for (const s of steps) send(JSON.parse(JSON.stringify(s).split('{{turn}}').join('U1'))); }
    } });
  `;
  const codex = createCodexSession({ spawn: (_binary, _argv, options) => spawn(process.execPath, ['-e', server], options) });
  const notices: string[] = [];
  const phases: string[] = [];
  const activity: HarnessActivityEvent[] = [];
  try {
    await codex.runTurn({
      binary: 'codex', prompt: 'go', cwd: process.cwd(), permissionMode: 'ask',
      onNotice: (message) => notices.push(message), onPhase: (phase) => phases.push(phase), onActivity: (event) => activity.push(event),
    });
  } finally { await codex.close(); }
  expect(notices).toContain('Codex: model_reasoning_effort is not supported by this model');
  expect(phases).toContain('retrying: stream disconnected before completion');
  const patched = activity.find((event) => event.id === 'f' && event.diff);
  expect(patched).toMatchObject({ kind: 'tool-start', diff: [{ path: 'a.ts', change: 'update', additions: 1, removals: 1 }] });
});
