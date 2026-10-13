/** One model step of the agent loop: the call, what streams out of it, and the
 * recovery from a step that failed before saying anything. */
import { isTurnCancelled, turnCancelledError } from './cancellation.js';
import type { ConversationItem, GatewayHarnessTurnResult, ModelClient, ModelStepResult, ModelToolCall } from './model-client.js';
import { toolSpecs } from './tools/registry.js';
import { visibleTools } from './permissions.js';
import { completedArguments } from './models/openai-client.js';
import { thoughtLabel } from '../harness/protocol/activity-events.js';
import { estimateContextTokens, DEFAULT_CONTEXT_WINDOW } from './context.js';
import { compactTurn } from './turn-compaction.js';
import { classifyModelError, pause, retryDelaySeconds, STEP_RETRY_BUDGET_SECONDS, stepRecovery } from './turn-recovery.js';
import { abortable, categoryForTool, withUniqueIds } from './turn-support.js';
import { recordUsage } from './usage.js';
import type { TurnRuntime } from './turn-runtime.js';

/** What a model step came to: its result, a retry of the loop, or the turn's end. */
export type ModelStepOutcome =
  | { kind: 'step'; step: ModelStepResult; streamedThisStep: string }
  | { kind: 'continue' }
  | { kind: 'done'; result: GatewayHarnessTurnResult };

/** Calls shown while they were being written, by id, with the label
 * last shown: one that never runs is settled, not left spinning. */
export function settleUnrun(rt: TurnRuntime, ran: ReadonlySet<string>, why: string): void {
  for (const [id, label] of rt.shownCalls) {
    if (!ran.has(id)) rt.input.onActivity?.({ kind: 'tool-error', label, id, output: [why] });
  }
}

export async function runModelStep(rt: TurnRuntime, modelClient: ModelClient, system: string, finalOnly: boolean): Promise<ModelStepOutcome> {
  const { input, signal, tools, session, turnId } = rt;
  let streamedThisStep = '';
  let reasoning = '';
  let step: ModelStepResult;
  try {
    step = await abortable(modelClient.step({
      system, items: rt.items, signal,
      tools: rt.profile.shapeSpecs(toolSpecs(visibleTools(rt.advertised(rt.items), session.plan.active))),
      ...(finalOnly ? { toolChoice: 'none' as const } : {}),
      onTextDelta: (text) => {
        if (!text || signal?.aborted) return;
        if (!streamedThisStep && rt.needsSeparator && !rt.continuesCutAnswer) input.onResponseDelta?.('\n\n', 'append');
        streamedThisStep += text;
        input.onResponseDelta?.(text, 'append');
        input.onPhase?.('generating response');
      },
      // The whole thought so far, under one id per step, so each delta
      // replaces the last rather than adding a row. This is the item's
      // only emission: it settles where it began, when the answer starts.
      onReasoningDelta: (text) => {
        reasoning = `${reasoning}${text}`.slice(-4000);
        if (reasoning.trim()) input.onActivity?.({ kind: 'thinking', label: thoughtLabel(reasoning), id: `${turnId}:reasoning:${rt.steps}` });
      },
      // The row a vendor CLI shows the moment the model picks a tool,
      // named by its arguments as they arrive; the run settles the same
      // row by the same id.
      ...(finalOnly ? {} : {
        onToolCallDelta: (call: { id: string; name: string; arguments: string }) => {
          if (signal?.aborted) return;
          const tool = tools.find((candidate) => candidate.name === call.name);
          const args = completedArguments(call.arguments);
          let label = call.name;
          if (tool) { try { label = tool.label(args); } catch { /* not enough of the arguments yet: the name */ } }
          if (rt.shownCalls.get(call.id) === label) return;
          rt.shownCalls.set(call.id, label);
          input.onActivity?.({ kind: 'tool-start', label, id: call.id, ...categoryForTool(tool, args) });
        },
      }),
      // The model the Gateway serves, on the screen from its first frame
      // rather than after the step.
      onServedModel: (model, window) => {
        rt.servedModel = model;
        if (window) rt.contextWindow = window;
        rt.lastContext = { ...rt.lastContext, servedModel: model, ...(window ? { contextWindow: window } : {}) };
        input.onUsage?.({ ...rt.ledger.total, ...rt.lastContext });
      },
    }), signal);
  } catch (error) {
    if (isTurnCancelled(error) || signal?.aborted) throw turnCancelledError();
    // A call being written when the step failed never runs: a resent
    // step writes its own.
    settleUnrun(rt, new Set(), 'not run: the model\'s reply was cut off before this call was complete');
    // Once text has streamed the step belongs to what was said; sending it
    // again would say it twice. Before that, a step is safe to resend: the
    // Gateway is stateless and no tool has run.
    const recovery = streamedThisStep ? undefined : stepRecovery(error);
    if (recovery === 'compact' && !rt.compactedForSize) {
      rt.compactedForSize = true;
      // No size target: the Gateway measured the real model and said it
      // does not fit, which outranks this side's estimate of whether it does.
      if (await compactTurn(rt, system)) return { kind: 'continue' };
    }
    if (recovery === 'retry') {
      const after = (error as { retryAfter?: unknown }).retryAfter;
      const wait = retryDelaySeconds(rt.stepRetries + 1, typeof after === 'number' ? after : undefined);
      if (rt.retryWaitedSeconds + wait <= STEP_RETRY_BUDGET_SECONDS) {
        rt.stepRetries++;
        rt.retryWaitedSeconds += wait;
        input.onPhase?.(`retrying in ${Math.ceil(wait)}s`);
        await pause(wait, signal);
        return { kind: 'continue' };
      }
    }
    // What was shown is what is saved: the partial answer stays in the conversation.
    if (streamedThisStep.trim()) await rt.append({ type: 'text', role: 'assistant', text: streamedThisStep });
    const classified = classifyModelError(error);
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode;
    return {
      kind: 'done',
      result: rt.result({
        text: message, isError: true, errorKind: classified.kind, stopReason: 'model-error',
        ...(classified.retryAfter !== undefined ? { retryAfter: classified.retryAfter } : {}),
        ...(typeof statusCode === 'number' ? { statusCode } : {}),
      }),
    };
  }
  return { kind: 'step', step, streamedThisStep };
}

/** The step's bookkeeping once it came back: its text and calls onto the
 * conversation, its usage onto the ledger and the screen. */
export async function recordStep(
  rt: TurnRuntime, system: string, step: ModelStepResult, streamedThisStep: string, finalOnly: boolean,
): Promise<{ calls: ReturnType<typeof withCutOffNotes>; stepText: string; cutOff: boolean }> {
  const { input } = rt;
  rt.steps++;
  rt.stepRetries = 0;
  rt.retryWaitedSeconds = 0;
  rt.compactedForSize = false;

  // A client without a delta channel still has to reach the UI.
  if (step.text && step.text.length > streamedThisStep.length && step.text.startsWith(streamedThisStep)) {
    if (!streamedThisStep && rt.needsSeparator) input.onResponseDelta?.('\n\n', 'append');
    input.onResponseDelta?.(step.text.slice(streamedThisStep.length), 'append');
  }
  const stepText = step.text || streamedThisStep;
  // The step's reasoning was shown as it streamed, under one id, before the
  // answer. It is not emitted again here: the same id after the text
  // opened a second thought row below the answer (standard 1.4: a row
  // does not move once placed).

  const cutOff = step.stopReason === 'length';
  const calls = withCutOffNotes(finalOnly ? [] : step.toolCalls, cutOff);
  settleUnrun(rt, new Set(calls.map((call) => call.id)), 'not run');
  const produced: ConversationItem[] = (step.reasoning ?? []).map((block): ConversationItem => ({ type: 'reasoning', ...block }));
  if (stepText.trim()) {
    produced.push({ type: 'text', role: 'assistant', text: stepText });
    if (rt.continuesCutAnswer && rt.segments.length) rt.segments[rt.segments.length - 1] = `${rt.segments[rt.segments.length - 1]}${stepText}`.trim();
    else rt.segments.push(stepText.trim());
    rt.needsSeparator = true;
  }
  rt.continuesCutAnswer = false;
  produced.push(...calls.map((call): ConversationItem => ({ type: 'tool_call', id: call.id, name: call.name, args: call.args })));
  if (produced.length) await rt.append(...produced);

  rt.ledger = recordUsage(rt.ledger, step.usage);
  rt.lastStepUsage = step.usage;
  rt.itemsAtLastUsage = rt.items.length;
  rt.contextWindow = step.contextWindow ?? rt.contextWindow;
  rt.servedModel = step.servedModel ?? rt.servedModel;
  rt.lastContext = {
    contextProfile: rt.profile.name,
    contextTokens: estimateContextTokens(system, rt.items, step.usage),
    contextWindow: rt.contextWindow && rt.contextWindow > 0 ? rt.contextWindow : DEFAULT_CONTEXT_WINDOW,
    ...(rt.servedModel ? { servedModel: rt.servedModel } : {}),
    stopReason: step.stopReason,
  };
  input.onUsage?.({ ...rt.ledger.total, ...rt.lastContext });
  return { calls, stepText, cutOff };
}

function withCutOffNotes(toolCalls: readonly ModelToolCall[], cutOff: boolean) {
  return withUniqueIds(toolCalls).map((call) => cutOff && call.argumentsError
    // Cut off mid-call: the model hears why its JSON is incomplete, so it
    // sends a smaller call rather than the same one again.
    ? { ...call, argumentsError: `the reply reached the output limit while these arguments were being written, so they are incomplete. Make the call again with less in it, for example a large file written in several smaller edits` }
    : call);
}
