/** A Gateway turn refused for the account's sake ends the way a vendor's does: out of usage is
 * "All accounts exhausted" (which offers Resume in), a 429 that says when to come back is a
 * throttle, and a refused sign-in signs in and asks again once. A real turn against a real
 * OpenAI-compatible HTTP server standing in for the Gateway; only the sign-in's browser half and
 * the Gateway's model facts are stubbed. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../session/model.js';
import { agentTurnFailureKind } from './failover.js';

const gateway = vi.hoisted(() => ({ url: '', key: 'stale', logins: 0 }));
vi.mock('../agent/models/for-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/models/for-session.js')>();
  return {
    ...actual,
    gatewayConnection: () => ({ baseUrl: gateway.url, apiKey: gateway.key }),
    modelClientForSession: async (session: HarnessSession) => actual.gatewayModelClient({ baseUrl: gateway.url, apiKey: gateway.key, sessionId: session.id, contextWindow: 32768 }),
  };
});
vi.mock('../gateway/mcp.js', () => ({ routeMcpServers: () => [] }));
vi.mock('../commands/gateway.js', () => ({
  gatewayLogin: async (_config: unknown, _options: unknown, deps: { openBrowser?: (url: string) => void }) => {
    gateway.logins += 1;
    deps.openBrowser?.('https://gw.test/device');
    gateway.key = 'fresh';
    return { email: 'me@test' };
  },
}));

const { runSessionTurn } = await import('./session-turn.js');
const { readState } = await import('../session/state/read.js');
const { writeState } = await import('../session/state/write.js');
const { ConversationStore } = await import('../agent/conversation.js');
const { stateDirectory } = await import('../session/store/paths.js');

const config = { get: () => undefined } as never;
type Reply = { status: number; headers?: Record<string, string>; body?: unknown };

describe('a Gateway turn refused for the account', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let home: string;
  let server: Server;
  let replies: Array<(auth: string) => Reply | 'answer'>;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-agent-account-'));
    process.env.CLIKCODE_HOME = home;
    gateway.key = 'stale';
    gateway.logins = 0;
    replies = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        const reply = (replies.shift() ?? (() => 'answer' as const))(String(req.headers.authorization ?? ''));
        if (reply === 'answer') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answered' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        res.end(JSON.stringify(reply.body ?? { error: { message: 'refused' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    gateway.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const state = await readState();
    state.sessions.push({
      id: 's1', conversationId: 's1', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'auto',
      permissionMode: 'auto', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'active', workspace: home, title: 'named', name: 'named', nameSource: 'user',
    } as HarnessSession);
    await writeState(state);
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
    else process.env.CLIKCODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const prompter = () => {
    const activity: string[] = [];
    return {
      activity,
      observer: new Proxy({ activity: (line: string) => { activity.push(line); } } as Record<string, unknown>, {
        get: (target, key) => target[key as string] ?? (() => undefined),
      }) as never,
    };
  };

  it('out of credit is "All accounts exhausted", with the Gateway\'s own words on the turn', async () => {
    replies.push(() => ({ status: 402, body: { error: { message: 'Insufficient credits', code: 'insufficient_credits' } } }));
    const watching = prompter();
    await expect(runSessionTurn(config, 's1', 'go', undefined, { prompter: watching.observer })).rejects.toThrow(/^All accounts exhausted$/);
    expect(watching.activity.join('\n')).toContain('Insufficient credits');
  }, 30_000);

  it('a 429 without a time to come back is out of usage; with one it is a throttle', async () => {
    replies.push(() => ({ status: 429 }));
    await expect(runSessionTurn(config, 's1', 'go', undefined, {})).rejects.toThrow(/^All accounts exhausted$/);
    replies.push(() => ({ status: 429, headers: { 'retry-after': '30' } }));
    await expect(runSessionTurn(config, 's1', 'go', undefined, {})).rejects.toThrow(/HTTP 429/);
  }, 30_000);

  it('a refused sign-in signs in, then asks again once, with the request in memory once', async () => {
    replies.push((auth) => (auth === 'Bearer fresh' ? 'answer' : { status: 401, body: { error: { message: 'Invalid API key', code: 'invalid_api_key' } } }));
    const watching = prompter();
    await runSessionTurn(config, 's1', 'go', undefined, { prompter: watching.observer });
    expect(gateway.logins).toBe(1);
    expect(watching.activity.join('\n')).toContain('https://gw.test/device');
    const session = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(session.messages?.at(-1)?.content).toBe('answered');
    const memory = readFileSync(new ConversationStore(stateDirectory(), 's1').file, 'utf8');
    expect(memory.split('\n').filter((line) => line.includes('"role":"user"')).length).toBe(1);
  }, 30_000);
});

describe('agentTurnFailureKind', () => {
  it('reads the Gateway\'s status the way a vendor refusal is read', () => {
    expect(agentTurnFailureKind({ text: 'HTTP 402', statusCode: 402 })).toBe('quota-exhausted');
    expect(agentTurnFailureKind({ text: 'HTTP 429', statusCode: 429 })).toBe('quota-exhausted');
    expect(agentTurnFailureKind({ text: 'HTTP 429', statusCode: 429, retryAfter: 30 })).toBe('temporarily-throttled');
    expect(agentTurnFailureKind({ text: 'HTTP 401', statusCode: 401 })).toBe('authentication-required');
    expect(agentTurnFailureKind({ text: 'HTTP 403: ClikDeploy Gateway is turned off (gateway_disabled)', statusCode: 403 })).toBe('other');
    expect(agentTurnFailureKind({ text: 'HTTP 500', statusCode: 500 })).toBe('other');
    expect(agentTurnFailureKind({ text: 'socket hang up' })).toBe('other');
  });
});
