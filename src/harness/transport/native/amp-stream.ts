/** Amp's JSON stdin is kept open until the main reply and background agents
 * settle. `result` is emitted only after EOF. A steer is accepted only when
 * Amp echoes its user message, rather than when the pipe accepts a write.
 * https://ampcode.com/docs/cli/streaming-json */
import type { EndedWork } from '../handoff-work.js';
type Json = Record<string, any>;
/** A steer written to Amp and waiting for Amp's echo of it, which is what says it was taken. */
type Sent = { text: string; resolve(): void; reject(error: Error): void };

export function ampUserMessage(text: string, steer = false): string {
  return `${JSON.stringify({ type: 'user', ...(steer ? { steer: true } : {}), message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

/** The adapter for Amp's sub-agent ends: a `subagent_finished` record that is not `completed`
 * (its `status` and `error`), or the Task call's own failed result (`is_error`), is the agent cut
 * off, and the vendor's error is the evidence. Cancelled is the user's stop, not a failure. */
function ampAgentEnd(agent: { id: string; label: string; prompt?: string }, how: { status?: string; error?: string }): EndedWork {
  const work = { id: agent.id, kind: 'agent' as const, label: agent.label, ...(agent.prompt ? { prompt: agent.prompt } : {}) };
  if (how.status === 'completed') return { ...work, outcome: 'finished', tail: '' };
  return {
    ...work, outcome: 'cut-off', tail: how.error ?? '',
    ...(how.status === 'cancelled' ? {} : { failure: { vendorError: true, ...(how.error ? { text: how.error } : {}) } }),
  };
}

export function createAmpStreamTurn(options: {
  prompt: string; write(text: string): boolean; close(): void;
  /** Told each sub-agent that ended, and how (the ledger of finished work decides what that means). */
  agentEnded?(ended: EndedWork): void;
}) {
  const calls = new Set<string>();
  const agents = new Set<string>();
  /** What each async sub-agent was asked, by its Task call id. */
  const tasks = new Map<string, { label: string; prompt?: string }>();
  const ended = (id: string, how: { status?: string; error?: string }): void => {
    const task = tasks.get(id) ?? { label: 'sub-agent' };
    tasks.delete(id);
    try { options.agentEnded?.(ampAgentEnd({ id, ...task }, how)); } catch { /* fail-open-ok: the owner's bookkeeping */ }
  };
  const sent: Sent[] = [];
  let initial = true;
  let busy = true;
  const followUps = new Set<string>();
  let settled = false;
  let onWindow: (() => void) | undefined;
  const end = (): void => {
    if (settled) return;
    settled = true;
    for (const message of sent.splice(0)) message.reject(new Error('Amp ended before accepting this message'));
    options.close();
  };
  const check = (): void => {
    if (!initial && !busy && !calls.size && !agents.size && !followUps.size && !sent.length) end();
  };
  return {
    get settled() { return settled; },
    /** Set by the broker: called whenever no tool or sub-agent is running, which is when a message can be taken in. */
    set onWindow(handler: (() => void) | undefined) { onWindow = handler; },
    /** Writes a steer when nothing is running that it would cut, and settles once Amp echoes it. False when something is running. */
    async steer(text: string): Promise<boolean> {
      if (settled) throw new Error('Amp is finishing');
      if (calls.size || agents.size) return false;
      await new Promise<void>((resolve, reject) => {
        sent.push({ text, resolve, reject });
        try {
          if (!options.write(ampUserMessage(text, true))) { end(); return; }
        } catch { end(); return; }
        busy = true;
      });
      return true;
    },
    note(record: Json): void {
      if (settled) return;
      // A child's terminal or lifecycle frame never finishes its parent.
      if (record.parent_tool_use_id) return;
      if (record.type === 'result' || (record.type === 'system' && String(record.subtype).startsWith('error_'))) { end(); return; }
      if (record.type === 'system' && record.subtype === 'init') {
        for (const agent of record.subagents ?? []) if (typeof agent.tool_use_id === 'string') agents.add(agent.tool_use_id);
      }
      if (record.type === 'system' && record.subtype === 'subagent_finished') {
        if (agents.delete(record.tool_use_id)) {
          if (record.status !== 'cancelled') followUps.add(record.tool_use_id);
          ended(record.tool_use_id, { status: String(record.status ?? ''), ...(typeof record.error === 'string' ? { error: record.error } : {}) });
        }
      }
      // Child messages cannot finish the parent or acknowledge its inputs.
      const content: Json[] = Array.isArray(record.message?.content) ? record.message.content : [];
      if (record.type === 'user') {
        for (const part of content) if (part.type === 'tool_result') {
          calls.delete(part.tool_use_id);
          if (part.is_error && agents.delete(part.tool_use_id)) {
            const said = Array.isArray(part.content) ? part.content.map((item: Json) => item?.text ?? '').join('') : String(part.content ?? '');
            ended(part.tool_use_id, { status: 'error', ...(said ? { error: said } : {}) });
          }
        }
        if (record.subagent_tool_use_id) { followUps.delete(record.subagent_tool_use_id); busy = true; }
        else if (content.some((part) => part.type === 'text') && !content.some((part) => part.type === 'tool_result')) {
          const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('');
          if (initial && text === options.prompt) initial = false;
          else {
            const at = sent.findIndex((message) => message.text === text);
            if (at >= 0) sent.splice(at, 1)[0]!.resolve();
          }
          busy = true;
        }
      }
      if (record.type === 'assistant') {
        for (const part of content) if (part.type === 'tool_use' && typeof part.id === 'string') {
          calls.add(part.id);
          if (part.name === 'Task' && part.input?.mode === 'async') {
            agents.add(part.id);
            tasks.set(part.id, { label: String(part.input.description ?? '') || 'sub-agent', ...(typeof part.input.prompt === 'string' && part.input.prompt ? { prompt: part.input.prompt } : {}) });
          }
        }
        if (record.message?.stop_reason === 'end_turn') busy = false;
      }
      if (!calls.size && !agents.size) onWindow?.();
      check();
    },
    ended: end,
  };
}
