/** Background agents a vendor says are still running when a turn ends
 * (standard section 10: `Waiting for N background agents`), read from the
 * wire shapes the vendor publishes. Nothing is guessed: a record that does not
 * carry the count says nothing, which is not zero.
 *
 * Claude Code publishes two, both in its own SDK / CLI:
 *  - `system/background_tasks_changed {tasks:[{task_id, task_type,
 *    description, ambient?}]}` -- the FULL set of live background tasks,
 *    emitted on every change (SDKBackgroundTasksChangedMessage; replace, never
 *    pair edges). Agents are the `local_agent` tasks that are not `ambient`.
 *  - `system/turn_duration {durationMs, messageCount,
 *    pendingBackgroundAgentCount}` -- the CLI's own end-of-turn record. */
import { asRecord, type JsonRecord } from './json-lines.js';

export function backgroundAgentCount(record: JsonRecord): number | undefined {
  if (record.type !== 'system') return undefined;
  if (record.subtype === 'background_tasks_changed' && Array.isArray(record.tasks)) {
    return record.tasks.filter((task) => {
      const value = asRecord(task);
      return value?.task_type === 'local_agent' && value.ambient !== true;
    }).length;
  }
  if (record.subtype === 'turn_duration') {
    const pending = record.pendingBackgroundAgentCount;
    return typeof pending === 'number' && Number.isFinite(pending) && pending >= 0 ? Math.floor(pending) : undefined;
  }
  return undefined;
}
