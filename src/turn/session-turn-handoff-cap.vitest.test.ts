import { describe, expect, it, vi } from 'vitest';

const handoffs = vi.hoisted(() => ({ reads: 0, runs: 0 }));
vi.mock('../session/state/read.js', () => ({
  readState: async () => ({
    sessions: [{
      id: 's', route: 'gateway', accountId: handoffs.reads++ % 2 ? 'a' : 'b',
      provider: 'gateway', model: null, status: 'active', createdAt: '', updatedAt: '',
    }],
  }),
}));
vi.mock('./agent-turn.js', () => ({ runAgentTurn: async () => { handoffs.runs += 1; return 'continue'; } }));
vi.mock('../commands/ai/local-model.js', () => ({ releaseHeldLocalModel: async () => undefined }));
vi.mock('../session/turn-changes.js', () => ({ TurnRecorder: class { async finish() { /* no disk */ } } }));

const { runSessionTurn } = await import('./session-turn.js');

describe('repeated mid-turn handoffs', () => {
  it('reports the limit as an error instead of completing an unserved request', async () => {
    handoffs.reads = 0;
    handoffs.runs = 0;
    await expect(runSessionTurn({} as never, 's', 'continue')).rejects.toThrow(/changed providers or accounts 8 times/);
    expect(handoffs.runs).toBe(8);
  });
});
