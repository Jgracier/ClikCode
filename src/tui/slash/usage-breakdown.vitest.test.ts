import { describe, expect, it } from 'vitest';
import type { HarnessState } from '../../session/model.js';
import { conversationCost, conversationCostBreakdown, usageReport } from './usage-report.js';
import { chatCostLabel, costSplitParts } from '../render/usage-words.js';
import { gatewayConversationUsageLabel } from '../../gateway/credit-label.js';
import { agentTurnUsage } from '../../gateway/harness.js';
import { recordInvocation } from '../../turn/turn-output.js';
import { addTurnUsage } from '../../harness/protocol/turn-usage.js';

type Invocation = HarnessState['invocations'][number];
const turn = (id: string, extra: Partial<Invocation> = {}): Invocation => ({ id, accountId: 'a', provider: 'clikdeploy', sessionId: 'chat', at: '', latencyMs: 1, ...extra });
const state = (invocations: Invocation[]) => ({ invocations }) as HarnessState;

describe('the chat cost split', () => {
  it('sums the split over the turns that carry one and keeps the total from every turn', () => {
    const s = state([
      turn('old', { costUsd: 0.2 }),
      turn('new', { costUsd: 0.42, costBreakdown: { meteredUsd: 0.3, gpuUsd: 0.12 } }),
      turn('unknown'),
    ]);
    expect(conversationCost(s, 'chat')).toBeCloseTo(0.62);
    const split = conversationCostBreakdown(s, 'chat')!;
    expect(split.meteredUsd).toBeCloseTo(0.3);
    expect(split.gpuUsd).toBeCloseTo(0.12);
  });

  it('has no split when no turn reports one, and no cost when no turn does', () => {
    expect(conversationCostBreakdown(state([turn('a', { costUsd: 1 })]), 'chat')).toBeUndefined();
    expect(conversationCost(state([turn('a')]), 'chat')).toBeUndefined();
  });

  it('shows one number in the footer: the total of whatever was used, API, GPU or both', () => {
    expect(chatCostLabel(0.42)).toBe('$0.42 this chat');
    expect(chatCostLabel(0.12)).toBe('$0.12 this chat');
    expect(chatCostLabel(undefined)).toBeUndefined();
    expect(chatCostLabel(Number.NaN)).toBeUndefined();
    expect(gatewayConversationUsageLabel(0.42, '$5.00 credit left')).toBe('$0.42 this chat • $5.00 credit left');
    expect(gatewayConversationUsageLabel(undefined, '$5.00 credit left')).toBe('$5.00 credit left');
  });

  it('words where it went (API / GPU) for /usage, leaving out a zero side or the whole split', () => {
    expect(costSplitParts({ meteredUsd: 0.3, gpuUsd: 0.12 })).toEqual(['API $0.30', 'GPU $0.12']);
    expect(costSplitParts({ meteredUsd: 0, gpuUsd: 0.12 })).toEqual(['GPU $0.12']);
    expect(costSplitParts({ meteredUsd: 0.3 })).toEqual(['API $0.30']);
    expect(costSplitParts({ meteredUsd: 0, gpuUsd: 0 })).toEqual([]);
    expect(costSplitParts(undefined)).toEqual([]);
  });


  it('shows in the /usage report', () => {
    const s = { ...state([turn('new', { costUsd: 0.42, costBreakdown: { meteredUsd: 0.3, gpuUsd: 0.12 } })]), accounts: [], sessions: [] } as unknown as HarnessState;
    const text = usageReport(s, { id: 'chat', provider: 'clikdeploy' } as never).text;
    expect(text).toContain('This chat · 1 turn · $0.42 · API $0.30 · GPU $0.12');
  });

  it('survives the turn record and the saved state', () => {
    const usage = agentTurnUsage({ costMicroUsd: 420_000, meteredMicroUsd: 300_000, gpuMicroUsd: 120_000 });
    expect(usage).toMatchObject({ costUsd: 0.42, costBreakdown: { meteredUsd: 0.3, gpuUsd: 0.12 } });
    expect(agentTurnUsage({ costMicroUsd: 1 })).not.toHaveProperty('costBreakdown');
    const s = state([]);
    recordInvocation(s, { sessionId: 'chat', accountId: 'a', provider: 'clikdeploy', startedAt: Date.now(), usage });
    const reloaded = JSON.parse(JSON.stringify(s)) as HarnessState;
    expect(reloaded.invocations[0]!.costBreakdown).toEqual({ meteredUsd: 0.3, gpuUsd: 0.12 });
    recordInvocation(s, { sessionId: 'chat', accountId: 'a', provider: 'clikdeploy', startedAt: Date.now(), usage: { costUsd: 1 } });
    expect(s.invocations[1]).not.toHaveProperty('costBreakdown');
  });

  it('adds the split across the attempts of one turn', () => {
    const sum = addTurnUsage({ costUsd: 0.1, costBreakdown: { gpuUsd: 0.1 } }, { costUsd: 0.2, costBreakdown: { meteredUsd: 0.2 } });
    expect(sum?.costBreakdown).toEqual({ meteredUsd: 0.2, gpuUsd: 0.1 });
    expect(addTurnUsage({ costUsd: 0.1 }, { costUsd: 0.2 })).not.toHaveProperty('costBreakdown');
  });
});
