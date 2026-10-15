/** The agent loop's turn: what it is given (fixed for the turn) and what it
 * changes as it goes, in one object the loop's parts all take. */
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from './conversation.js';
import { buildSystemPrompt, environmentNote, needsEnvironmentNote } from './context.js';
import { FileCheckpointStore, newTurnId } from './file-checkpoints.js';
import { loadPermissionRules } from './permissions.js';
import { type PathScope } from './security.js';
import { sessionState } from './session-state.js';
import { discoverSkills, SKILL_TOOL, skillsPromptSection } from './skills.js';
import { agentTypesPromptSection, enabledPluginAgents } from './plugins.js';
import { defaultTools, mergeTools } from './tools/registry.js';
import { exposeTools } from './mcp/deferred.js';
import { gateNotebookTool, workspaceHasNotebooks } from './tools/notebook-gate.js';
import { turnCancelledError } from './cancellation.js';
import type { ConversationItem, AgentTurnInput, AgentTurnResult, ModelToolCall, TokenUsage } from './model-client.js';
import type { ToolDefinition } from './tool-contract.js';
import { emptyLedger } from './usage.js';
import { resolveContextProfile } from './context-profile.js';
import { readImageInputs } from './images.js';
import { BackgroundAgents } from './background-agents.js';
import { StallGuard } from './stall.js';
import { TASK_TOOL_NAME } from './tools/task.js';
import { abortable } from './turn-support.js';

/** What the last step reported, carried on every usage report after it. */
export type LastContext = { contextTokens?: number; contextWindow?: number; servedModel?: string; contextProfile: ReturnType<typeof resolveContextProfile>['name']; stopReason?: string };

export interface TurnRuntime {
  readonly input: AgentTurnInput;
  readonly signal: AbortSignal | undefined;
  readonly cwd: string;
  readonly addDirs: string[];
  readonly homeDir: string;
  readonly scope: PathScope;
  readonly turnId: string;
  readonly session: ReturnType<typeof sessionState>;
  readonly checkpoints: FileCheckpointStore;
  readonly store: ConversationStore;
  readonly profile: ReturnType<typeof resolveContextProfile>;
  readonly tools: ToolDefinition[];
  readonly baseSystem: string;
  /** One rule set for the whole turn, its sub-agents included: an "always"
   * answered for one call already covers the calls queued behind it. */
  readonly turnRules: NonNullable<AgentTurnInput['permissionRules']>;
  readonly turnHookInfo: { sessionId: string; cwd: string; signal?: AbortSignal };
  /** Background coding agents belong to this turn: it does not end while one
   * runs, and whatever ends it stops them. */
  readonly backgroundAgents: BackgroundAgents | undefined;
  readonly backgroundStop: AbortController;
  /** What the model is offered this step (tools/notebook-gate.ts). */
  readonly advertised: (current: readonly ConversationItem[]) => ToolDefinition[];
  readonly throwIfAborted: () => void;
  readonly append: (...added: ConversationItem[]) => Promise<void>;
  /** Notification hooks watch the agent wait on the user; they never hold
   * up the prompt, so they are not awaited. */
  readonly notifyHook: (message: string, notificationType: 'permission_prompt' | 'idle_prompt') => void;
  readonly result: (extra: Partial<AgentTurnResult> & Pick<AgentTurnResult, 'stopReason'>) => AgentTurnResult;
  /** Steering: text typed mid-turn is queued and lands before the next model step. */
  readonly steerQueue: string[];
  /** Woken when a steer arrives, so a wait on background agents does not sit through it. */
  readonly steerWaiters: Set<() => void>;
  steerOpen: boolean;
  /** Tool calls running now. The model cannot answer a steer until they return. */
  callsOpen: number;
  /** Steers typed while a call runs: queued by the broker as the fallback and
   * put into the turn when the last open call returns (releaseHeldSteers). */
  readonly heldSteers: HeldSteer[];
  /** Foreground sub-agents running now (by their call id) and the handler that
   * steers each: a steer typed during their call goes to them to answer. */
  readonly foregroundSteers: Map<string, (text: string) => Promise<void>>;
  items: ConversationItem[];
  ledger: ReturnType<typeof emptyLedger>;
  lastStepUsage: TokenUsage | undefined;
  itemsAtLastUsage: number;
  /** The window the model client reported is the one compaction measures against: the same figure a
   * switch sized the conversation it handed over to (agent-history.ts). Falling to the 128k default
   * here compacted a 1M-window Gateway model on its first step (MEASURED 2026-10-10: 458 turns
   * seeded for Opus 5.5, compaction before the model answered). */
  contextWindow: number | undefined;
  servedModel: string | undefined;
  readonly segments: string[];
  needsSeparator: boolean;
  steps: number;
  readonly stall: StallGuard;
  stalledCall: ModelToolCall | undefined;
  stepRetries: number;
  retryWaitedSeconds: number;
  compactedForSize: boolean;
  /** The estimated context size right after the last compaction; the next one waits for real growth past it (run-turn.ts). */
  tokensAfterCompaction: number | undefined;
  lengthContinues: number;
  /** Stop hooks may keep the agent working; bounded so two hooks cannot loop it forever. */
  stopContinues: number;
  /** The calls of the current step shown while they were written, by id,
   * with the label last shown. */
  readonly shownCalls: Map<string, string>;
  /** The step before this one was cut off at the output limit, and this one
   * carries on its sentence: no paragraph break between them. */
  continuesCutAnswer: boolean;
  lastContext: LastContext;
  /** Whether the model answering the current step can see images; a tool
   * that would show one (read_file) says so in words otherwise. */
  stepAcceptsImages: boolean;
}

/** Opens a turn: its scope, tools, prompt and conversation, the user's hooks,
 * and the prompt's own item. `promptBlocked` is a UserPromptSubmit hook's refusal. */
export async function openTurn(input: AgentTurnInput): Promise<{ rt: TurnRuntime; promptBlocked: string | undefined }> {
  const signal = input.signal;
  const throwIfAborted = (): void => { if (signal?.aborted) throw turnCancelledError(); };
  throwIfAborted();

  const cwd = path.resolve(input.cwd);
  const addDirs = (input.addDirs ?? []).map((dir) => path.resolve(cwd, dir));
  const homeDir = input.homeDir ?? os.homedir();
  const scope: PathScope = { cwd, addDirs, stateDir: input.stateDir, homeDir, sessionId: input.sessionId };
  const turnId = newTurnId();
  const session = sessionState(input.stateDir, input.sessionId);
  if (input.planMode !== undefined) session.plan = { active: input.planMode };
  const checkpoints = new FileCheckpointStore(input.stateDir);
  const store = new ConversationStore(input.stateDir, input.sessionId, input.subagent?.transcriptFile);
  // Decided from facts fixed for the session (the model's window and speed,
  // or a forced choice), so every turn sends the same prompt prefix.
  const profile = resolveContextProfile({
    hints: { ...input.modelClient.contextHints, contextWindow: input.modelClient.contextHints?.contextWindow ?? input.contextWindow },
    session: input.contextProfile,
  });
  const exposure = exposeTools(mergeTools(input.tools ?? defaultTools(), input.extraTools), profile.mcpEagerSchemaTokens);
  const tools = exposure.all;

  const [loaded, savedRules, baseSystem, notebooksOnDisk] = await abortable(Promise.all([
    store.load(),
    input.permissionRules ? Promise.resolve(input.permissionRules.current) : loadPermissionRules(cwd),
    // A sub-agent keeps its own short prompt. Skills are listed only when the
    // tool that loads them is present.
    input.subagent ? input.subagent.system
      : (tools.some((tool) => tool.name === SKILL_TOOL) ? discoverSkills({ cwd, stateDir: input.stateDir, homeDir, turnId }) : Promise.resolve({ skills: [] }))
        .then((catalog) => buildSystemPrompt({
          cwd, addDirs, homeDir, userConfigDir: input.userConfigDir ?? input.stateDir,
          skillsSection: [
            skillsPromptSection(catalog.skills, profile),
            // Plugin agent types, when a tool can start one.
            tools.some((tool) => tool.name === TASK_TOOL_NAME || tool.name === 'agent') ? agentTypesPromptSection(enabledPluginAgents({ stateDir: input.stateDir, home: homeDir }), profile.skillDescriptionChars) : '',
          ].filter(Boolean).join('\n\n'), toolUsageGuidance: profile.toolUsageGuidance,
          ...(input.agentInstructions ? { agentInstructions: input.agentInstructions } : {}),
        })),
    workspaceHasNotebooks([cwd, ...addDirs]),
  ]), signal);
  const turnRules = input.permissionRules ?? { current: savedRules };
  const items: ConversationItem[] = loaded;

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
  const notifyHook = (message: string, notificationType: 'permission_prompt' | 'idle_prompt'): void => {
    if (!input.hooks?.notification) return;
    const sessionId = input.subagent?.parentSessionId ?? input.sessionId;
    void input.hooks.notification({ ...turnHookInfo, sessionId, message, notificationType }).catch(() => undefined);
  };
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

  const ledger = emptyLedger();
  const backgroundAgents = input.subagent ? undefined : new BackgroundAgents();
  const segments: string[] = [];
  const rt: TurnRuntime = {
    input, signal, cwd, addDirs, homeDir, scope, turnId, session, checkpoints, store, profile, tools, baseSystem,
    turnRules, turnHookInfo, backgroundAgents, backgroundStop: new AbortController(),
    advertised: (current) => gateNotebookTool(exposure.advertised(current), current, notebooksOnDisk),
    throwIfAborted,
    append: async (...added) => { rt.items.push(...added); await store.append(...added); },
    notifyHook,
    result: (extra) => ({
      text: segments.join('\n\n').trim(), nativeSessionId: input.sessionId, usage: rt.ledger.total, steps: rt.steps, contextProfile: profile.name, ...extra,
    }),
    steerQueue: [], steerWaiters: new Set(), steerOpen: true, callsOpen: 0, heldSteers: [], foregroundSteers: new Map(), items, ledger, lastStepUsage: undefined, itemsAtLastUsage: items.length,
    contextWindow: input.contextWindow ?? input.modelClient.contextHints?.contextWindow,
    servedModel: undefined, segments, needsSeparator: false, steps: 0, stall: new StallGuard(), stalledCall: undefined,
    stepRetries: 0, retryWaitedSeconds: 0, compactedForSize: false, tokensAfterCompaction: undefined, lengthContinues: 0, stopContinues: 0,
    shownCalls: new Map(), continuesCutAnswer: false, lastContext: { contextProfile: profile.name },
    stepAcceptsImages: input.modelClient.acceptsImages === true,
  };
  if (!promptBlocked) {
    await rt.append({ type: 'text', role: 'user', text: `${environment}${hookNote}${input.prompt}${imageNote}`, ...(images.length ? { images } : {}) });
    await input.onRemembered?.();
  }
  input.onSteerReady?.(async (text: string, hold) => {
    if (!rt.steerOpen) throw new Error('The turn has already finished');
    if (!text.trim()) return;
    // A call is running: the model hears this when it returns, not before.
    // Held (queued as the fallback, the row says "at the next pause") rather
    // than shown as sent into a turn that cannot answer yet.
    if (hold && rt.callsOpen > 0) {
      // A foreground sub-agent is running: it can answer now, so it hears the
      // message at once. The main agent hears it too, when the call returns.
      for (const steer of [...rt.foregroundSteers.values()]) void steer(text).catch(() => undefined);
      return holdSteer(rt, text, hold);
    }
    pushSteer(rt, text);
  });
  return { rt, promptBlocked };
}

export interface HeldSteer {
  text: string;
  ready: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function pushSteer(rt: TurnRuntime, text: string): void {
  rt.steerQueue.push(text);
  for (const wake of [...rt.steerWaiters]) wake();
}

export function holdSteer(rt: TurnRuntime, text: string, hold: (withdraw: () => boolean) => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const drop = (error: Error): boolean => {
      const at = rt.heldSteers.indexOf(item);
      if (at < 0) return false; // already in the turn
      rt.heldSteers.splice(at, 1);
      reject(error);
      return true;
    };
    const ready = hold(() => drop(new Error('taken back from the queue')));
    const item: HeldSteer = { text, ready, resolve, reject };
    ready.catch((error: unknown) => drop(error instanceof Error ? error : new Error(String(error))));
    rt.heldSteers.push(item);
  });
}

/** The last open call returned: what was typed meanwhile goes to the model, oldest first. */
export async function releaseHeldSteers(rt: TurnRuntime): Promise<void> {
  while (rt.heldSteers.length && rt.callsOpen === 0 && rt.steerOpen) {
    const item = rt.heldSteers[0]!;
    try { await item.ready; } catch { continue; } // dropped and rejected already
    if (rt.heldSteers[0] !== item) continue; // taken back meanwhile
    rt.heldSteers.shift();
    if (!rt.steerOpen) { item.reject(new Error('The turn has already finished')); continue; }
    pushSteer(rt, item.text);
    item.resolve();
  }
}

/** Ends a turn's background work and seals its checkpoints. */
export async function closeTurn(rt: TurnRuntime): Promise<void> {
  const { input } = rt;
  rt.steerOpen = false;
  input.onSteerReady?.(undefined);
  // Typed while a call ran and never heard: their queued copies run as the next turn.
  for (const item of rt.heldSteers.splice(0)) item.reject(new Error('The turn has already finished'));
  // Accepted after the loop's last look, or left when the turn ended early:
  // the model never saw them.
  const undelivered = rt.steerQueue.splice(0);
  if (undelivered.length) await input.onSteersUndelivered?.(undelivered).catch(() => undefined);
  // An early end (cancel, error, step limit, a question) stops them; each
  // commits its work to its branch before the turn returns.
  rt.backgroundStop.abort();
  await rt.backgroundAgents?.settled();
  await rt.checkpoints.seal(input.sessionId, rt.turnId).catch(() => undefined);
  await rt.checkpoints.prune(input.sessionId).catch(() => undefined);
}
