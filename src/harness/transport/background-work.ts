/** Background work a vendor left running: one model, fed by each transport from its own wire.
 *
 * Every transport answers the same questions about the vendor process it drives -- what is still
 * running, how much of each kind, and what just ended -- and each used to keep its own maps for
 * it. They now keep a BackgroundWorkTracker, and read their wire into it with a thin adapter:
 *  - items: work the vendor names one by one, by its own id, from start to end -- an open tool
 *    call (ACP `tool_call`, a Codex item), a sub-agent (a Codex agent thread), a Claude
 *    `task_started` ... `task_notification` (handoff-work.ts VendorTasks, native/background-wait.ts),
 *    and a retired process's commands (seen in its process group, process-group.ts) and agents
 *    (persistent-session.ts retire).
 *  - a level: counts a vendor reports instead of items (claude-agent-acp's
 *    `background_tasks_changed`, Codex's background terminals), merged kind by kind
 *    (protocol/background-agents.ts mergeBackgroundWork): a kind the update leaves out keeps its
 *    count, a zero drops it.
 *  - endings: what ended, and how (`EndedWork`), batched to `onEnded` as one notice.
 * What a transport makes of an item starting or ending -- a tool row, a background turn opening
 * or closing, its process kept -- stays the transport's: the tracker only says what runs. */
import { mergeBackgroundWork, type BackgroundWork, type BackgroundWorkUpdate } from '../protocol/background-agents.js';
import type { EndedWork } from './handoff-work.js';

/** One piece of running work. `tool`: a call still open; `command`: a background shell or
 * terminal; `agent`: a background or sub-agent; `workflow`: a dynamic workflow. */
export interface WorkItem {
  id: string;
  kind: 'agent' | 'command' | 'workflow' | 'tool';
  label: string;
  /** An agent's task, as it was given: what starting it again needs. */
  prompt?: string;
  /** Where a command writes its output. */
  outputFile?: string;
}

export class BackgroundWorkTracker<T extends WorkItem = WorkItem> {
  private readonly items = new Map<string, T>();
  private reported?: BackgroundWork;

  /** `onEnded`: told each batch of work that ended (`told`). */
  constructor(private readonly onEnded?: (ended: readonly EndedWork[]) => void) {}

  /** `item` started. False when it was already running (it is kept as it was). */
  start(item: T): boolean {
    if (this.items.has(item.id)) return false;
    this.items.set(item.id, item);
    return true;
  }

  /** `id` ended: it leaves the set. Undefined when it was not running. */
  end(id: string): T | undefined {
    const item = this.items.get(id);
    this.items.delete(id);
    return item;
  }

  /** Every item (of `kind`) ends at once; returns them. */
  endAll(kind?: T['kind']): T[] {
    const ended = this.running(kind);
    for (const item of ended) this.items.delete(item.id);
    return ended;
  }

  /** Tell `onEnded` how what ended ended. */
  told(ended: readonly EndedWork[]): void { this.onEnded?.(ended); }

  /** The vendor's own level changed (each kind `update` names). */
  replaceLevel(update: BackgroundWorkUpdate): void { this.reported = mergeBackgroundWork(this.reported, update); }

  /** The level last reported; undefined when it holds nothing. */
  get level(): BackgroundWork | undefined { return this.reported; }

  /** The level with every kind named (a zero is "none", not unknown). */
  fullLevel(): { agents: number; terminals: number; workflows: number } {
    const level = this.reported ?? {};
    return { agents: level.agents ?? 0, terminals: level.terminals ?? 0, workflows: level.workflows ?? 0 };
  }

  has(id: string): boolean { return this.items.has(id); }
  get(id: string): T | undefined { return this.items.get(id); }
  running(kind?: T['kind']): T[] { return [...this.items.values()].filter((item) => !kind || item.kind === kind); }
  count(kind?: T['kind']): number { return kind ? this.running(kind).length : this.items.size; }
  /** Items plus the level's counts: everything said to be running. */
  total(): number {
    const level = this.fullLevel();
    return this.items.size + level.agents + level.terminals + level.workflows;
  }

  /** Forget it all, items and level. */
  clear(): void {
    this.items.clear();
    this.reported = undefined;
  }
}
