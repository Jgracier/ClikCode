/** How an ACP turn waits: for the answer to session/prompt, with the idle
 * watchdog as a ceiling -- and where updates the agent sends between prompts
 * go. Driven by a real child speaking ACP. */
import { describe, expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';
import type { VendorBackgroundTurn } from './background-turn.js';
import type { HarnessActivityEvent } from '../prompter.js';

type Step = { after?: number; update?: Record<string, unknown>; answer?: true; permission?: true };

/** `prompts[n]` is what the agent does for the nth session/prompt. */
function agent(prompts: Step[][]): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const prompts = ${JSON.stringify(prompts)};
    let n = 0; let buf = '';
    const run = async (steps, id) => {
      for (const step of steps) {
        if (step.after) await new Promise((r) => setTimeout(r, step.after));
        if (step.update) send({ method: 'session/update', params: { sessionId: 's1', update: step.update } });
        if (step.permission) send({ id: 500 + n, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't', title: 'Run make', kind: 'execute' }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] } });
        if (step.answer) send({ id, result: { stopReason: 'end_turn' } });
      }
    };
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/prompt') run(prompts[n++] ?? [], m.id);
    } });
  `;
}

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const tool = (id: string, status: string) => ({ sessionUpdate: status === 'pending' ? 'tool_call' : 'tool_call_update', toolCallId: id, title: 'Run build', kind: 'execute', status });

function input(prompts: Step[][], extra: Record<string, unknown> = {}) {
  return {
    binary: process.execPath, command: 'fake', argv: ['-e', agent(prompts)], cwd: process.cwd(), prompt: 'go',
    environment: {}, permissionMode: 'ask' as const, ...extra,
  };
}

describe('the idle watchdog on an ACP prompt', () => {
  it('fails a prompt the agent never answers, as an idle timeout', async () => {
    const session = createAcpSession({ idleMs: 200 });
    try {
      const failure = await session.runTurn(input([[{ update: chunk('thinking...') }]])).catch((error: Error & { reason?: string }) => error);
      expect((failure as Error & { reason?: string }).reason).toBe('idle-timeout');
      expect((failure as Error).message).toBe('fake produced no output for 0s and was stopped');
    } finally { await session.close(); }
  });

  it('gives a running tool the longer budget, and each update restarts it', async () => {
    const session = createAcpSession({ idleMs: 200, toolIdleMs: 2000 });
    try {
      const result = await session.runTurn(input([[
        { update: tool('b', 'pending') }, { after: 400, update: tool('b', 'completed') },
        { after: 120, update: chunk('built') }, { after: 120, answer: true },
      ]]));
      expect(result.text).toBe('built');
    } finally { await session.close(); }
  });

  it('does not count time the user spends deciding an approval', async () => {
    // Unpaused, 300ms of silence would fire at 300ms; the answer comes at 400
    // and the next update at 500.
    const session = createAcpSession({ idleMs: 300 });
    try {
      const result = await session.runTurn(input([[{ permission: true }, { after: 500, update: chunk('ok') }, { answer: true }]], {
        onApproval: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 400)),
      }));
      expect(result.text).toBe('ok');
    } finally { await session.close(); }
  });
});

describe('updates an ACP agent sends between prompts', () => {
  it('open a background turn that ends on the agent\'s end-of-turn bookkeeping', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    try {
      const result = await session.runTurn(input([[
        { update: chunk('first') }, { answer: true },
        // Bookkeeping alone opens nothing.
        { after: 50, update: { sessionUpdate: 'usage_update', used: 1, size: 2 } },
        { after: 50, update: chunk('A task you started finished.') },
        { update: { sessionUpdate: 'session_info_update', updatedAt: 'now' } },
      ]]));
      expect(result.text).toBe('first');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(turns).toHaveLength(1);
      expect(await turns[0]!.finished).toEqual({ text: 'A task you started finished.', ended: 'completed' });
    } finally { await session.close(); }
  });

  it('keep a background turn open while a tool it started runs, and close it when that tool settles', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    try {
      await session.runTurn(input([[
        { update: chunk('one') }, { answer: true },
        { after: 50, update: tool('bg', 'pending') },
        { after: 50, update: { sessionUpdate: 'usage_update', used: 1, size: 2 } },
        { after: 150, update: tool('bg', 'completed') },
      ]]));
      await new Promise((resolve) => setTimeout(resolve, 120));
      const seen: HarnessActivityEvent[] = [];
      turns[0]!.attach({ onActivity: (event) => seen.push(event) });
      let ended = false;
      void turns[0]!.finished.then(() => { ended = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ended, 'usage_update does not end it while the tool runs').toBe(false);
      expect(await turns[0]!.finished).toEqual({ text: '', ended: 'completed' });
      expect(seen.map((event) => event.kind)).toEqual(['tool-start', 'tool-done']);
    } finally { await session.close(); }
  });

  it('are superseded by the next prompt, which receives them from then on', async () => {
    const turns: VendorBackgroundTurn[] = [];
    const session = createAcpSession({ backgroundTurns: (turn) => turns.push(turn) });
    const activity: HarnessActivityEvent[] = [];
    const prompts = input([
      [{ update: chunk('one') }, { answer: true }, { after: 30, update: tool('bg', 'pending') }],
      [{ update: tool('bg', 'completed') }, { update: chunk('two') }, { answer: true }],
    ], { onActivity: (event: HarnessActivityEvent) => activity.push(event) });
    try {
      await session.runTurn(prompts);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(turns).toHaveLength(1);
      expect((await session.runTurn(prompts)).text).toBe('two');
      expect(await turns[0]!.finished).toEqual({ text: '', ended: 'superseded' });
      expect(activity.map((event) => `${event.kind} ${event.id}`)).toEqual(['tool-done bg']);
    } finally { await session.close(); }
  });
});
