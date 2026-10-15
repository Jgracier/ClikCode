/** A background Agent's row, from Claude Code's own `task_*` frames -- the same
 * three frames whether they arrive as stream-json lines or as claude-agent-acp's
 * raw `_claude/sdkMessage`.
 *
 * The Agent call RETURNS at launch (`status: async_launched`); the agent runs
 * on and ends with `task_notification`. Its row is the agent's, not a
 * one-off command's: the launch's result is withheld, `task_progress` keeps
 * the row's tool uses and tokens current, and `task_notification` settles it.
 * Foreground agents (`is_backgrounded` false) and a sub-agent's own tasks
 * (`owned_by_subagent`) are not held: their call result is their end. */
import type { HarnessActivityEvent } from '../prompter.js';
import { asRecord, type JsonRecord } from '../protocol/json-lines.js';

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

export class BackgroundAgentRows {
  /** Held rows by the launching call's id, with the label the call had. */
  private readonly held = new Map<string, { label?: string }>();

  get size(): number { return this.held.size; }

  /** The activity as it should be shown: the launch call's completion is withheld (undefined). */
  filter(event: HarnessActivityEvent): HarnessActivityEvent | undefined {
    const row = event.id ? this.held.get(event.id) : undefined;
    if (!row) return event;
    if (event.agent && event.label !== 'tool') row.label = event.label;
    return event.kind === 'tool-start' ? event : undefined;
  }

  /** What one `system` record changes: the row's progress or end. */
  frame(record: JsonRecord): HarnessActivityEvent[] {
    const event = this.read(record);
    return event ? [event] : [];
  }

  private read(record: JsonRecord): HarnessActivityEvent | undefined {
    if (record.type !== 'system') return undefined;
    const id = typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined;
    if (!id) return undefined;
    if (record.subtype === 'task_started') {
      if (record.is_backgrounded === true && record.owned_by_subagent !== true && typeof record.subagent_type === 'string') this.held.set(id, {});
      return undefined;
    }
    const row = this.held.get(id);
    if (!row || (record.subtype !== 'task_progress' && record.subtype !== 'task_notification')) return undefined;
    const usage = asRecord(record.usage);
    const spent = {
      ...(count(usage?.tool_uses) !== undefined ? { childTools: count(usage?.tool_uses)! } : {}),
      ...(count(usage?.total_tokens) !== undefined ? { childTokens: count(usage?.total_tokens)! } : {}),
    };
    const label = row.label ?? 'tool';
    if (record.subtype === 'task_progress') return { kind: 'tool-start', label, agent: true, id, ...spent };
    this.held.delete(id);
    const status = String(record.status ?? 'completed');
    const duration = count(usage?.duration_ms);
    return {
      kind: status === 'completed' ? 'tool-done' : 'tool-error', label, agent: true, id, ...spent,
      ...(status === 'killed' || status === 'stopped' ? { stopped: true } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
    };
  }

  /** Every row still held, closed: nothing can end them now. */
  settle(kind: 'tool-done' | 'tool-error', stopped = false): HarnessActivityEvent[] {
    const events = [...this.held].map(([id, row]): HarnessActivityEvent => ({ kind, label: row.label ?? 'tool', agent: true, id, ...(stopped ? { stopped: true } : {}) }));
    this.held.clear();
    return events;
  }
}
