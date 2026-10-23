/** What a step that has been recorded means for the turn: a reply cut off at the
 * output limit, steering or background work still pending, the Stop hooks, or done. */
import type { AgentTurnResult, ModelToolCall } from './model-client.js';
import { abortable } from './turn-support.js';
import { CONTINUE_AFTER_LENGTH, MAX_LENGTH_CONTINUES, MAX_STOP_HOOK_CONTINUES } from './turn-recovery.js';
import type { TurnRuntime } from './turn-runtime.js';

/** 'continue' runs another step; a result ends the turn; undefined means the
 * step's tool calls are to be run. */
export async function settleStep(
  rt: TurnRuntime, step: { calls: readonly ModelToolCall[]; cutOff: boolean; stepText: string; finalOnly: boolean },
): Promise<'continue' | AgentTurnResult | undefined> {
  const { input, session, signal, backgroundAgents } = rt;
  const { calls, cutOff, stepText } = step;
  if (step.finalOnly) return rt.result({ stopReason: 'completed', stalled: true });
  // An answer cut off at the output limit is carried on, not taken as
  // the answer: the next step picks up mid-sentence.
  if (!calls.length && cutOff) {
    let previousText: string | undefined;
    for (let i = rt.items.length - 2; i >= 0; i--) {
      const item = rt.items[i]!;
      if (item.type === 'text' && item.role === 'assistant') { previousText = item.text.trim(); break; }
    }
    const productive = Boolean(stepText.trim()) && previousText !== stepText.trim();
    if (!productive && rt.lengthContinues >= MAX_LENGTH_CONTINUES) return rt.result({ stopReason: 'completed', stalled: true });
    rt.lengthContinues = productive ? 0 : rt.lengthContinues + 1;
    rt.continuesCutAnswer = Boolean(stepText.trim());
    await rt.append({ type: 'text', role: 'user', source: 'harness', text: CONTINUE_AFTER_LENGTH });
    return 'continue';
  }
  if (calls.length) return undefined;
  // Steering, or a background shell that finished while this step ran:
  // one more step answers it now rather than in a follow-up turn.
  if (rt.steerQueue.length || (!input.subagent && session.notifications.length)) return 'continue';
  // A background agent's result is part of this turn's answer: wait
  // for the next to finish, and the next step hears it.
  if (backgroundAgents?.running()) {
    input.onPhase?.('waiting for background agents');
    // A steer typed meanwhile ends the wait: the model answers it now, and waits again after.
    let release: () => void = () => undefined;
    const steered = new Promise<void>((resolve) => { release = resolve; rt.steerWaiters.add(resolve); });
    try { await abortable(Promise.race([backgroundAgents.nextFinish(signal), steered]), signal); } finally { rt.steerWaiters.delete(release); }
    return 'continue';
  }
  // A sub-agent answers to SubagentStop, named as Claude Code names it:
  // the parent's session, the sub-agent's own id and trace.
  const sub = input.subagent;
  const turnHookInfo = rt.turnHookInfo;
  const stopHook = sub
    ? input.hooks?.subagentStop && (() => input.hooks!.subagentStop!({
      ...turnHookInfo, sessionId: sub.parentSessionId ?? input.sessionId, stopHookActive: rt.stopContinues > 0,
      agentId: input.sessionId, agentType: sub.agentType ?? sub.kind ?? 'research', agentTranscriptPath: sub.transcriptFile,
    }))
    : input.hooks?.stop && (() => input.hooks!.stop!({ ...turnHookInfo, stopHookActive: rt.stopContinues > 0 }));
  if (stopHook && rt.stopContinues < MAX_STOP_HOOK_CONTINUES) {
    const verdict = await abortable(Promise.resolve(stopHook()), signal);
    if (verdict?.continueWith) {
      rt.stopContinues += 1;
      await rt.append({ type: 'text', role: 'user', source: 'harness', text: `[${sub ? 'SubagentStop' : 'Stop'} hook] ${verdict.continueWith}` });
      return 'continue';
    }
    // Steered while the hook ran (a user, or agent_send): answer it, not drop it.
    if (rt.steerQueue.length) return 'continue';
  }
  return rt.result({ stopReason: 'completed' });
}
