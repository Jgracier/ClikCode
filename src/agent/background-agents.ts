/** Coding sub-agents the parent started in the background, for the SESSION.
 *
 * Each runs while the parent keeps working; the parent can send it a
 * follow-up instruction (it lands before the agent's next step, as steering
 * does for a user) and wait for its result. A result the parent did not wait
 * for reaches it as a message before its next step.
 *
 * An agent's life is NOT the turn's. Stopping the turn (Esc, Ctrl+C, the
 * editor's Stop), closing a window, a resize, a model switch: none of them
 * touches it. It ends when it finishes, or when the user explicitly stops it
 * (`stop`, `stopAll`: the /agents command and the editor's stop-agents
 * action) -- or when the worker process itself must go, in which case it is
 * stopped gracefully so its work is committed to its branch (subagent.ts).
 * A result that finishes while no turn runs is queued as a notification, and
 * the worker starts a follow-up turn to deliver it. */
import type { ToolRunResult } from './tool-contract.js';
import type { HarnessSessionState } from './session-state.js';
import { queueShellNotification } from './session-state.js';
import { agentRecordEnded, agentRecordStarted, agentRecordUpdated } from './agent-registry.js';

interface BackgroundAgent {
  id: string;
  label: string;
  done: Promise<void>;
  result?: ToolRunResult;
  /** The running agent's steering handler; unset before its loop starts and after it ends. */
  steer?: (text: string) => Promise<void>;
  /** Instructions sent before its loop could take them. */
  pending: string[];
  /** The parent has its result, by agent_wait or by notification. */
  delivered: boolean;
  /** Aborted only by an explicit stop (or the worker's own end). Never by a turn. */
  stop: AbortController;
  startedAt: number;
  /** Why it was stopped, when it was. */
  stoppedFor?: string;
  branch?: string;
}

export type SteerReady = (handler?: (text: string) => Promise<void>) => void;
/** Where the agent works, once its worktree exists: recorded so its work can be found and committed after a crash. */
export type AgentStarted = (info: { branch: string; cwd: string; root: string; base: string; repo: string }) => void;

export class BackgroundAgents {
  private readonly agents = new Map<string, BackgroundAgent>();
  private next = 1;
  private readonly finished = new Set<() => void>();
  /** Turns that are running now and will take a finished result themselves. */
  private turns = 0;

  constructor(private readonly session?: HarnessSessionState, private readonly stateDir?: string) {}

  /** A turn begins to hear results. */
  attachTurn(): void { this.turns++; }

  /** A turn is over: agents go on. What finished that it never took is queued
   * as a notification, so the next turn (or a follow-up the worker starts) hears it. */
  detachTurn(): void {
    this.turns = Math.max(0, this.turns - 1);
    if (this.turns === 0) this.notifyUnattended();
  }

  private notifyUnattended(): void {
    if (!this.session) return;
    const done = this.takeFinished();
    for (const note of done) {
      queueShellNotification(this.session, {
        kind: 'agent', shellId: note.id, command: note.label, tail: note.result.output, at: Date.now(),
        ...(note.result.isError ? { reason: 'failed' } : {}),
      });
    }
  }

  /** Starts `run` and returns the agent's id at once. `signal` is the agent's own: only an explicit stop aborts it. */
  start(label: string, run: (onSteerReady: SteerReady, signal: AbortSignal, started: AgentStarted) => Promise<ToolRunResult>): string {
    const id = `agent_${this.next++}`;
    const agent: BackgroundAgent = { id, label, pending: [], delivered: false, done: Promise.resolve(), stop: new AbortController(), startedAt: Date.now() };
    const persist = this.session && this.stateDir ? { stateDir: this.stateDir, sessionId: this.session.sessionId } : undefined;
    if (persist) agentRecordStarted(persist.stateDir, persist.sessionId, { id, label, startedAt: agent.startedAt });
    const started: AgentStarted = (info) => {
      agent.branch = info.branch;
      if (persist) agentRecordUpdated(persist.stateDir, persist.sessionId, id, { worktree: info });
    };
    const onSteerReady: SteerReady = (handler) => {
      agent.steer = handler;
      if (handler) for (const text of agent.pending.splice(0)) void handler(text).catch(() => undefined);
    };
    agent.done = run(onSteerReady, agent.stop.signal, started).then(
      (result) => { agent.result = result; },
      (error: unknown) => { agent.result = { output: `The agent stopped: ${error instanceof Error ? error.message : String(error)}`, isError: true }; },
    ).finally(() => {
      agent.steer = undefined;
      if (agent.stoppedFor && agent.result) agent.result = { ...agent.result, output: `[stopped: ${agent.stoppedFor}] ${agent.result.output}`, isError: true };
      if (persist) agentRecordEnded(persist.stateDir, persist.sessionId, id, agent.stoppedFor ? 'stopped' : agent.result?.isError ? 'failed' : 'finished', agent.result?.output.slice(0, 2000));
      for (const wake of [...this.finished]) wake();
      // No turn is listening: the result is queued for the model, not lost.
      if (this.turns === 0) this.notifyUnattended();
    });
    this.agents.set(id, agent);
    return id;
  }

  private find(id: string): BackgroundAgent | ToolRunResult {
    return this.agents.get(id) ?? { output: `No background agent "${id}". Known: ${[...this.agents.keys()].join(', ') || 'none'}.`, isError: true };
  }

  async send(id: string, text: string): Promise<ToolRunResult> {
    const agent = this.find(id);
    if (!('pending' in agent)) return agent;
    if (agent.result) return { output: `${id} has already finished; its result ${agent.delivered ? 'was given to you' : 'follows as a message, or get it with agent_wait'}. Start a new agent for more work.`, isError: true };
    if (agent.steer) {
      try { await agent.steer(text); } catch { return { output: `${id} has just finished; it did not get the message.`, isError: true }; }
    } else {
      agent.pending.push(text);
    }
    return { output: `Sent to ${id}; it reads the message before its next step.` };
  }

  /** The named agent's result, or the next one to finish of those not yet
   * delivered; a note when the time runs out first. */
  async wait(id: string | undefined, seconds: number, signal?: AbortSignal, steerSignal?: AbortSignal): Promise<ToolRunResult> {
    let targets: BackgroundAgent[];
    if (id) {
      const agent = this.find(id);
      if (!('pending' in agent)) return agent;
      targets = [agent];
    } else {
      targets = [...this.agents.values()].filter((agent) => !agent.delivered);
      if (!targets.length) return { output: 'No background agent is running or has an undelivered result.' };
    }
    const ready = (): BackgroundAgent | undefined => targets.find((agent) => agent.result);
    if (!ready()) await this.until(() => ready() !== undefined, seconds * 1000, steerSignal ? AbortSignal.any([...(signal ? [signal] : []), steerSignal]) : signal);
    const agent = ready();
    if (!agent && steerSignal?.aborted && !signal?.aborted) return { output: `Returned early because the user sent a message; read it before anything else. ${targets.map((entry) => entry.id).join(', ')} still running: nothing was stopped. Call agent_wait again if you still need the result.` };
    if (!agent) return { output: `${targets.map((entry) => entry.id).join(', ')} still running after ${seconds}s.` };
    agent.delivered = true;
    return { ...agent.result!, output: `[${agent.id} finished] ${agent.label}\n${agent.result!.output}` };
  }

  /** Finished results the parent has not had, marked delivered. */
  takeFinished(): Array<{ id: string; label: string; result: ToolRunResult }> {
    const out: Array<{ id: string; label: string; result: ToolRunResult }> = [];
    for (const agent of this.agents.values()) {
      if (agent.delivered || !agent.result) continue;
      agent.delivered = true;
      out.push({ id: agent.id, label: agent.label, result: agent.result });
    }
    return out;
  }

  /** Every agent this session started, in start order. */
  list(): Array<{ id: string; label: string; status: 'running' | 'finished' | 'failed' | 'stopped'; delivered: boolean; startedAt: number; branch?: string }> {
    return [...this.agents.values()].map((agent) => ({
      id: agent.id, label: agent.label, delivered: agent.delivered, startedAt: agent.startedAt, ...(agent.branch ? { branch: agent.branch } : {}),
      status: !agent.result ? 'running' : agent.stoppedFor ? 'stopped' : agent.result.isError ? 'failed' : 'finished',
    }));
  }

  /** What is running now, for the confirmation that names it. */
  runningAgents(): Array<{ id: string; label: string; startedAt: number; branch?: string }> {
    return this.list().filter((agent) => agent.status === 'running');
  }

  /** The user's explicit stop of one agent. It commits its work to its branch on the way out. Resolves once it has. */
  async stop(id: string, reason = 'stopped by you'): Promise<boolean> {
    const agent = this.agents.get(id);
    if (!agent || agent.result) return false;
    agent.stoppedFor = reason;
    agent.stop.abort();
    await agent.done;
    return true;
  }

  /** The user's explicit "stop everything" (or the worker's own end): every running agent, work committed. */
  async stopAll(reason = 'stopped by you'): Promise<string[]> {
    const ids = this.runningAgents().map((agent) => agent.id);
    await Promise.all(ids.map((id) => this.stop(id, reason)));
    return ids;
  }

  /** Calls `ended` once the agent has finished (or failed), with how it ended. */
  whenEnded(id: string, ended: (result: ToolRunResult | undefined) => void): void {
    const agent = this.agents.get(id);
    if (!agent) { ended(undefined); return; }
    void agent.done.then(() => ended(agent.result));
  }

  running(): number {
    let count = 0;
    for (const agent of this.agents.values()) if (!agent.result) count++;
    return count;
  }

  /** Resolves when any running agent finishes (at once when none runs). */
  nextFinish(signal?: AbortSignal): Promise<void> {
    return this.until(() => true, undefined, signal, true);
  }

  /** Every agent's own wind-down: its worktree committed or removed. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.agents.values()].map((agent) => agent.done));
  }

  private until(check: () => boolean, ms: number | undefined, signal?: AbortSignal, onNextFinish = false): Promise<void> {
    if (onNextFinish && !this.running()) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = (): void => {
        this.finished.delete(wake);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolve();
      };
      const wake = (): void => { if (check()) stop(); };
      this.finished.add(wake);
      const timer = ms !== undefined ? setTimeout(stop, ms) : undefined;
      // The caller sees the abort itself; this only stops waiting.
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });
  }
}

export function formatAgentNotifications(notes: ReadonlyArray<{ id: string; label: string; result: ToolRunResult }>): string {
  return notes.map((note) => `[background agent ${note.id} finished${note.result.isError ? ' with an error' : ''}] ${note.label}\n${note.result.output}`).join('\n\n');
}

const registries = new WeakMap<HarnessSessionState, BackgroundAgents>();

/** The session's agents: one registry per session, kept for as long as the worker holds the session. */
export function sessionAgents(session: HarnessSessionState, stateDir: string): BackgroundAgents {
  let agents = registries.get(session);
  if (!agents) { agents = new BackgroundAgents(session, stateDir); registries.set(session, agents); }
  return agents;
}

/** The registry if one exists, without making one. */
export function existingSessionAgents(session: HarnessSessionState): BackgroundAgents | undefined {
  return registries.get(session);
}
