/** Plan mode as an ACP session mode (catalog `acp.planModeId`, Claude Code's `plan`): a turn with
 * the chat's Plan mode on runs in that mode instead of the permission mode's, and the agent
 * leaving it mid-turn (its plan approved) is reported so the chat's switch turns off. Driven by a
 * real child speaking ACP, which records the requests it was sent. */
import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpSession } from './acp-client.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { planModeOnChat } from '../../agent/plan-mode-setting.js';

const agent = (log: string) => `
  const fs = require('node:fs');
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const modes = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] };
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method) fs.appendFileSync(${JSON.stringify(log)}, m.method + ' ' + (m.params?.modeId ?? '') + '\\n');
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1', modes } });
    else if (m.method === 'session/set_mode') { modes.currentModeId = m.params.modeId; send({ id: m.id, result: {} }); }
    else if (m.method === 'session/prompt') {
      // The plan approved: the agent leaves plan mode on its own.
      if (modes.currentModeId === 'plan') { modes.currentModeId = 'default'; send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } } }); }
      send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    }
  } });
`;

it('runs the turn in the agent\'s plan mode and reports the agent leaving it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-plan-'));
  const log = join(dir, 'requests');
  const session = createAcpSession();
  let exits = 0;
  const acp = { permissionModeIds: { ask: 'default' }, planModeId: 'plan' } as const;
  const turn = (planMode: boolean) => session.runTurn({
    binary: process.execPath, command: 'fake', argv: ['-e', agent(log)], cwd: process.cwd(), prompt: 'go',
    environment: {}, permissionMode: 'ask', acp, planMode, onPlanModeExit: () => { exits += 1; },
  });
  try {
    await turn(true);
    expect(exits).toBe(1);
    // Next turn, plan mode off: the agent is already in the permission mode's.
    await turn(false);
    const requests = readFileSync(log, 'utf8').trim().split('\n').map((line) => line.trim());
    expect(requests.filter((line) => line.startsWith('session/set_mode'))).toEqual(['session/set_mode plan']);
    expect(exits).toBe(1);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('Claude Code\'s plan mode is its ACP mode `plan`, kept on the chat', () => {
  const claude = localHarnessForCommand('claude');
  expect(claude?.acp?.planModeId).toBe('plan');
  expect(planModeOnChat({ route: 'local' }, claude)).toBe(true);
  expect(planModeOnChat({ route: 'local' }, localHarnessForCommand('copilot'))).toBe(false);
  expect(planModeOnChat({ route: 'gateway' }, undefined)).toBe(true);
});
