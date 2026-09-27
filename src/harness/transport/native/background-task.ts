/** Background work a vendor CLI reports on its own stream, read the same way
 * for every vendor that reports it.
 *
 * A backgrounded command's tool call COMPLETES at once -- the tool only
 * launched it -- so the idle watchdog sees no running tool and gives the
 * process the ordinary silence budget while the vendor sits waiting for the
 * work. Verified live: cursor-agent 2026.09 holds `-p` open until its own
 * background shell ends, then emits `task_notification` and a follow-up in
 * the same `result`; twenty seconds of silence in between. A build that ran
 * longer than the ordinary budget was stopped as a hang.
 *
 * Shapes (captured, see fixtures/):
 *  - Claude Code: `{type:"system", subtype:"task_started", task_id,
 *    is_backgrounded:true}` ... `{subtype:"task_notification", task_id}`.
 *    Foreground tasks and a subagent's own (`owned_by_subagent`) are not
 *    background work.
 *  - Cursor: `{type:"tool_call", subtype:"completed", tool_call:{shellToolCall:
 *    {args:{isBackground:true}, result:{success:{shellId}}}}}` ...
 *    `{type:"system", subtype:"task_notification", task_id:"<shellId>"}`.
 */

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;

export type VendorBackgroundEvent =
  | { kind: 'started'; id: string; description: string }
  | { kind: 'finished'; id: string; status: string };

export function vendorBackgroundEvent(value: Json): VendorBackgroundEvent | undefined {
  if (value.type === 'system') {
    const id = typeof value.task_id === 'string' || typeof value.task_id === 'number' ? String(value.task_id) : undefined;
    if (!id) return undefined;
    if (value.subtype === 'task_started' && value.is_backgrounded === true && value.owned_by_subagent !== true) {
      return { kind: 'started', id, description: typeof value.description === 'string' ? value.description : 'background task' };
    }
    if (value.subtype === 'task_notification') {
      return { kind: 'finished', id, status: typeof value.status === 'string' ? value.status : 'completed' };
    }
    return undefined;
  }
  if (value.type === 'tool_call' && value.subtype === 'completed') {
    const shell = record(record(value.tool_call)?.shellToolCall);
    const shellId = record(record(shell?.result)?.success)?.shellId;
    if (record(shell?.args)?.isBackground !== true || (typeof shellId !== 'number' && typeof shellId !== 'string')) return undefined;
    const command = record(shell?.args)?.command;
    return { kind: 'started', id: String(shellId), description: typeof command === 'string' ? command : 'background command' };
  }
  return undefined;
}
