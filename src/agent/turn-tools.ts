/** Running a step's tool calls: validation, hooks, the permission decision and
 * its approval, the tool itself under the turn's abort, and the results' record. */
import { toolOutputCap } from './context.js';
import { claudeToolName } from './hooks.js';
import { addPermissionAllowRule, buildApprovalPrompt, decidePermission, parsePermissionRules, suggestPermissionRule, visibleTools } from './permissions.js';
import { validateAgainstSchema } from './schema-validate.js';
import { capHeadTail, eventOutputPreview } from './security.js';
import { sessionState } from './session-state.js';
import { isTurnCancelled, turnCancelledError } from './cancellation.js';
import type { ConversationItem, AgentTurnInput, AgentTurnResult, ModelToolCall } from './model-client.js';
import type { SubagentCall, ToolContext, ToolDefinition, ToolRunResult } from './tool-contract.js';
import { recordUsage } from './usage.js';
import { createSubagentRunner } from './subagent.js';
import { STALL_LIMIT } from './stall.js';
import type { AiHarnessPermissionMode } from '../harness/definition.js';
import type { ApprovalPreview } from '../tui/render/approval-block.js';
import { abortable, type CallOutcome, SHELL_TOOLS, stableStringify, categoryForTool } from './turn-support.js';
import { releaseHeldSteers, steerAlert, type TurnRuntime } from './turn-runtime.js';

const STREAM_EVENT_INTERVAL_MS = 150;

/** Builds what a turn's tool calls run with: its sub-agent runner and approval queue. */
export function createToolRunner(rt: TurnRuntime, runTurn: (input: AgentTurnInput) => Promise<AgentTurnResult>) {
  const { input, signal, cwd, addDirs, tools, session, scope, turnRules } = rt;
  let approvalChain: Promise<unknown> = Promise.resolve();
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
    parent: { ...input, contextProfile: rt.profile.name, permissionRules: turnRules }, tools, runTurn,
    checkpoint: { sessionId: input.sessionId, turnId: rt.turnId }, workSystem: rt.baseSystem,
    ...(onApproval ? { approve: (title: string, detail?: string, rule?: string, preview?: ApprovalPreview) => queueApproval(() => onApproval(title, detail, rule, preview)) } : {}),
    // A sub-agent's spend is this turn's spend: it lands in the same ledger
    // and is reported as it happens, not when the task returns.
    onUsage: (delta) => {
      rt.ledger = recordUsage(rt.ledger, delta);
      input.onUsage?.({ ...rt.ledger.total, ...rt.lastContext });
    },
  });
  const runSubagent = innerSubagent;
  const backgroundSignal = signal ? AbortSignal.any([signal, rt.backgroundStop.signal]) : rt.backgroundStop.signal;

  const toolContext = (callId: string, toolName: string, emitOutput: (chunk: string) => void): ToolContext => ({
    cwd, addDirs,
    // A coding child shares its parent's background shell lifecycle. A shell
    // it starts can keep running after the child finishes; the parent hears
    // its exit and can read or stop it on the next step or turn.
    sessionId: input.subagent?.checkpoint && SHELL_TOOLS.has(toolName) ? input.subagent.checkpoint.sessionId : input.sessionId,
    turnId: input.subagent?.checkpoint && SHELL_TOOLS.has(toolName) ? input.subagent.checkpoint.turnId : rt.turnId,
    stateDir: input.stateDir, homeDir: rt.homeDir, signal, checkpoints: rt.checkpoints,
    session: input.subagent?.checkpoint && SHELL_TOOLS.has(toolName) ? sessionState(input.stateDir, input.subagent.checkpoint.sessionId) : session,
    callId, emitOutput,
    ...(input.subagent?.checkpoint ? { checkpoint: input.subagent.checkpoint } : {}),
    outputCap: toolOutputCap(rt.contextWindow, rt.profile.toolOutputBytes),
    ...(rt.stepAcceptsImages ? { acceptsImages: true } : {}),
    ...(input.onPlan ? { onPlan: input.onPlan } : {}), ...(input.net ? { net: input.net } : {}),
    ...(input.sandbox === 'workspace' ? { sandbox: input.sandbox } : {}),
    ...(runSubagent ? { runSubagent: (request: SubagentCall) => runSubagent({
      ...request, callId, ...(request.background ? { signal: backgroundSignal } : signal ? { signal } : {}),
      // A foreground sub-agent is steerable while its call is open (turn-runtime.ts).
      ...(request.background ? {} : { onSteerReady: (handler?: (text: string) => Promise<void>) => { if (handler) rt.foregroundSteers.set(callId, handler); else rt.foregroundSteers.delete(callId); } }),
    }) } : {}),
    ...(rt.backgroundAgents ? { agents: rt.backgroundAgents } : {}),
  });

  /** The permission decision for a call and, when it asks, the user's answer.
   * A refusal comes back as the result the model hears; undefined lets the call run. */
  const authorize = async (call: ModelToolCall, tool: ToolDefinition, ctx: ToolContext): Promise<ToolRunResult | undefined> => {
    const verdict = decidePermission({ tool, args: call.args, mode: await permissionModeNow(), rules: turnRules.current, planMode: session.plan.active, scope, hasApprover: !!input.onApproval });
    if (verdict.decision === 'deny') {
      if (verdict.invalidArguments) return { output: `Invalid arguments: ${verdict.reason}. Correct the call and try again.`, isError: true };
      return { output: `Permission denied: ${verdict.reason}. Do not retry this call; choose another approach or tell the user what you need.`, isError: true };
    }
    if (verdict.decision === 'ask') {
      // The rule this call could be answered with once and for all, e.g.
      // `Bash(npm test:*)`. Absent where no honest rule can be formed -- a
      // compound shell line, or a tool with no path or host to key on -- and
      // the approver then simply does not offer "always".
      const rule = suggestPermissionRule(tool, call.args, scope);
      const ask = queueApproval(async () => {
        rt.throwIfAborted();
        // Queued behind another approval while the user switched modes: judge it
        // again now, so a switch to bypass stops the prompts that were waiting.
        const now = decidePermission({ tool, args: call.args, mode: await permissionModeNow(), rules: turnRules.current, planMode: session.plan.active, scope, hasApprover: true });
        if (now.decision === 'allow') return true;
        const prompt = await buildApprovalPrompt(tool, call.args, ctx, verdict.reason);
        input.onPhase?.('waiting for approval');
        rt.notifyHook(`ClikCode needs your permission to use ${claudeToolName(tool.name)}`, 'permission_prompt');
        return input.onApproval!(prompt.title, prompt.detail, rule, prompt.diff ? { diff: prompt.diff } : undefined);
      });
      const approved = await abortable(ask, signal);
      if (!approved) return { output: 'This action was not approved: the user declined it, or no one was available to answer (an unattended run). Do not retry it; say what you could not do, and ask what they would prefer or take a different approach.', isError: true };
      // Persisted BEFORE the tool runs, so a rule the user just agreed to is
      // already in force if this same call asks again -- and a failed write
      // only costs the remembering, never the approval they already gave.
      if (approved === 'always' && rule) {
        turnRules.current = { ...turnRules.current, allow: await addPermissionAllowRule(ctx.cwd, rule).catch(() => [...turnRules.current.allow, ...parsePermissionRules([rule]).allow]) };
      }
    }
    return undefined;
  };

  /** Runs the tool under the turn's abort, with the plan-mode events and the PostToolUse hook. */
  const runTool = async (call: ModelToolCall, tool: ToolDefinition, ctx: ToolContext, started: () => void): Promise<ToolRunResult> => {
    const wasPlanning = session.plan.active;
    input.onPhase?.('running tools');
    let result: ToolRunResult;
    started();
    rt.callsOpen++;
    const alert = steerAlert(rt);
    ctx.steerSignal = alert.signal;
    try {
      result = await abortable(tool.run(call.args, ctx), signal);
    } catch (error) {
      if (isTurnCancelled(error) || signal?.aborted) throw turnCancelledError();
      result = { output: error instanceof Error ? error.message : String(error), isError: true };
    } finally {
      alert.dispose();
      rt.callsOpen--;
    }
    if (rt.callsOpen === 0) await releaseHeldSteers(rt);
    if (wasPlanning && !session.plan.active) input.onPlanModeExit?.(session.plan.approvedPlan ?? '');
    if (!wasPlanning && session.plan.active) input.onPlanModeEnter?.();
    const rewritten = await abortable(Promise.resolve(input.hooks?.postToolUse?.(call, result, rt.turnHookInfo)), signal);
    if (rewritten && typeof rewritten.output === 'string') result = { ...result, output: rewritten.output };
    return result;
  };

  const executeCall = async (call: ModelToolCall): Promise<ToolRunResult> => {
    const tool: ToolDefinition | undefined = tools.find((candidate) => candidate.name === call.name);
    let label = call.name;
    if (tool) { try { label = tool.label(call.args); } catch { /* invalid args: fall back to the name */ } }
    const category = categoryForTool(tool, call.args && typeof call.args === 'object' ? call.args as Record<string, unknown> : undefined);
    // Already on screen as it was written, under this label: not again.
    if (rt.shownCalls.get(call.id) !== label) input.onActivity?.({ kind: 'tool-start', label, id: call.id, ...category });
    let startedAt: number | undefined;
    const finish = (result: ToolRunResult): ToolRunResult => {
      const output = eventOutputPreview(result.output);
      // A background agent's call returns at launch; its row is the agent's, and
      // settles when the agent does, not as a one-off command.
      if (result.continuesAs && rt.backgroundAgents) {
        rt.backgroundAgents.whenEnded(result.continuesAs, (ended) => input.onActivity?.({
          kind: ended?.isError ? 'tool-error' : 'tool-done', label, id: call.id, ...category,
          ...(ended ? eventOutputPreview(ended.output) : {}),
          ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
        }));
        return { ...result, output: capHeadTail(result.output, toolOutputCap(rt.contextWindow, rt.profile.toolOutputBytes), 'narrow the request to see the middle').text };
      }
      input.onActivity?.({
        kind: result.isError ? 'tool-error' : 'tool-done', label, id: call.id, ...category,
        ...output, ...(result.diff ? { diff: result.diff } : {}),
        ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      });
      return { ...result, output: capHeadTail(result.output, toolOutputCap(rt.contextWindow, rt.profile.toolOutputBytes), 'narrow the request to see the middle').text };
    };
    if (!tool) {
      return finish({ output: `Unknown tool "${call.name}". Available tools: ${visibleTools(rt.advertised(rt.items), session.plan.active).map((entry) => entry.name).join(', ')}.`, isError: true });
    }
    if (call.argumentsError) {
      return finish({ output: `The arguments for ${tool.name} were not a valid JSON object (${call.argumentsError}). Call the tool again with a single JSON object.`, isError: true });
    }
    const problems = validateAgainstSchema(call.args, tool.parameters);
    if (problems.length) {
      return finish({ output: `Invalid arguments for ${tool.name}:\n- ${problems.join('\n- ')}\nExpected schema: ${JSON.stringify(tool.parameters)}\nFix the arguments and call the tool again.`, isError: true });
    }
    const veto = await abortable(Promise.resolve(input.hooks?.preToolUse?.(call, rt.turnHookInfo)), signal);
    if (veto && typeof veto.deny === 'string') return finish({ output: `Blocked by a hook: ${veto.deny}`, isError: true });

    let streamed = '';
    let lastEmit = 0;
    const ctx = toolContext(call.id, tool.name, (chunk) => {
      streamed = `${streamed}${chunk}`.slice(-8000);
      const now = Date.now();
      if (now - lastEmit < STREAM_EVENT_INTERVAL_MS) return;
      lastEmit = now;
      const output = eventOutputPreview(streamed);
      if (output) input.onActivity?.({ kind: 'tool-start', label, id: call.id, ...output, ...category });
    });
    const refusal = await authorize(call, tool, ctx);
    if (refusal) return finish(refusal);
    return finish(await runTool(call, tool, ctx, () => { startedAt = Date.now(); }));
  };

  /** Consecutive read-class calls (and calls whose tool says they touch
   * nothing the others see) run together; everything else runs alone, in the
   * order the model asked, so a read after a write sees the write. */
  const executeCalls = async (calls: readonly ModelToolCall[], collected: CallOutcome[]): Promise<void> => {
    const isRead = (call: ModelToolCall): boolean => {
      const tool = tools.find((candidate) => candidate.name === call.name);
      if (!tool) return false;
      if (tool.class === 'read') return true;
      try { return tool.concurrent?.(call.args) === true; } catch { return false; }
    };
    for (let index = 0; index < calls.length;) {
      rt.throwIfAborted();
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

  return { executeCalls };
}

export type ToolRunner = ReturnType<typeof createToolRunner>;

/** Runs a step's calls and records their results. A result ends the turn
 * (ask_user put a question to the user); undefined goes on to the next step. */
export async function runToolCalls(rt: TurnRuntime, runner: ToolRunner, calls: readonly ModelToolCall[]): Promise<AgentTurnResult | undefined> {
  const { input, session, tools } = rt;
  const outcomes: CallOutcome[] = [];
  try {
    await runner.executeCalls(calls, outcomes);
  } finally {
    // Persist whatever finished, even when the turn is being cancelled.
    const done = new Map(outcomes.map((outcome) => [outcome.call.id, outcome]));
    const resultItems = calls.flatMap((call): ConversationItem[] => {
      const outcome = done.get(call.id);
      return outcome ? [{ type: 'tool_result', id: call.id, name: call.name, output: outcome.result.output, ...(outcome.result.isError ? { isError: true } : {}), ...(outcome.result.images?.length ? { images: outcome.result.images } : {}) }] : [];
    });
    // A result that is not on disk reads, on resume, as a call that never
    // finished (repairDanglingCalls), though it ran. One retry covers a
    // transient write error; past that the turn fails rather than carry
    // on with memory and disk disagreeing. This replaces a cancel's error
    // too: the lost results are the more important thing to report.
    if (resultItems.length) {
      rt.items.push(...resultItems);
      await rt.store.append(...resultItems).catch(() => rt.store.append(...resultItems)).catch((error: unknown) => {
        throw new Error(`could not save the results of ${resultItems.length} tool call(s) to the conversation: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      });
    }
  }

  // ask_user put a question to the user: the turn ends on it, and their
  // next message is the answer.
  if (!input.subagent && session.pendingQuestion) {
    const question = session.pendingQuestion;
    session.pendingQuestion = undefined;
    input.onResponseDelta?.(`${rt.needsSeparator ? '\n\n' : ''}${question}`, 'append');
    rt.segments.push(question);
    await rt.append({ type: 'text', role: 'assistant', text: question });
    rt.notifyHook(question, 'idle_prompt');
    return rt.result({ stopReason: 'completed' });
  }

  for (const { call, result: outcome } of outcomes) {
    const toolClass = tools.find((candidate) => candidate.name === call.name)?.class;
    const stalled = rt.stall.record(`${call.name}\0${stableStringify(call.args)}`, {
      failed: Boolean(outcome.isError),
      mayChangeState: toolClass === 'write' || toolClass === 'exec',
    });
    if (stalled) rt.stalledCall ??= call;
  }
  if (rt.stalledCall) {
    await rt.append({ type: 'text', role: 'user', text: `[harness] The call ${rt.stalledCall.name}(${JSON.stringify(rt.stalledCall.args).slice(0, 400)}) has now failed ${STALL_LIMIT} times in a row with identical arguments and nothing changed in between. Repeating it will not work. Tools are disabled for this reply: explain to the user what you were trying to do, what is failing, and what you need from them.` });
  }
  return undefined;
}
