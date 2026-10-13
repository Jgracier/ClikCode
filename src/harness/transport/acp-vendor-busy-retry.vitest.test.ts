/** Defects from live conformance: a vendor's "queued" notice is never stored
 * as the answer, a repeated retry category ends the turn classified, a dead
 * child's startup banner is not its failure, and a wait for the user shows. */
import { describe, expect, it } from 'vitest';
import { acpFailureMessage, createAcpSession, vendorBusyNotice } from './acp-client.js';
import { classifyAccountFailure } from '../../turn/failover.js';

function agent(body: string): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const note = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (m.method === 'session/new' || m.method === 'session/load') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/prompt') { const id = m.id; ${body} }
    } });
  `;
}
const input = (body: string, extra: Record<string, unknown> = {}) => ({
  binary: process.execPath, command: 'fake', argv: ['-e', agent(body)], cwd: process.cwd(), prompt: 'go',
  environment: {}, permissionMode: 'ask' as const, ...extra,
});

describe('vendor busy notices', () => {
  it('reads Queued as busy always, Stopped only after a cancel', () => {
    expect(vendorBusyNotice('Queued for the next turn. (1 queued)', false)).toBe(true);
    expect(vendorBusyNotice('Stopped', false)).toBe(false);
    expect(vendorBusyNotice('Stopped', true)).toBe(true);
    expect(vendorBusyNotice('Queued items are listed below: a, b', false)).toBe(false);
  });

  it('never returns a queued notice as the assistant message', async () => {
    const session = createAcpSession();
    try {
      const failure = await session.runTurn(input(`note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Queued for the next turn. (1 queued)' } }); send({ id, result: { stopReason: 'end_turn' } });`)).catch((e: Error) => e);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/still finishing the cancelled turn/);
    } finally { await session.close(); }
  });
});

describe('a retry category repeated with no progress', () => {
  it('ends the turn as rate limited after five in a row, with the phase shown each time', async () => {
    const phases: string[] = [];
    const session = createAcpSession({ idleMs: 5000 });
    try {
      const retry = `send({ method: '_session/retrying', params: { sessionId: 's1', category: 'rate_limited', detail: 'HTTP 429' } });`;
      const failure = await session.runTurn(input(retry.repeat(6), { onPhase: (p: string) => phases.push(p) })).catch((e: Error) => e) as Error & { errorKind?: string; statusCode?: number };
      expect(phases.filter((p) => /attempt/.test(p))).toHaveLength(5);
      expect(phases[0]).toMatch(/rate limited: HTTP 429\), attempt 1/);
      expect(failure.errorKind).toBe('rate_limited');
      expect(failure.statusCode).toBe(429);
      expect(classifyAccountFailure(failure)).toBe('temporarily-throttled');
    } finally { await session.close(); }
  });

  it('starts counting again after content', async () => {
    const session = createAcpSession({ idleMs: 5000 });
    try {
      const retry = `send({ method: '_session/retrying', params: { sessionId: 's1', category: 'rate_limited', detail: 'HTTP 429' } });`;
      const result = await session.runTurn(input(`${retry.repeat(4)} note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fine' } }); ${retry.repeat(4)} send({ id, result: { stopReason: 'end_turn' } });`));
      expect(result.text).toBe('fine');
    } finally { await session.close(); }
  });
});

describe('approval waits', () => {
  it('names the approval it waits on', async () => {
    const phases: string[] = [];
    const session = createAcpSession();
    try {
      const result = await session.runTurn(input(
        `send({ id: 500, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 'workspace-indexing-permission', title: 'Index workspace', kind: 'other' }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] } }); setTimeout(() => { note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }); send({ id, result: { stopReason: 'end_turn' } }); }, 300);`,
        { onPhase: (p: string) => phases.push(p), onApproval: async () => false },
      ));
      expect(result.text).toBe('ok');
      expect(phases).toContain('waiting for your approval: Index workspace');
    } finally { await session.close(); }
  });
});

describe('a dead child\'s failure text', () => {
  it('drops the startup banner and leads with the vendor\'s refusal', () => {
    expect(acpFailureMessage('[acp] starting ACP mode over stdio…\nError: Insufficient balance\n')).toBe('Error: Insufficient balance');
    expect(acpFailureMessage('[acp] starting ACP mode over stdio…\n')).toBe('');
  });
});

describe('a prompt the agent cancels by itself', () => {
  it('fails with a reason instead of ending as a quiet cancel', async () => {
    const session = createAcpSession();
    try {
      const failure = await session.runTurn(input(`send({ id, result: { stopReason: 'cancelled' } });`)).catch((e: Error) => e);
      expect((failure as Error).message).toMatch(/ended the turn as cancelled before saying anything/);
    } finally { await session.close(); }
  });
});
