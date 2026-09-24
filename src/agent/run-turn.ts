/** The gateway harness agent loop: model step → tool calls → results →
 * repeat, emitting the same normalized events as the vendor transports. */
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from './conversation.js';
import { buildSystemPrompt, compactConversation, DEFAULT_CONTEXT_WINDOW, estimateContextTokens, PLAN_MODE_INSTRUCTIONS, shouldCompact, COMPACTION_THRESHOLD } from './context.js';
import { FileCheckpointStore, newTurnId } from './file-checkpoints.js';
import { addPermissionAllowRule, buildApprovalPrompt, decidePermission, loadPermissionRules, suggestPermissionRule, visibleTools, type PermissionRules } from './permissions.js';
import { validateAgainstSchema } from './schema-validate.js';
import { capHeadTail, eventOutputPreview, type PathScope } from './security.js';
import { sessionState } from './session-state.js';
import { defaultTools, mergeTools, toolSpecs } from './tools/registry.js';
import { isTurnCancelled, turnCancelledError } from './cancellation.js';
import { type ConversationItem, type GatewayHarnessTurnInput, type GatewayHarnessTurnResult, type HarnessErrorKind, type ModelStepResult, type ModelToolCall, type TokenUsage } from './model-client.js';
import { type ToolContext, type ToolDefinition, type ToolRunResult } from './tool-contract.js';
import type { ToolCategory } from '../harness/prompter.js';
import { emptyLedger, recordUsage } from './usage.js';

const DEFAULT_MAX_STEPS = 60;
const NO_PROGRESS_LIMIT = 3;
const STREAM_EVENT_INTERVAL_MS = 150;

/** The gateway loop's label is the command or the path, not the tool name,
 * so the verb table cannot see that a bash call is a command. The class is
 * the fact that can. */
function categoryForTool(tool: ToolDefinition | undefined): { category?: ToolCategory } {
  if (tool?.class === 'exec') return { category: 'run' };
  if (tool?.class === 'read') return { category: 'read' };
  if (tool?.class === 'write') return { category: 'edit' };
  if (tool?.class === 'network') return { category: 'fetch' };
  return {};
}

/** Structured classification only: a status code or an explicit kind set by
 * the model client. Message text is never pattern-matched here. */
function classifyModelError(error: unknown): { kind: HarnessErrorKind; retryAfter?: number } {
  const record = (error ?? {}) as { kind?: unknown; errorKind?: unknown; statusCode?: unknown; status?: unknown; response?: { status?: unknown }; retryAfter?: unknown };
  const retryAfter = typeof record.retryAfter === 'number' && Number.isFinite(record.retryAfter) ? record.retryAfter : undefined;
  const explicit = record.errorKind ?? record.kind;
  if (explicit === 'quota' || explicit === 'auth') return { kind: explicit, ...(retryAfter !== undefined ? { retryAfter } : {}) };
  const status = Number(record.statusCode ?? record.status ?? record.response?.status);
  if (status === 401 || status === 403) return { kind: 'auth' };
  if (status === 402 || status === 429) return { kind: 'quota', ...(retryAfter !== undefined ? { retryAfter } : {}) };
  return { kind: 'other', ...(retryAfter !== undefined ? { retryAfter } : {}) };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Rejects as soon as the signal fires, even if `work` ignores it. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { work.catch(() => undefined); return Promise.reject(turnCancelledError()); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { work.catch(() => undefined); reject(turnCancelledError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(signal.aborted ? turnCancelledError() : error); },
    );
  });
}

interface CallOutcome { call: ModelToolCall; result: ToolRunResult }

export async function runGatewayHarnessTurn(input: GatewayHarnessTurnInput): Promise<GatewayHarnessTurnResult> {
  const signal = input.signal;
  const throwIfAborted = (): void => { if (signal?.aborted) throw turnCancelledError(); };
  throwIfAborted();

  const cwd = path.resolve(input.cwd);
  const addDirs = (input.addDirs ?? []).map((dir) => path.resolve(cwd, dir));
  const homeDir = input.homeDir ?? os.homedir();
  const scope: PathScope = { cwd, addDirs, stateDir: input.stateDir, homeDir };
  const turnId = newTurnId();
  const session = sessionState(input.stateDir, input.sessionId);
  if (input.planMode !== undefined) session.plan = { active: input.planMode };
  const checkpoints = new FileCheckpointStore(input.stateDir);
  const store = new ConversationStore(input.stateDir, input.sessionId);
  const tools = mergeTools(input.tools ?? defaultTools(), input.extraTools);
  const maxSteps = Math.max(1, Math.floor(input.maxSteps ?? DEFAULT_MAX_STEPS));

  const [loaded, rules, baseSystem] = await abortable(Promise.all([
    store.load(),
    loadPermissionRules(cwd),
    buildSystemPrompt({ cwd, addDirs, userConfigDir: input.userConfigDir ?? input.stateDir }),
  ]), signal);
  let items: ConversationItem[] = loaded;
  const append = async (...added: ConversationItem[]): Promise<void> => { items.push(...added); await store.append(...added); };

  const imageNote = input.images?.length ? `\n\n[Attached image files: ${input.images.join(', ')}]` : '';
  await append({ type: 'text', role: 'user', text: `${input.prompt}${imageNote}` });

  // Steering: text typed mid-turn is queued and lands before the next model step.
  const steerQueue: string[] = [];
  let steerOpen = true;
  input.onSteerReady?.(async (text: string) => {
    if (!steerOpen) throw new Error('The turn has already finished');
    if (text.trim()) steerQueue.push(text);
  });

  let ledger = emptyLedger();
  let lastStepUsage: TokenUsage | undefined;
  let itemsAtLastUsage = items.length;
  let contextWindow = input.contextWindow;
  let servedModel: string | undefined;
  const segments: string[] = [];
  let needsSeparator = false;
  let steps = 0;
  let approvalChain: Promise<unknown> = Promise.resolve();
  const failures = new Map<string, number>();
  let stalledCall: ModelToolCall | undefined;

  const toolContext = (callId: string, emitOutput: (chunk: string) => void): ToolContext => ({
    cwd, addDirs, sessionId: input.sessionId, turnId, stateDir: input.stateDir, homeDir, signal, checkpoints, session, callId, emitOutput,
    ...(input.onPlan ? { onPlan: input.onPlan } : {}), ...(input.net ? { net: input.net } : {}),
  });

  const executeCall = async (call: ModelToolCall, rulesNow: PermissionRules): Promise<ToolRunResult> => {
    const tool: ToolDefinition | undefined = tools.find((candidate) => candidate.name === call.name);
    let label = call.name;
    if (tool) { try { label = tool.label(call.args); } catch { /* invalid args: fall back to the name */ } }
    const category = categoryForTool(tool);
    input.onActivity?.({ kind: 'tool-start', label, id: call.id, ...category });
    const finish = (result: ToolRunResult): ToolRunResult => {
      const output = eventOutputPreview(result.output);
      input.onActivity?.({
        kind: result.isError ? 'tool-error' : 'tool-done', label, id: call.id, ...category,
        ...(output ? { output } : {}), ...(result.diff ? { diff: result.diff } : {}),
      });
      return { ...result, output: capHeadTail(result.output).text };
    };
    if (!tool) {
      return finish({ output: `Unknown tool "${call.name}". Available tools: ${visibleTools(tools, session.plan.active).map((entry) => entry.name).join(', ')}.`, isError: true });
    }
    const problems = validateAgainstSchema(call.args, tool.parameters);
    if (problems.length) {
      return finish({ output: `Invalid arguments for ${tool.name}:\n- ${problems.join('\n- ')}\nExpected schema: ${JSON.stringify(tool.parameters)}\nFix the arguments and call the tool again.`, isError: true });
    }
    const hookInfo = { sessionId: input.sessionId, cwd };
    const veto = await abortable(Promise.resolve(input.hooks?.preToolUse?.(call, hookInfo)), signal);
    if (veto && typeof veto.deny === 'string') return finish({ output: `Blocked by a hook: ${veto.deny}`, isError: true });

    let streamed = '';
    let lastEmit = 0;
    const ctx = toolContext(call.id, (chunk) => {
      streamed = `${streamed}${chunk}`.slice(-8000);
      const now = Date.now();
      if (now - lastEmit < STREAM_EVENT_INTERVAL_MS) return;
      lastEmit = now;
      const output = eventOutputPreview(streamed);
      if (output) input.onActivity?.({ kind: 'tool-start', label, id: call.id, output, ...category });
    });

    const verdict = decidePermission({ tool, args: call.args, mode: input.permissionMode, rules: rulesNow, planMode: session.plan.active, scope, hasApprover: !!input.onApproval });
    if (verdict.decision === 'deny') return finish({ output: `Permission denied: ${verdict.reason}. Do not retry this call; choose another approach or tell the user what you need.`, isError: true });
    if (verdict.decision === 'ask') {
      // One prompt at a time: parallel reads must not stack dialogs.
      // The rule this call could be answered with once and for all, e.g.
      // `Bash(npm test:*)`. Absent where no honest rule can be formed -- a
      // compound shell line, or a tool with no path or host to key on -- and
      // the approver then simply does not offer "always".
      const rule = suggestPermissionRule(tool, call.args, scope);
      const ask = approvalChain.then(async () => {
        throwIfAborted();
        const prompt = await buildApprovalPrompt(tool, call.args, ctx, verdict.reason);
        input.onPhase?.('waiting for approval');
        return input.onApproval!(prompt.title, prompt.detail, rule);
      });
      approvalChain = ask.catch(() => undefined);
      const approved = await abortable(ask, signal);
      if (!approved) return finish({ output: 'The user declined this action. Do not retry it; ask what they would prefer or take a different approach.', isError: true });
      // Persisted BEFORE the tool runs, so a rule the user just agreed to is
      // already in force if this same call asks again -- and a failed write
      // only costs the remembering, never the approval they already gave.
      if (approved === 'always' && rule) {
        rulesNow = await addPermissionAllowRule(ctx.cwd, rule).catch(() => rulesNow);
      }
    }

    const wasPlanning = session.plan.active;
    input.onPhase?.('running tools');
    let result: ToolRunResult;
    try {
      result = await abortable(tool.run(call.args, ctx), signal);
    } catch (error) {
      if (isTurnCancelled(error) || signal?.aborted) throw turnCancelledError();
      result = { output: error instanceof Error ? error.message : String(error), isError: true };
    }
    if (wasPlanning && !session.plan.active) input.onPlanModeExit?.(session.plan.approvedPlan ?? '');
    const rewritten = await abortable(Promise.resolve(input.hooks?.postToolUse?.(call, result, hookInfo)), signal);
    if (rewritten && typeof rewritten.output === 'string') result = { ...result, output: rewritten.output };
    return finish(result);
  };

  /** Consecutive read-class calls run together; everything else runs alone,
   * in the order the model asked, so a read after a write sees the write. */
  const executeCalls = async (calls: readonly ModelToolCall[], collected: CallOutcome[]): Promise<void> => {
    const isRead = (call: ModelToolCall): boolean => tools.find((tool) => tool.name === call.name)?.class === 'read';
    for (let index = 0; index < calls.length;) {
      throwIfAborted();
      let end = index + 1;
      if (isRead(calls[index])) while (end < calls.length && isRead(calls[end])) end++;
      const batch = calls.slice(index, end);
      const settled = await Promise.allSettled(batch.map((call) => executeCall(call, rules)));
      let failure: unknown;
      settled.forEach((entry, offset) => {
        if (entry.status === 'fulfilled') collected.push({ call: batch[offset], result: entry.value });
        else failure ??= entry.reason;
      });
      if (failure !== undefined) throw failure;
      index = end;
    }
  };

  const result = (extra: Partial<GatewayHarnessTurnResult> & Pick<GatewayHarnessTurnResult, 'stopReason'>): GatewayHarnessTurnResult => ({
    text: segments.join('\n\n').trim(), nativeSessionId: input.sessionId, usage: ledger.total, steps, ...extra,
  });

  try {
    for (;;) {
      throwIfAborted();
      if (steerQueue.length) await append(...steerQueue.splice(0).map((text): ConversationItem => ({ type: 'text', role: 'user', text })));

      const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
      const system = session.plan.active ? `${baseSystem}\n\n${PLAN_MODE_INSTRUCTIONS}` : baseSystem;
      if (shouldCompact(estimateContextTokens(system, items, lastStepUsage, items.slice(itemsAtLastUsage)), window)) {
        input.onPhase?.('compacting context');
        const compacted = await abortable(compactConversation({ items, modelClient: input.modelClient, signal, system, targetTokens: window * COMPACTION_THRESHOLD * 0.75 }), signal);
        if (compacted.stage !== 'none') {
          items = compacted.items;
          lastStepUsage = undefined;
          if (compacted.stage === 'summarized') await store.appendCompaction(compacted.summary!, compacted.kept!);
          if (compacted.usage) ledger = recordUsage(ledger, { step: steps, usage: compacted.usage });
        }
      }

      const finalOnly = stalledCall !== undefined;
      input.onPhase?.('thinking');
      let streamedThisStep = '';
      let reasoning = '';
      let step: ModelStepResult;
      try {
        step = await abortable(input.modelClient.step({
          system, items, signal,
          tools: finalOnly ? [] : toolSpecs(visibleTools(tools, session.plan.active)),
          onTextDelta: (text) => {
            if (!text || signal?.aborted) return;
            if (!streamedThisStep && needsSeparator) input.onResponseDelta?.('\n\n', 'append');
            streamedThisStep += text;
            input.onResponseDelta?.(text, 'append');
            input.onPhase?.('generating response');
          },
          onReasoningDelta: (text) => { reasoning = `${reasoning}${text}`.slice(0, 4000); },
        }), signal);
      } catch (error) {
        if (isTurnCancelled(error) || signal?.aborted) throw turnCancelledError();
        const classified = classifyModelError(error);
        const message = error instanceof Error ? error.message : String(error);
        return result({ text: message, isError: true, errorKind: classified.kind, stopReason: 'model-error', ...(classified.retryAfter !== undefined ? { retryAfter: classified.retryAfter } : {}) });
      }
      steps++;

      // A client without a delta channel still has to reach the UI.
      if (step.text && step.text.length > streamedThisStep.length && step.text.startsWith(streamedThisStep)) {
        if (!streamedThisStep && needsSeparator) input.onResponseDelta?.('\n\n', 'append');
        input.onResponseDelta?.(step.text.slice(streamedThisStep.length), 'append');
      }
      const stepText = step.text || streamedThisStep;
      if (reasoning.trim()) input.onActivity?.({ kind: 'thinking', label: reasoning.replace(/\s+/g, ' ').trim().slice(0, 140) });

      const calls = finalOnly ? [] : step.toolCalls;
      const produced: ConversationItem[] = [];
      if (stepText.trim()) { produced.push({ type: 'text', role: 'assistant', text: stepText }); segments.push(stepText.trim()); needsSeparator = true; }
      produced.push(...calls.map((call): ConversationItem => ({ type: 'tool_call', id: call.id, name: call.name, args: call.args })));
      if (produced.length) await append(...produced);

      ledger = recordUsage(ledger, { step: steps, usage: step.usage, ...(step.servedModel ? { servedModel: step.servedModel } : {}) });
      lastStepUsage = step.usage;
      itemsAtLastUsage = items.length;
      contextWindow = step.contextWindow ?? contextWindow;
      servedModel = step.servedModel ?? servedModel;
      input.onUsage?.({
        ...ledger.total,
        contextTokens: estimateContextTokens(system, items, step.usage),
        contextWindow: contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
        ...(servedModel ? { servedModel } : {}),
      });

      if (finalOnly) return result({ stopReason: 'no-progress', isError: true, errorKind: 'other' });
      if (!calls.length) {
        if (steerQueue.length) continue;
        return result({ stopReason: 'completed' });
      }

      const outcomes: CallOutcome[] = [];
      try {
        await executeCalls(calls, outcomes);
      } finally {
        // Persist whatever finished, even when the turn is being cancelled.
        const done = new Map(outcomes.map((outcome) => [outcome.call.id, outcome]));
        const resultItems = calls.flatMap((call): ConversationItem[] => {
          const outcome = done.get(call.id);
          return outcome ? [{ type: 'tool_result', id: call.id, name: call.name, output: outcome.result.output, ...(outcome.result.isError ? { isError: true } : {}) }] : [];
        });
        if (resultItems.length) await append(...resultItems).catch(() => undefined);
      }

      for (const { call, result: outcome } of outcomes) {
        const key = `${call.name}\0${stableStringify(call.args)}`;
        if (!outcome.isError) { failures.delete(key); continue; }
        const count = (failures.get(key) ?? 0) + 1;
        failures.set(key, count);
        if (count >= NO_PROGRESS_LIMIT) stalledCall ??= call;
      }
      if (stalledCall) {
        await append({ type: 'text', role: 'user', text: `[harness] The call ${stalledCall.name}(${JSON.stringify(stalledCall.args).slice(0, 400)}) has now failed ${NO_PROGRESS_LIMIT} times with identical arguments. Repeating it will not work. Tools are disabled for this reply: explain to the user what you were trying to do, what is failing, and what you need from them.` });
        continue;
      }

      if (steps >= maxSteps) {
        const note = `[Stopped after ${maxSteps} steps without finishing. Send another message to continue.]`;
        input.onResponseDelta?.(`${needsSeparator ? '\n\n' : ''}${note}`, 'append');
        segments.push(note);
        await append({ type: 'text', role: 'assistant', text: note });
        return result({ stopReason: 'max-steps' });
      }
    }
  } finally {
    steerOpen = false;
    input.onSteerReady?.(undefined);
    await checkpoints.prune(input.sessionId).catch(() => undefined);
  }
}
