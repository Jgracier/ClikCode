/** One model step of the agent loop: the call, what streams out of it, and the
 * recovery from a step that failed before saying anything. */
import { isTurnCancelled, turnCancelledError } from './cancellation.js';
import type { ConversationItem, AgentTurnResult, ModelClient, ModelStepResult, ModelToolCall } from './model-client.js';
import { toolSpecs } from './tools/registry.js';
import { visibleTools } from './permissions.js';
import { completedArguments } from './models/openai-client.js';
import { thoughtLabel } from '../harness/protocol/activity-events.js';
import { estimateContextTokens } from './context.js';
import { fitContext, responseReserve, UNKNOWN_CONTEXT_WINDOW, type ContextView } from './context-view.js';
import { classifyModelError, MODEL_START_BUDGET_SECONDS, modelStartWaitSeconds, pause, retryDelaySeconds, STEP_RETRY_BUDGET_SECONDS, stepRecovery } from './turn-recovery.js';
import { abortable, categoryForTool, withUniqueIds } from './turn-support.js';
import { recordUsage } from './usage.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import type { TurnRuntime } from './turn-runtime.js';
import type { OwnModelStart } from '../gateway/own-models.js';

/** What a model step came to: its result, a retry of the loop, or the turn's end. */
type ModelStepOutcome =
  | { kind: 'step'; step: ModelStepResult; streamedThisStep: string }
  | { kind: 'continue' }
  | { kind: 'done'; result: AgentTurnResult };

/** Calls shown while they were being written, by id, with the label
 * last shown: one that never runs is settled, not left spinning. */
export function settleUnrun(rt: TurnRuntime, ran: ReadonlySet<string>, why: string): void {
  for (const [id, label] of rt.shownCalls) {
    if (!ran.has(id)) rt.input.onActivity?.({ kind: 'tool-error', label, id, output: [why] });
  }
}

export async function runModelStep(rt: TurnRuntime, modelClient: ModelClient, system: string, finalOnly: boolean): Promise<ModelStepOutcome> {
  const started = Date.now();
  const { input, signal, tools, session, turnId } = rt;
  let streamedThisStep = '';
  let reasoning = '';
  let step: ModelStepResult;
  let view: ContextView | undefined;
  let requiredTools: string[] = [];
  try {
    if (rt.budgetClient !== modelClient) {
      rt.budgetClient = modelClient;
      rt.contextWindow = modelClient.contextHints?.contextWindow;
      rt.contextScale = 1;
    }
    const advertised = rt.advertised(rt.items);
    let lastCallIndex = rt.items.length - 1;
    while (lastCallIndex >= 0 && rt.items[lastCallIndex]!.type !== 'tool_call') lastCallIndex--;
    const lastCall = rt.items[lastCallIndex];
    const beforeLoad = lastCall?.type === 'tool_call' && ['load_tools', 'load_mcp_tools'].includes(lastCall.name)
      ? new Set(rt.advertised(rt.items.slice(0, lastCallIndex)).map((tool) => tool.name)) : undefined;
    const canReloadMcp = advertised.some((tool) => tool.name === 'load_mcp_tools');
    requiredTools = advertised.filter((tool) =>
      (tool.mcp && (tool.mcp.core || !canReloadMcp)) || (beforeLoad && !beforeLoad.has(tool.name)),
    ).map((tool) => tool.name);
    const outputReserve = responseReserve(rt.contextWindow ?? UNKNOWN_CONTEXT_WINDOW);
    view = fitContext({
      system, items: rt.items,
      tools: rt.profile.shapeSpecs(toolSpecs(visibleTools(advertised, session.plan.active))),
      requiredTools,
      window: rt.contextWindow, outputReserve, scale: rt.contextScale,
    });
    rt.lastRequestEstimate = view.estimatedTokens;
    step = await abortable(modelClient.step({
      system, items: view.items, signal, tools: view.tools, maxOutputTokens: outputReserve,
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
        // The user's own model, waited for while its GPU started, is answering: said once, in the conversation.
        if (rt.modelStartingSince !== undefined) {
          input.onActivity?.({ kind: 'tool-done', label: `Model ready · started in ${elapsedWords(Date.now() - rt.modelStartingSince)}`, id: `model-ready-${rt.modelStartingSince}` });
          rt.modelStartingSince = undefined;
        }
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
    // Save partial text before continuing. Calls from an incomplete step
    // have not run; only complete calls from a successful step may execute.
    const recovery = stepRecovery(error);
    const preservePartial = async () => {
      if (!streamedThisStep.trim()) return;
      await rt.append({ type: 'text', role: 'assistant', text: streamedThisStep });
      if (rt.continuesCutAnswer && rt.segments.length) rt.segments[rt.segments.length - 1] += streamedThisStep;
      else rt.segments.push(streamedThisStep.trim());
      rt.needsSeparator = true;
      rt.continuesCutAnswer = true;
      await rt.append({ type: 'text', role: 'user', source: 'harness', text: '[harness] The inference stream was interrupted. Continue from the saved partial reply. No tool call from the interrupted step was executed: regenerate any needed call completely. Preserve completed work and do not repeat completed actions.' });
    };
    if (recovery === 'capacity') {
      await preservePartial();
      input.onPhase?.('waiting for model capacity');
      const after = (error as { retryAfter?: unknown }).retryAfter;
      const wait = typeof after === 'number' && Number.isFinite(after) ? after : 2;
      await pause(Math.max(1, Math.min(30, wait)), signal);
      return { kind: 'continue' };
    }
    if (recovery === 'context-pressure' && view && rt.contextRefits < 3) {
      // Change the working view, not the model or durable transcript. Never
      // resend a payload the runtime has already refused unchanged.
      let scale = rt.contextScale;
      for (let n = 0; n < 6; n++) {
        scale *= 1.35;
        let smaller: ContextView;
        try { smaller = fitContext({ system, items: rt.items, tools: view.tools, requiredTools, window: rt.contextWindow, scale }); }
        catch { break; }
        if (JSON.stringify(smaller.items) !== JSON.stringify(view.items) || JSON.stringify(smaller.tools) !== JSON.stringify(view.tools)) {
          await preservePartial();
          rt.contextScale = scale;
          rt.contextRefits++;
          return { kind: 'continue' };
        }
      }
    }
    if (recovery === 'model-starting') {
      const after = (error as { retryAfter?: unknown }).retryAfter;
      const wait = modelStartWaitSeconds(typeof after === 'number' ? after : undefined);
      if (rt.modelStartWaitedSeconds + wait <= MODEL_START_BUDGET_SECONDS) {
        rt.modelStartWaitedSeconds += wait;
        rt.modelStartingSince ??= started;
        await waitForModelStart({
          waitS: wait, since: rt.modelStartingSince, signal,
          onPhase: (phase) => input.onPhase?.(phase),
          ...(modelClient.startStatus ? { poll: () => modelClient.startStatus!() } : {}),
        });
        return { kind: 'continue' };
      }
    }
    if (recovery === 'retry') {
      const after = (error as { retryAfter?: unknown }).retryAfter;
      const wait = retryDelaySeconds(rt.stepRetries + 1, typeof after === 'number' ? after : undefined);
      if (rt.retryWaitedSeconds + wait <= STEP_RETRY_BUDGET_SECONDS) {
        await preservePartial();
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
    lifecycle('turn.step', {
      model: rt.servedModel || undefined, ms: Date.now() - started, outcome: 'error',
      ...(typeof statusCode === 'number' ? { status: statusCode } : {}),
    });
    return {
      kind: 'done',
      result: rt.result({
        text: message, isError: true, errorKind: classified.kind, stopReason: 'model-error',
        ...(classified.retryAfter !== undefined ? { retryAfter: classified.retryAfter } : {}),
        ...(typeof statusCode === 'number' ? { statusCode } : {}),
      }),
    };
  }
  lifecycle('turn.step', {
    model: step.servedModel || rt.servedModel || undefined,
    ms: Date.now() - started, outcome: step.toolCalls.length ? 'tools' : 'text',
    tools: step.toolCalls.length, stop: step.stopReason,
  });
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
  rt.contextRefits = 0;
  rt.retryWaitedSeconds = 0;
  rt.modelStartWaitedSeconds = 0;
  rt.modelStartingSince = undefined;

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
  // Learn tokenizer/template overhead from real usage, conservatively. The
  // full transcript remains the source for subsequent views and model switches.
  if (step.usage?.input && rt.lastRequestEstimate > 0) {
    rt.contextScale = Math.max(rt.contextScale, rt.contextScale * step.usage.input / rt.lastRequestEstimate);
  }
  rt.lastStepUsage = step.usage;
  rt.itemsAtLastUsage = rt.items.length;
  rt.contextWindow = step.contextWindow ?? rt.contextWindow;
  rt.servedModel = step.servedModel ?? rt.servedModel;
  rt.lastContext = {
    contextProfile: rt.profile.name,
    contextTokens: step.usage?.input ? estimateContextTokens(system, rt.items, step.usage) : rt.lastRequestEstimate + estimateContextTokens('', produced),
    contextWindow: rt.contextWindow && rt.contextWindow > 0 ? rt.contextWindow : UNKNOWN_CONTEXT_WINDOW,
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

/** "4 s", "1 min 20 s", "6 min": how long a wait has taken, as the status line says it. */
function elapsedWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 && m < 10 ? `${m} min ${s % 60} s` : `${m} min`;
}

/**
 * The status while the user's own model starts on its GPU: the spinner beside it is the turn's own. First it is looking for
 * a machine ("Finding an available server"), then loading the model onto the one it got ("Starting model", with what is
 * left of the usual start where it landed, when that is known). `sincePollMs` carries the countdown between two readings.
 */
export function startingModelPhase(elapsedMs: number, start?: OwnModelStart, sincePollMs = 0): string {
  const waited = elapsedMs < 1000 ? '' : ` · ${elapsedWords(elapsedMs)}`;
  if (start?.phase === 'finding-server') return `Finding an available server${waited}`;
  if (start?.phase === 'starting-model') {
    if (start.remainingS === undefined) return `Starting model · ${elapsedWords(start.elapsedS * 1000 + sincePollMs)}`;
    const left = start.remainingS - Math.round(sincePollMs / 1000);
    if (start.overdue) return `Starting model · taking longer than usual · ${elapsedWords(start.elapsedS * 1000 + sincePollMs)}`;
    return left > 0 ? `Starting model · about ${elapsedWords(left * 1000)} left` : 'Starting model · almost ready';
  }
  return `Starting model${waited}`;
}

/**
 * Wait `waitS` seconds for the model to come up, keeping the status line true meanwhile: asked how the start is going
 * straight away and every 5 s after, counted down in between. A reading that fails keeps the last one.
 */
export async function waitForModelStart(input: {
  waitS: number; since: number; onPhase: (phase: string) => void; signal?: AbortSignal;
  poll?: () => Promise<OwnModelStart | undefined>; now?: () => number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  let start: OwnModelStart | undefined;
  let polledAt = now();
  // Counted in whole seconds, not against the clock: the wait is exactly what was asked, whatever the clock does.
  for (let waited = 0, tick = 0; waited < input.waitS; tick += 1) {
    if (tick % 5 === 0 && input.poll) {
      try { start = await input.poll(); polledAt = now(); } catch { /* keep the last reading */ }
    }
    input.onPhase(startingModelPhase(now() - input.since, start, now() - polledAt));
    const slice = Math.min(1, input.waitS - waited);
    await pause(slice, input.signal);
    waited += slice;
  }
}
