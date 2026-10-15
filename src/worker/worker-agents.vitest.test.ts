import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
vi.mock('../session/store/paths.js', async (original) => ({ ...(await original<object>()), stateDirectory: () => dir }));

const { sessionAgents } = await import('../agent/background-agents.js');
const { sessionState } = await import('../agent/session-state.js');
const { createAgentsCommand } = await import('./worker-agents.js');
const { parseAgentsArgs } = await import('../tui/slash/handlers/agents.js');

describe('/agents: the only way to stop a background agent', () => {
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'clikcode-agents-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const setup = () => {
    const session = sessionState(dir, `agents-${Math.random()}`);
    const agents = sessionAgents(session, dir);
    const aborted: string[] = [];
    for (const label of ['migrate the schema', 'write the docs']) {
      agents.start(label, (_steer, signal) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted.push(label); resolve({ output: 'partial', isError: true }); })));
    }
    return { agents, run: createAgentsCommand({ agentSession: session, sessionId: session.sessionId } as never), aborted };
  };

  it('lists what runs', async () => {
    const { run } = setup();
    const answer = await run({ type: 'agents', action: 'list' });
    expect(answer.running.map((agent) => agent.id)).toEqual(['agent_1', 'agent_2']);
    expect(answer.text).toMatch(/Esc and Ctrl\+C do not stop these/);
  });

  it('does not stop anything until confirmed, and names the agents it would stop', async () => {
    const { agents, run, aborted } = setup();
    const answer = await run({ type: 'agents', action: 'stop', all: true });
    expect(answer.outcome).toBe('needs-confirm');
    expect(answer.text).toMatch(/agent_1 \(migrate the schema\), agent_2 \(write the docs\)/);
    expect(aborted).toEqual([]);
    expect(agents.running()).toBe(2);
  });

  it('stops one agent when confirmed, leaving the other running', async () => {
    const { agents, run, aborted } = setup();
    const answer = await run({ type: 'agents', action: 'stop', ids: ['agent_2'], confirm: true });
    expect(answer).toMatchObject({ outcome: 'stopped', stopped: ['agent_2'] });
    expect(aborted).toEqual(['write the docs']);
    expect(agents.running()).toBe(1);
  });

  it('"stop everything" confirmed stops all', async () => {
    const { agents, run } = setup();
    expect((await run({ type: 'agents', action: 'stop', all: true, confirm: true })).stopped).toEqual(['agent_1', 'agent_2']);
    expect(agents.running()).toBe(0);
  });

  it('parses the slash arguments', () => {
    expect(parseAgentsArgs([])).toEqual({ action: 'list' });
    expect(parseAgentsArgs(['stop', 'agent_1'])).toEqual({ action: 'stop', ids: ['agent_1'], all: false, confirm: false });
    expect(parseAgentsArgs(['stop', 'all', 'confirm'])).toEqual({ action: 'stop', ids: [], all: true, confirm: true });
  });
});
