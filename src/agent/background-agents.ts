/** Coding sub-agents the parent started in the background, for one turn.
 *
 * Each runs while the parent keeps working; the parent can send it a
 * follow-up instruction (it lands before the agent's next step, as steering
 * does for a user) and wait for its result. A result the parent did not wait
 * for reaches it as a message before its next step, and the turn does not end
 * while one is still running -- so a background agent's spend, approvals and
 * cancellation stay the turn's, exactly as a foreground agent's do. */
import type { ToolRunResult } from './tool-contract.js';

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
}

export type SteerReady = (handler?: (text: string) => Promise<void>) => void;

export class BackgroundAgents {
  private readonly agents = new Map<string, BackgroundAgent>();
  private next = 1;
  private readonly finished = new Set<() => void>();

  /** Starts `run` and returns the agent's id at once. */
  start(label: string, run: (onSteerReady: SteerReady) => Promise<ToolRunResult>): string {
    const id = `agent_${this.next++}`;
    const agent: BackgroundAgent = { id, label, pending: [], delivered: false, done: Promise.resolve() };
    const onSteerReady: SteerReady = (handler) => {
      agent.steer = handler;
      if (handler) for (const text of agent.pending.splice(0)) void handler(text).catch(() => undefined);
    };
    agent.done = run(onSteerReady).then(
      (result) => { agent.result = result; },
      (error: unknown) => { agent.result = { output: `The agent stopped: ${error instanceof Error ? error.message : String(error)}`, isError: true }; },
    ).finally(() => {
      agent.steer = undefined;
      for (const wake of [...this.finished]) wake();
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
  async wait(id: string | undefined, seconds: number, signal?: AbortSignal): Promise<ToolRunResult> {
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
    if (!ready()) await this.until(() => ready() !== undefined, seconds * 1000, signal);
    const agent = ready();
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
