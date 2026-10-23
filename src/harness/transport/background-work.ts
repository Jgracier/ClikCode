/** Background work a vendor left running: one model, fed by each transport from its own wire.
 *
 * Each transport keeps a BackgroundWorkTracker and reads its wire into it with a thin adapter:
 *  - items: work named one by one, start to end, by the vendor's id -- an open tool call (ACP),
 *    a Codex item or sub-agent thread, a Claude `task_started` ... `task_notification`
 *    (handoff-work.ts VendorTasks, native/background-wait.ts), a Cursor background shell
 *    (events/structured.ts), a retired process's commands (seen in its process group) and agents
 *    (persistent-session.ts retire).
 *  - a level: counts a vendor reports instead of items (claude-agent-acp's background_tasks_changed,
 *    Codex's background terminals), merged kind by kind (mergeBackgroundWork).
 *  - endings: what ended and how (`EndedWork`), told to `onEnded` in one batch.
 * What an item starting or ending means -- a tool row, a background turn opened or closed, a
 * process kept -- stays the transport's: the tracker only says what runs. */
import { mergeBackgroundWork, type BackgroundWork, type BackgroundWorkUpdate } from '../protocol/background-agents.js';
import type { EndedWork } from './handoff-work.js';

/** One piece of running work: an open `tool` call, a background `command` (shell, terminal), an
 * `agent`, a dynamic `workflow`. */
export interface WorkItem {
  /** The vendor's id for it (a call, task or thread id), or a command's pid. */
  id: string;
  kind: 'agent' | 'command' | 'workflow' | 'tool';
  /** The command line, or the agent's description. */
  label: string;
  /** An agent's task, as it was given: what starting it again needs. */
  prompt?: string;
  /** Where a command writes its output. */
  outputFile?: string;
}

export class BackgroundWorkTracker<T extends WorkItem = WorkItem> {
  private readonly items = new Map<string, T>();
  /** The level last reported; undefined when it holds nothing. */
  level?: BackgroundWork;

  constructor(private readonly onEnded?: (ended: readonly EndedWork[]) => void, items: Iterable<T> = []) {
    for (const item of items) this.start(item);
  }

  /** False when it was already running (kept as it was). */
  start(item: T): boolean {
    if (this.items.has(item.id)) return false;
    this.items.set(item.id, item);
    return true;
  }

  /** It leaves the set; undefined when it was not running. */
  end(id: string): T | undefined {
    const item = this.items.get(id);
    this.items.delete(id);
    return item;
  }

  endAll(kind?: T['kind']): T[] {
    const ended = this.running(kind);
    for (const item of ended) this.items.delete(item.id);
    return ended;
  }

  told(ended: readonly EndedWork[]): void { this.onEnded?.(ended); }
  replaceLevel(update: BackgroundWorkUpdate): void { this.level = mergeBackgroundWork(this.level, update); }
  /** The level with every kind named (a zero is "none", not unknown). */
  fullLevel(): BackgroundWork & { agents: number; terminals: number; workflows: number } {
    return { ...this.level, agents: this.level?.agents ?? 0, terminals: this.level?.terminals ?? 0, workflows: this.level?.workflows ?? 0 };
  }
  has(id: string): boolean { return this.items.has(id); }
  running(kind?: T['kind']): T[] { return [...this.items.values()].filter((item) => !kind || item.kind === kind); }
  count(kind?: T['kind']): number { return kind ? this.running(kind).length : this.items.size; }
  /** Items and level: everything said to be running. */
  total(): number { return (({ agents, terminals, workflows }) => agents + terminals + workflows + this.items.size)(this.fullLevel()); }
  clear(): void { this.items.clear(); this.level = undefined; }
}
