/** The conversation tools over stdio MCP, from the built CLI, as a vendor
 * starts them. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { HarnessSession } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { workerSessionFromArgv } from './mcp.js';

function chat(id: string, name: string, content: string): HarnessSession {
  const at = new Date().toISOString();
  return {
    id, route: 'local', accountId: null, provider: 'openai', model: 'gpt-5', effort: 'medium', permissionMode: 'ask',
    accountFailover: 'never', createdAt: at, updatedAt: at, status: 'active', nativeHarness: 'codex', name,
    messages: [{ role: 'user', content }, { role: 'assistant', content: 'noted' }],
  } as HarnessSession;
}

type Answer = { id?: number; result?: Record<string, unknown> & { content?: Array<{ text: string }>; tools?: Array<{ name: string }> }; error?: { message: string } };

/** Reads answers in either framing, by id. */
function reader(child: ChildProcessWithoutNullStreams): { next(id: number): Promise<Answer>; raw: () => string } {
  let text = '';
  const answers = new Map<number, Answer>();
  const waiting = new Map<number, (answer: Answer) => void>();
  child.stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
    for (;;) {
      const framed = /^Content-Length:\s*(\d+)\r\n\r\n/i.exec(text);
      let body: string | undefined;
      if (framed) {
        const length = Number(framed[1]);
        if (Buffer.byteLength(text) < framed[0].length + length) return;
        body = text.slice(framed[0].length, framed[0].length + length);
        text = text.slice(framed[0].length + length);
      } else {
        const end = text.indexOf('\n');
        if (end < 0) return;
        body = text.slice(0, end);
        text = text.slice(end + 1);
      }
      const answer = JSON.parse(body) as Answer;
      if (answer.id === undefined) continue;
      const waiter = waiting.get(answer.id);
      if (waiter) waiter(answer); else answers.set(answer.id, answer);
    }
  });
  return {
    next: (id) => new Promise((resolve, reject) => {
      const ready = answers.get(id);
      if (ready) return resolve(ready);
      const timer = setTimeout(() => reject(new Error(`no answer to ${id}`)), 10_000);
      waiting.set(id, (answer) => { clearTimeout(timer); resolve(answer); });
    }),
    raw: () => text,
  };
}

describe('clikcode conversations-mcp', () => {
  it('lists the three tools and answers calls over newline JSON and Content-Length frames', async () => {
    const state = await readState();
    state.sessions.push(chat('other-0001-aaaa', 'Webhook retries', 'the webhook retry storm'), chat('current-0002-bbbb', 'Mine', 'webhook retry storm here too'));
    await writeState(state);
    const child = spawn(process.execPath, ['dist/index.js', 'conversations-mcp'], {
      cwd: process.cwd(), env: { ...process.env, CLIKCODE_SESSION_ID: 'current-0002-bbbb' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const answers = reader(child);
      const send = (id: number, method: string, params?: unknown): void => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`); };
      send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      const init = await answers.next(1);
      expect(init.result?.protocolVersion).toBe('2025-06-18');
      expect(String(init.result?.instructions)).toContain('search_conversations');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      send(2, 'tools/list');
      expect((await answers.next(2)).result?.tools?.map((tool) => tool.name)).toEqual(['search_conversations', 'read_conversation', 'active_conversations']);
      send(3, 'tools/call', { name: 'search_conversations', arguments: { query: 'webhook retry storm' } });
      const found = (await answers.next(3)).result!.content![0]!.text;
      expect(found).toContain('Webhook retries — id other-00');
      expect(found).not.toContain('Mine —');
      send(4, 'tools/call', { name: 'read_conversation', arguments: { id: 'other-0001-aaaa', at: '0' } });
      expect((await answers.next(4)).result!.content![0]!.text).toContain('[#0 user] the webhook retry storm');
      send(5, 'tools/call', { name: 'nope', arguments: {} });
      expect((await answers.next(5)).error?.message).toContain('Unknown tool');
      // A client that frames its messages is answered framed.
      const body = JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'active_conversations', arguments: {} } });
      const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      child.stdin.write(frame.slice(0, 7));
      child.stdin.write(frame.slice(7));
      expect((await answers.next(6)).result!.content![0]!.text).toContain('Webhook retries');
    } finally {
      child.kill();
    }
  }, 20_000);

  it('finds the conversation from a worker argv', () => {
    expect(workerSessionFromArgv(['/usr/bin/node', '/x/clikcode', 'session-worker', 'abc-123'])).toBe('abc-123');
    expect(workerSessionFromArgv(['/usr/bin/node', '/x/clikcode', 'chat'])).toBeUndefined();
  });
});
