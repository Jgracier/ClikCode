/** Plan mode on ClikCode's own agent: Settings (and the editor's footer) set it on the chat, the
 * turn runs research-only under it, and approving the plan the agent proposes (exit_plan_mode)
 * turns it off. A real turn against a real OpenAI-compatible HTTP server standing in for the
 * model. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../session/model.js';

const engine = vi.hoisted(() => ({ ensureLocalModel: vi.fn() }));
vi.mock('../local-models/index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../local-models/index')>(),
  ensureLocalModel: engine.ensureLocalModel,
  releaseLocalModelsOnExit: () => undefined,
}));

const { runSessionTurn } = await import('./session-turn.js');
const { readState } = await import('../session/state/read.js');
const { writeState } = await import('../session/state/write.js');
const { setAgentPlanMode } = await import('../agent/plan-mode-setting.js');
const { chatSettings } = await import('../ide/queries.js');

const config = { get: () => undefined } as never;

describe('plan mode on ClikCode\'s own agent', () => {
  const previousHome = process.env.CLIKCODE_HOME;
  let home: string;
  let server: Server;
  let asked: Array<{ tools: string[]; system: string }>;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-agent-plan-'));
    process.env.CLIKCODE_HOME = home;
    asked = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> };
        const tools = (body.tools ?? []).map((tool) => tool.function.name);
        asked.push({ tools, system: JSON.stringify(body.messages.filter((message) => message.role === 'system')) });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (asked.length === 1 && tools.includes('exit_plan_mode')) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'p1', type: 'function', function: { name: 'exit_plan_mode', arguments: '{"plan":"1. edit the file"}' } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    engine.ensureLocalModel.mockResolvedValue({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', contextWindow: 32768 });
    const state = await readState();
    state.sessions.push({
      id: 's1', conversationId: 's1', route: 'clikcode-local', accountId: null, provider: 'clikcode-local', model: 'test-model', effort: 'auto',
      permissionMode: 'ask', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
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

  const approving = () => {
    const approvals: string[] = [];
    const observer = new Proxy({ approval: async (title: string) => { approvals.push(title); return true; } } as Record<string, unknown>, {
      get: (target, key) => target[key as string] ?? (() => undefined),
    }) as never;
    return { approvals, observer };
  };
  const stored = async (): Promise<HarnessSession> => (await readState()).sessions.find((item) => item.id === 's1')!;

  it('is a switch on the chat that the editor\'s footer shows', async () => {
    const state = await readState();
    expect((await chatSettings(state, await stored())).plan).toBe(false);
    await setAgentPlanMode('s1', true);
    expect((await stored()).planMode).toBe(true);
    expect((await chatSettings(await readState(), await stored())).plan).toBe(true);
    await setAgentPlanMode('s1', false);
    expect((await stored()).planMode).toBeUndefined();
  });

  it('runs the turn research-only, and approving the plan turns it off', async () => {
    await setAgentPlanMode('s1', true);
    const user = approving();
    await runSessionTurn(config, 's1', 'plan the change', undefined, { prompter: user.observer });
    expect(asked[0]!.tools).toContain('exit_plan_mode');
    expect(asked[0]!.tools).not.toContain('bash');
    expect(asked[0]!.tools).not.toContain('write_file');
    expect(user.approvals).toEqual(['Approve plan']);
    expect((await stored()).planMode).toBeUndefined();
    // The next request of the same turn, after approval, may change things.
    expect(asked[1]!.tools).toContain('bash');
  }, 30_000);

  it('leaves the tools alone when it is off', async () => {
    await runSessionTurn(config, 's1', 'go', undefined, { prompter: approving().observer });
    expect(asked[0]!.tools).toContain('bash');
    expect(asked[0]!.tools).not.toContain('exit_plan_mode');
  }, 30_000);
});
