/** The gateway harness agent loop: model step → tool calls → results →
 * repeat, emitting the same normalized events as the vendor transports. */
import os from 'node:os';
import path from 'node:path';
import { ConversationStore, memoryConversationStore } from './conversation.js';
import { buildSystemPrompt, compactConversation, environmentNote, needsEnvironmentNote, DEFAULT_CONTEXT_WINDOW, estimateContextTokens, PLAN_MODE_INSTRUCTIONS, shouldCompact, compactionThreshold, toolOutputCap } from './context.js';
import { FileCheckpointStore, newTurnId } from './file-checkpoints.js';
import { addPermissionAllowRule, buildApprovalPrompt, decidePermission, loadPermissionRules, parsePermissionRules, suggestPermissionRule, visibleTools } from './permissions.js';
import { validateAgainstSchema } from './schema-validate.js';
import { capHeadTail, eventOutputPreview, type PathScope } from './security.js';
import { formatShellNotifications, sessionState, takeShellNotifications } from './session-state.js';
import { discoverSkills, SKILL_TOOL, skillsPromptSection } from './skills.js';
import { defaultTools, mergeTools, toolSpecs } from './tools/registry.js';
import { exposeTools } from './mcp/deferred.js';
import { gateNotebookTool, workspaceHasNotebooks } from './tools/notebook-gate.js';
import { isTurnCancelled, turnCancelledError } from './cancellation.js';
import { type ConversationItem, type GatewayHarnessTurnInput, type GatewayHarnessTurnResult, type HarnessErrorKind, type ModelStepResult, type ModelToolCall, type TokenUsage } from './model-client.js';
import { type ToolContext, type ToolDefinition, type ToolRunResult } from './tool-contract.js';
import type { ToolCategory } from '../harness/prompter.js';
import { thoughtLabel } from '../harness/protocol/activity-events.js';
import { emptyLedger, recordUsage } from './usage.js';
import { resolveContextProfile } from './context-profile.js';
import { readImageInputs } from './images.js';
import { createSubagentRunner } from './subagent.js';
import { completedArguments } from './models/openai-client.js';
import { TASK_TOOL_NAME } from './tools/task.js';
import { categoryOf, GATEWAY_HARNESS_COMMAND } from '../harness/protocol/tools.js';
import type { AiHarnessPermissionMode } from '../harness/definition.js';

const DEFAULT_MAX_STEPS = 60;
/** Retries of one model step that failed before saying anything. */
const MAX_STEP_RETRIES = 2;
const STEP_RETRY_CAP_SECONDS = 30;
const NO_PROGRESS_LIMIT = 3;
const STREAM_EVENT_INTERVAL_MS = 150;
/** Times one turn goes on with an answer the output limit cut off, as a
 * vendor CLI does, before it stops and says the answer was cut. */
const MAX_LENGTH_CONTINUES = 3;
const CONTINUE_AFTER_LENGTH = '[harness] Your last reply reached the output limit and was cut off. Continue exactly where it stopped, without repeating anything already written.';

/** A tool's class, for one the shared classifier cannot name (an MCP
 * server's, a skill). */
const CLASS_CATEGORY: Partial<Record<ToolDefinition['class'], ToolCategory>> = { exec: 'run', read: 'read', write: 'edit', network: 'fetch' };

/** The gateway loop's row category: the tool's own name through the classifier
 * every harness's rows go through (so grep reads as a search here too), else
 * its class. The label is the command or the path, so it is never used. */
function categoryForTool(tool: ToolDefinition | undefined, args?: Record<string, unknown>): { category?: ToolCategory; agent?: boolean } {
  // The turn is waiting on a sub-agent, which the UI shows as an agent row.
  if (!tool) return {};
  if (tool.name === TASK_TOOL_NAME) return { agent: true };
  const named = categoryOf(tool.name, args, GATEWAY_HARNESS_COMMAND);
  if (named.category) return named;
  const category = CLASS_CATEGORY[tool.class];
  return category ? { category } : {};
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

/** Codes the Gateway sends for a step that is worth sending again as it is:
 * its own words for these are "Please retry" (turn-stream.ts). */
const RETRYABLE_STEP_CODES = new Set(['MODEL_ERROR', 'INTERNAL_ERROR', 'MODEL_RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'incomplete_stream']);

/** How many times Stop hooks may send the agent back to work in one turn. */
const MAX_STOP_HOOK_CONTINUES = 3;

/** What to do about a model step that failed before streaming anything.
 * `compact`: the request did not fit the model (the Gateway's
 * CONTEXT_TOO_LARGE, "Compact and retry"). `retry`: a transient failure --
 * a retryable code, a 5xx, or no response at all. Everything else -- credit,
 * sign-in, a rejected request, no model, the kill switch -- is the answer. */
export function stepRecovery(error: unknown): 'compact' | 'retry' | undefined {
  const record = (error ?? {}) as { code?: unknown; statusCode?: unknown; kind?: unknown };
  const code = typeof record.code === 'string' ? record.code : undefined;
  if (code === 'CONTEXT_TOO_LARGE') return 'compact';
  if (code && RETRYABLE_STEP_CODES.has(code)) return 'retry';
  if (code) return undefined;
  const status = typeof record.statusCode === 'number' ? record.statusCode : undefined;
  if (status === undefined) return record.kind === 'other' ? 'retry' : undefined;
  return status >= 500 && status !== 501 ? 'retry' : undefined;
}

/** Waits, unless the turn is cancelled first. */
function pause(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(turnCancelledError()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, seconds * 1000);
    const onAbort = (): void => { clearTimeout(timer); reject(turnCancelledError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

/** Results are matched back to calls by id, and the model APIs reject a
 * repeated one, so a step that reuses an id (or sends none) gets distinct ones. */
function withUniqueIds(calls: readonly ModelToolCall[]): ModelToolCall[] {
  const seen = new Set<string>();
  return calls.map((call, index) => {
    let id = call.id || `call_${index}`;
    for (let n = 2; seen.has(id); n++) id = `${call.id || 'call'}_${n}`;
    seen.add(id);
    return id === call.id ? call : { ...call, id };
  });
}

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
  const store = input.subagent ? memoryConversationStore(input.subagent.transcript) : new ConversationStore(input.stateDir, input.sessionId);
  // Decided from facts fixed for the session (the model's window and speed,
  // or a forced choice), so every turn sends the same prompt prefix.
  const profile = resolveContextProfile({
    hints: { ...input.modelClient.contextHints, contextWindow: input.modelClient.contextHints?.contextWindow ?? input.contextWindow },
    session: input.contextProfile,
  });
  const exposure = exposeTools(mergeTools(input.tools ?? defaultTools(), input.extraTools), profile.mcpEagerSchemaTokens);
  const swarmTaskNote = input.swarmModelNote
    ? ` ${input.swarmModelNote}`
    : ' If this conversation has a swarm on, pass one model id from the swarm list, exactly. Those are the models on accounts that still have usage. Do not invent a model. Match the index to the task and prefer a cheaper model when a lower index is enough. You get one subagent row and a short card, not that model\'s conversation.';
  const tools = input.swarmDelegate
    ? exposure.all.map((tool) => tool.name === TASK_TOOL_NAME ? { ...tool, description: `${tool.description}${swarmTaskNote}` } : tool)
    : exposure.all;
  const maxSteps = Math.max(1, Math.floor(input.maxSteps ?? DEFAULT_MAX_STEPS));

  const [loaded, savedRules, baseSystem, notebooksOnDisk] = await abortable(Promise.all([
    store.load(),
    input.permissionRules ? Promise.resolve(input.permissionRules.current) : loadPermissionRules(cwd),
    // A sub-agent keeps its own short prompt. Skills are listed only when the
    // tool that loads them is present.
    input.subagent ? input.subagent.system
      : (tools.some((tool) => tool.name === SKILL_TOOL) ? discoverSkills({ cwd, stateDir: input.stateDir, homeDir, turnId }) : Promise.resolve({ skills: [] }))
        .then((catalog) => buildSystemPrompt({
          cwd, addDirs, userConfigDir: input.userConfigDir ?? input.stateDir,
          skillsSection: skillsPromptSection(catalog.skills, profile), toolUsageGuidance: profile.toolUsageGuidance,
        })),
    workspaceHasNotebooks([cwd, ...addDirs]),
  ]), signal);
  // What the model is offered this step (tools/notebook-gate.ts).
  const advertised = (current: readonly ConversationItem[]): ToolDefinition[] => gateNotebookTool(exposure.advertised(current), current, notebooksOnDisk);
  // One rule set for the whole turn, its sub-agents included: an "always"
  // answered for one call already covers the calls queued behind it.
  const turnRules = input.permissionRules ?? { current: savedRules };
  let items: ConversationItem[] = loaded;
  const append = async (...added: ConversationItem[]): Promise<void> => { items.push(...added); await store.append(...added); };

  const imageNote = input.images?.length ? `\n\n[Attached image files: ${input.images.join(', ')}]` : '';
  // The note stays even when the pixels go too: it tells the model the file
  // names, and a later client that cannot see images still has it.
  const images = input.images?.length && input.modelClient.acceptsImages ? await abortable(readImageInputs(input.images), signal) : [];
  // Date and git state ride on the user message, not the system prompt, so
  // the prompt prefix stays cacheable across turns (context.ts). A sub-agent
  // lives for one task and its short prompt already carries the date.
  const environment = !input.subagent && needsEnvironmentNote(items) ? `${await abortable(environmentNote({ cwd }), signal)}\n\n` : '';
  // The user's hooks (hooks.ts): context for a conversation's first turn, and
  // the prompt-submit hook, which may refuse the prompt or add to it. A
  // sub-agent's prompt is the parent's, already through them.
  const turnHookInfo = { sessionId: input.sessionId, cwd, ...(signal ? { signal } : {}) };
  const hookContexts: string[] = [];
  let promptBlocked: string | undefined;
  if (!input.subagent && input.hooks) {
    const firstTurn = !items.some((item) => item.type === 'text' && item.role === 'user');
    if (firstTurn && input.hooks.sessionStart) {
      const started = await abortable(Promise.resolve(input.hooks.sessionStart({ ...turnHookInfo, source: 'startup' })), signal);
      if (started?.context) hookContexts.push(started.context);
    }
    if (input.hooks.userPromptSubmit) {
      const submitted = await abortable(Promise.resolve(input.hooks.userPromptSubmit(input.prompt, turnHookInfo)), signal);
      if (submitted?.block) promptBlocked = submitted.block;
      else if (submitted?.context) hookContexts.push(submitted.context);
    }
  }
  const hookNote = hookContexts.length ? `<hook-context>\n${hookContexts.join('\n\n')}\n</hook-context>\n\n` : '';
  if (!promptBlocked) {
    await append({ type: 'text', role: 'user', text: `${environment}${hookNote}${input.prompt}${imageNote}`, ...(images.length ? { images } : {}) });
  }

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
  let stepRetries = 0;
  let compactedForSize = false;
  let lengthContinues = 0;
  /** The calls of the current step shown while they were written, by id,
   * with the label last shown. */
  const shownCalls = new Map<string, string>();
  /** The step before this one was cut off at the output limit, and this one
   * carries on its sentence: no paragraph break between them. */
  let continuesCutAnswer = false;
  let lastContext: { contextTokens?: number; contextWindow?: number; servedModel?: string; contextProfile: typeof profile.name; stopReason?: string } = { contextProfile: profile.name };

  // One prompt at a time: parallel reads, and parallel sub-agents, must not stack dialogs.
  // The mode as the user has it NOW (input.currentPermissionMode reads it back
  // from where /permissions saved it); unreadable falls back to the mode the
  // turn started with, never to a more permissive one.
  const permissionModeNow = async (): Promise<AiHarnessPermissionMode> => {
    try {
      return (await input.currentPermissionMode?.()) ?? input.permissionMode;
    } catch {
      // fail-open-ok: the turn's own starting mode is the fallback, exactly as before this lookup existed.
      return input.permissionMode;
    }
  };
  const queueApproval = <T>(ask: () => Promise<T>): Promise<T> => {
    const next = approvalChain.then(ask);
    approvalChain = next.catch(() => undefined);
    return next;
  };
  const onApproval = input.onApproval;
  const innerSubagent = input.subagent ? undefined : createSubagentRunner({
    // A sub-agent runs under its parent's profile, whatever decided it.
    parent: { ...input, contextProfile: profile.name, permissionRules: turnRules }, tools, runTurn: runGatewayHarnessTurn,
    ...(onApproval ? { approve: (title: string, detail?: string, rule?: string) => queueApproval(() => onApproval(title, detail, rule)) } : {}),
    // A sub-agent's spend is this turn's spend: it lands in the same ledger
    // and is reported as it happens, not when the task returns.
    onUsage: (delta) => {
      ledger = recordUsage(ledger, { step: steps, usage: delta });
      input.onUsage?.({ ...ledger.total, ...lastContext });
    },
  });
  // Swarm, when the conversation has one, runs the task on another provider
  // and returns a card. Null means this host's own sub-agent still does it.
  const runSubagent = innerSubagent && input.swarmDelegate
    ? async (request: { prompt: string; description?: string; callId: string; signal?: AbortSignal; model?: string }): Promise<ToolRunResult> => {
      const delegated = await input.swarmDelegate?.(request);
      if (delegated) return delegated;
      return innerSubagent(request);
    }
    : innerSubagent;

  const toolContext = (callId: string, emitOutput: (chunk: string) => void): ToolContext => ({
    cwd, addDirs, sessionId: input.sessionId, turnId, stateDir: input.stateDir, homeDir, signal, checkpoints, session, callId, emitOutput,
    outputCap: toolOutputCap(contextWindow, profile.toolOutputBytes),
    ...(input.onPlan ? { onPlan: input.onPlan } : {}), ...(input.net ? { net: input.net } : {}),
    ...(runSubagent ? { runSubagent: (request: { prompt: string; description?: string; model?: string }) => runSubagent({ ...request, callId, ...(signal ? { signal } : {}) }) } : {}),
  });

  const executeCall = async (call: ModelToolCall): Promise<ToolRunResult> => {
    const tool: ToolDefinition | undefined = tools.find((candidate) => candidate.name === call.name);
    let label = call.name;
    if (tool) { try { label = tool.label(call.args); } catch { /* invalid args: fall back to the name */ } }
    const category = categoryForTool(tool, call.args && typeof call.args === 'object' ? call.args as Record<string, unknown> : undefined);
    // Already on screen as it was written, under this label: not again.
    if (shownCalls.get(call.id) !== label) input.onActivity?.({ kind: 'tool-start', label, id: call.id, ...category });
    let startedAt: number | undefined;
    const finish = (result: ToolRunResult): ToolRunResult => {
      const output = eventOutputPreview(result.output);
      input.onActivity?.({
        kind: result.isError ? 'tool-error' : 'tool-done', label: result.activityLabel || label, id: call.id, ...category,
        ...(result.swarm ? { agent: true, swarm: result.swarm } : {}),
        ...output, ...(result.diff ? { diff: result.diff } : {}),
        ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      });
      return { ...result, output: capHeadTail(result.output, toolOutputCap(contextWindow, profile.toolOutputBytes), 'narrow the request to see the middle').text };
    };
    if (!tool) {
      return finish({ output: `Unknown tool "${call.name}". Available tools: ${visibleTools(advertised(items), session.plan.active).map((entry) => entry.name).join(', ')}.`, isError: true });
    }
    if (call.argumentsError) {
      return finish({ output: `The arguments for ${tool.name} were not a valid JSON object (${call.argumentsError}). Call the tool again with a single JSON object.`, isError: true });
    }
    const problems = validateAgainstSchema(call.args, tool.parameters);
    if (problems.length) {
      return finish({ output: `Invalid arguments for ${tool.name}:\n- ${problems.join('\n- ')}\nExpected schema: ${JSON.stringify(tool.parameters)}\nFix the arguments and call the tool again.`, isError: true });
    }
        const veto = await abortable(Promise.resolve(input.hooks?.preToolUse?.(call, turnHookInfo)), signal);
    if (veto && typeof veto.deny === 'string') return finish({ output: `Blocked by a hook: ${veto.deny}`, isError: true });

    let streamed = '';
    let lastEmit = 0;
    const ctx = toolContext(call.id, (chunk) => {
      streamed = `${streamed}${chunk}`.slice(-8000);
      const now = Date.now();
      if (now - lastEmit < STREAM_EVENT_INTERVAL_MS) return;
      lastEmit = now;
      const output = eventOutputPreview(streamed);
      if (output) input.onActivity?.({ kind: 'tool-start', label, id: call.id, ...output, ...category });
    });

    const verdict = decidePermission({ tool, args: call.args, mode: await permissionModeNow(), rules: turnRules.current, planMode: session.plan.active, scope, hasApprover: !!input.onApproval });
    if (verdict.decision === 'deny') return finish({ output: `Permission denied: ${verdict.reason}. Do not retry this call; choose another approach or tell the user what you need.`, isError: true });
    if (verdict.decision === 'ask') {
      // The rule this call could be answered with once and for all, e.g.
      // `Bash(npm test:*)`. Absent where no honest rule can be formed -- a
      // compound shell line, or a tool with no path or host to key on -- and
      // the approver then simply does not offer "always".
      const rule = suggestPermissionRule(tool, call.args, scope);
      const ask = queueApproval(async () => {
        throwIfAborted();
        // Queued behind another approval while the user switched modes: judge it
        // again now, so a switch to bypass stops the prompts that were waiting.
        const now = decidePermission({ tool, args: call.args, mode: await permissionModeNow(), rules: turnRules.current, planMode: session.plan.active, scope, hasApprover: true });
        if (now.decision === 'allow') return true;
        const prompt = await buildApprovalPrompt(tool, call.args, ctx, verdict.reason);
        input.onPhase?.('waiting for approval');
        return input.onApproval!(prompt.title, prompt.detail, rule, prompt.diff ? { diff: prompt.diff } : undefined);
      });
      const approved = await abortable(ask, signal);
      if (!approved) return finish({ output: 'The user declined this action. Do not retry it; ask what they would prefer or take a different approach.', isError: true });
      // Persisted BEFORE the tool runs, so a rule the user just agreed to is
      // already in force if this same call asks again -- and a failed write
      // only costs the remembering, never the approval they already gave.
      if (approved === 'always' && rule) {
        turnRules.current = await addPermissionAllowRule(ctx.cwd, rule).catch(() => ({ allow: [...turnRules.current.allow, ...parsePermissionRules([rule]).allow] }));
      }
    }

    const wasPlanning = session.plan.active;
    input.onPhase?.('running tools');
    let result: ToolRunResult;
    startedAt = Date.now();
    try {
      result = await abortable(tool.run(call.args, ctx), signal);
    } catch (error) {
      if (isTurnCancelled(error) || signal?.aborted) throw turnCancelledError();
      result = { output: error instanceof Error ? error.message : String(error), isError: true };
    }
    if (wasPlanning && !session.plan.active) input.onPlanModeExit?.(session.plan.approvedPlan ?? '');
    const rewritten = await abortable(Promise.resolve(input.hooks?.postToolUse?.(call, result, turnHookInfo)), signal);
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
      const settled = await Promise.allSettled(batch.map((call) => executeCall(call)));
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
    text: segments.join('\n\n').trim(), nativeSessionId: input.sessionId, usage: ledger.total, steps, contextProfile: profile.name, ...extra,
  });

  // Stop hooks may keep the agent working; bounded so two hooks cannot loop it forever.
  let stopContinues = 0;
  try {
    if (promptBlocked) {
      const note = `Your message was blocked by a UserPromptSubmit hook: ${promptBlocked}`;
      input.onResponseDelta?.(note, 'append');
      segments.push(note);
      return result({ stopReason: 'completed', isError: true, errorKind: 'other' });
    }
    /** Compacts the conversation in place; false when there was nothing to
     * compact. Saved, and its own model usage counted, like any step. */
    const compact = async (system: string, targetTokens?: number): Promise<boolean> => {
      input.onPhase?.('compacting context');
      const compacted = await abortable(compactConversation({ items, modelClient: input.modelClient, signal, system, ...(targetTokens !== undefined ? { targetTokens } : {}) }), signal);
      if (compacted.stage === 'none') return false;
      items = compacted.items;
      lastStepUsage = undefined;
      if (compacted.stage === 'summarized') await store.appendCompaction(compacted.summary!, compacted.kept!);
      if (compacted.usage) ledger = recordUsage(ledger, { step: steps, usage: compacted.usage });
      return true;
    };
    for (;;) {
      throwIfAborted();
      if (steerQueue.length) await append(...steerQueue.splice(0).map((text): ConversationItem => ({ type: 'text', role: 'user', text })));
      // Background shells that finished since the last step. The model was
      // told it would hear about them rather than poll, so it hears here.
      const finished = input.subagent ? [] : takeShellNotifications(session);
      if (finished.length) {
        for (const note of finished) input.onActivity?.({ kind: 'tool-done', label: `${note.shellId} ${note.reason ? 'stopped' : 'exited'}: ${note.command}`, id: `shell-exit-${note.shellId}`, category: 'run' });
        await append({ type: 'text', role: 'user', text: formatShellNotifications(finished) });
      }

      const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
      const system = session.plan.active ? `${baseSystem}\n\n${PLAN_MODE_INSTRUCTIONS}` : baseSystem;
      if (shouldCompact(estimateContextTokens(system, items, lastStepUsage, items.slice(itemsAtLastUsage)), window)) {
        await compact(system, compactionThreshold(window) * 0.75);
      }

      const finalOnly = stalledCall !== undefined;
      input.onPhase?.('thinking');
      let streamedThisStep = '';
      let reasoning = '';
      let step: ModelStepResult;
      /** Calls shown while they were being written, by id, with the label
       * last shown: one that never runs is settled, not left spinning. */
      shownCalls.clear();
      const settleUnrun = (ran: ReadonlySet<string>, why: string): void => {
        for (const [id, label] of shownCalls) {
          if (!ran.has(id)) input.onActivity?.({ kind: 'tool-error', label, id, output: [why] });
        }
      };
      const stepped = await abortable(Promise.resolve(input.modelClientForStep?.()), signal);
      if (stepped === 'switch') return result({ stopReason: 'account-switch' });
      const modelClient = stepped ?? input.modelClient;
      try {
        step = await abortable(modelClient.step({
          system, items, signal,
          tools: profile.shapeSpecs(toolSpecs(visibleTools(advertised(items), session.plan.active))),
          ...(finalOnly ? { toolChoice: 'none' as const } : {}),
          onTextDelta: (text) => {
            if (!text || signal?.aborted) return;
            if (!streamedThisStep && needsSeparator && !continuesCutAnswer) input.onResponseDelta?.('\n\n', 'append');
            streamedThisStep += text;
            input.onResponseDelta?.(text, 'append');
            input.onPhase?.('generating response');
          },
          // The whole thought so far, under one id per step, so each delta
          // replaces the last rather than adding a row.
          onReasoningDelta: (text) => {
            reasoning = `${reasoning}${text}`.slice(-4000);
            if (reasoning.trim()) input.onActivity?.({ kind: 'thinking', label: thoughtLabel(reasoning), id: `${turnId}:reasoning:${steps}` });
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
              if (shownCalls.get(call.id) === label) return;
              shownCalls.set(call.id, label);
              input.onActivity?.({ kind: 'tool-start', label, id: call.id, ...categoryForTool(tool, args) });
            },
          }),
          // The model the Gateway serves, on the screen from its first frame
          // rather than after the step.
          onServedModel: (model, window) => {
            servedModel = model;
            if (window) contextWindow = window;
            lastContext = { ...lastContext, servedModel: model, ...(window ? { contextWindow: window } : {}) };
            input.onUsage?.({ ...ledger.total, ...lastContext });
          },
        }), signal);
      } catch (error) {
        if (isTurnCancelled(error) || signal?.aborted) throw turnCancelledError();
        // A call being written when the step failed never runs: a resent
        // step writes its own.
        settleUnrun(new Set(), 'not run: the model\'s reply was cut off before this call was complete');
        // Once text has streamed the step belongs to what was said; sending it
        // again would say it twice. Before that, a step is safe to resend: the
        // Gateway is stateless and no tool has run.
        const recovery = streamedThisStep ? undefined : stepRecovery(error);
        if (recovery === 'compact' && !compactedForSize) {
          compactedForSize = true;
          // No size target: the Gateway measured the real model and said it
          // does not fit, which outranks this side's estimate of whether it does.
          if (await compact(system)) continue;
        }
        if (recovery === 'retry' && stepRetries < MAX_STEP_RETRIES) {
          stepRetries++;
          const after = (error as { retryAfter?: unknown }).retryAfter;
          const wait = Math.min(STEP_RETRY_CAP_SECONDS, typeof after === 'number' && after >= 0 ? after : 2 ** stepRetries);
          input.onPhase?.(`retrying in ${Math.ceil(wait)}s`);
          await pause(wait, signal);
          continue;
        }
        const classified = classifyModelError(error);
        const message = error instanceof Error ? error.message : String(error);
        return result({ text: message, isError: true, errorKind: classified.kind, stopReason: 'model-error', ...(classified.retryAfter !== undefined ? { retryAfter: classified.retryAfter } : {}) });
      }
      steps++;
      stepRetries = 0;
      compactedForSize = false;

      // A client without a delta channel still has to reach the UI.
      if (step.text && step.text.length > streamedThisStep.length && step.text.startsWith(streamedThisStep)) {
        if (!streamedThisStep && needsSeparator) input.onResponseDelta?.('\n\n', 'append');
        input.onResponseDelta?.(step.text.slice(streamedThisStep.length), 'append');
      }
      const stepText = step.text || streamedThisStep;
      if (reasoning.trim()) input.onActivity?.({ kind: 'thinking', label: thoughtLabel(reasoning), id: `${turnId}:reasoning:${steps - 1}` });

      const cutOff = step.stopReason === 'length';
      const calls = (finalOnly ? [] : withUniqueIds(step.toolCalls)).map((call) => cutOff && call.argumentsError
        // Cut off mid-call: the model hears why its JSON is incomplete, so it
        // sends a smaller call rather than the same one again.
        ? { ...call, argumentsError: `the reply reached the output limit while these arguments were being written, so they are incomplete. Make the call again with less in it, for example a large file written in several smaller edits` }
        : call);
      settleUnrun(new Set(calls.map((call) => call.id)), 'not run');
      const produced: ConversationItem[] = [];
      if (stepText.trim()) {
        produced.push({ type: 'text', role: 'assistant', text: stepText });
        if (continuesCutAnswer && segments.length) segments[segments.length - 1] = `${segments[segments.length - 1]}${stepText}`.trim();
        else segments.push(stepText.trim());
        needsSeparator = true;
      }
      continuesCutAnswer = false;
      produced.push(...calls.map((call): ConversationItem => ({ type: 'tool_call', id: call.id, name: call.name, args: call.args })));
      if (produced.length) await append(...produced);

      ledger = recordUsage(ledger, { step: steps, usage: step.usage, ...(step.servedModel ? { servedModel: step.servedModel } : {}) });
      lastStepUsage = step.usage;
      itemsAtLastUsage = items.length;
      contextWindow = step.contextWindow ?? contextWindow;
      servedModel = step.servedModel ?? servedModel;
      lastContext = {
        contextProfile: profile.name,
        contextTokens: estimateContextTokens(system, items, step.usage),
        contextWindow: contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
        ...(servedModel ? { servedModel } : {}),
        stopReason: step.stopReason,
      };
      input.onUsage?.({ ...ledger.total, ...lastContext });

      if (finalOnly) return result({ stopReason: 'no-progress', isError: true, errorKind: 'other' });
      // An answer cut off at the output limit is carried on, not taken as
      // the answer: the next step picks up mid-sentence.
      if (!calls.length && cutOff && lengthContinues < MAX_LENGTH_CONTINUES) {
        lengthContinues += 1;
        continuesCutAnswer = Boolean(stepText.trim());
        await append({ type: 'text', role: 'user', text: CONTINUE_AFTER_LENGTH });
        continue;
      }
      if (!calls.length) {
        // Steering, or a background shell that finished while this step ran:
        // one more step answers it now rather than in a follow-up turn.
        if (steerQueue.length || (!input.subagent && session.notifications.length)) continue;
        if (!input.subagent && input.hooks?.stop && stopContinues < MAX_STOP_HOOK_CONTINUES) {
          const verdict = await abortable(Promise.resolve(input.hooks.stop({ ...turnHookInfo, stopHookActive: stopContinues > 0 })), signal);
          if (verdict?.continueWith) {
            stopContinues += 1;
            await append({ type: 'text', role: 'user', text: `[Stop hook] ${verdict.continueWith}` });
            continue;
          }
        }
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
        // A result that is not on disk reads, on resume, as a call that never
        // finished (repairDanglingCalls), though it ran. One retry covers a
        // transient write error; past that the turn fails rather than carry
        // on with memory and disk disagreeing. This replaces a cancel's error
        // too: the lost results are the more important thing to report.
        if (resultItems.length) {
          items.push(...resultItems);
          await store.append(...resultItems).catch(() => store.append(...resultItems)).catch((error: unknown) => {
            throw new Error(`could not save the results of ${resultItems.length} tool call(s) to the conversation: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          });
        }
      }

      // ask_user put a question to the user: the turn ends on it, and their
      // next message is the answer.
      if (!input.subagent && session.pendingQuestion) {
        const question = session.pendingQuestion;
        session.pendingQuestion = undefined;
        input.onResponseDelta?.(`${needsSeparator ? '\n\n' : ''}${question}`, 'append');
        segments.push(question);
        await append({ type: 'text', role: 'assistant', text: question });
        return result({ stopReason: 'completed' });
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
    await checkpoints.seal(input.sessionId, turnId).catch(() => undefined);
    await checkpoints.prune(input.sessionId).catch(() => undefined);
  }
}
