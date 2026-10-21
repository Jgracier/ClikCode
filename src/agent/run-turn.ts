/** The agent loop, for ClikCode's own agent on every route (the Gateway, a local
 * provider, a sub-agent): model step → tool calls → results → repeat, emitting
 * the same normalized events as the vendor transports. */
import { PLAN_MODE_INSTRUCTIONS } from './context.js';
import type { AgentTurnInput, AgentTurnResult } from './model-client.js';
import { abortable } from './turn-support.js';
import { runModelStep, recordStep } from './turn-model-step.js';
import { deliverPending, finishBackgroundForSwitch } from './turn-notifications.js';
import { settleStep } from './turn-answer.js';
import { closeTurn, openTurn } from './turn-runtime.js';
import { createToolRunner, runToolCalls } from './turn-tools.js';

export async function runAgentLoop(input: AgentTurnInput): Promise<AgentTurnResult> {
  const { rt, promptBlocked } = await openTurn(input);
  const { signal } = rt;
  const tools = createToolRunner(rt, runAgentLoop);
  try {
    if (promptBlocked) {
      const note = `Your message was blocked by a UserPromptSubmit hook: ${promptBlocked}`;
      input.onResponseDelta?.(note, 'append');
      rt.segments.push(note);
      return rt.result({ stopReason: 'completed', isError: true, errorKind: 'other' });
    }
    for (;;) {
      rt.throwIfAborted();
      await deliverPending(rt);
      const system = rt.session.plan.active ? `${rt.baseSystem}\n\n${PLAN_MODE_INSTRUCTIONS}` : rt.baseSystem;
      const finalOnly = rt.stalledCall !== undefined;
      input.onPhase?.('thinking');
      rt.shownCalls.clear();
      const stepped = await abortable(Promise.resolve(input.modelClientForStep?.()), signal);
      if (stepped === 'switch') {
        await finishBackgroundForSwitch(rt);
        return rt.result({ stopReason: 'account-switch' });
      }
      const modelClient = stepped ?? input.modelClient;
      rt.stepAcceptsImages = modelClient.acceptsImages === true;
      const outcome = await runModelStep(rt, modelClient, system, finalOnly);
      if (outcome.kind === 'continue') continue;
      if (outcome.kind === 'done') return outcome.result;

      const recorded = await recordStep(rt, system, outcome.step, outcome.streamedThisStep, finalOnly);
      const settled = await settleStep(rt, { ...recorded, finalOnly });
      if (settled === 'continue') continue;
      if (settled) return settled;
      const ended = await runToolCalls(rt, tools, recorded.calls);
      if (ended) return ended;
    }
  } finally {
    await closeTurn(rt);
  }
}
