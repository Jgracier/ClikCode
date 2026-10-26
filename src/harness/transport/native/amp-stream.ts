/** Amp's JSON stdin is kept open until the main reply and background agents
 * settle. `result` is emitted only after EOF. A steer is accepted only when
 * Amp echoes its user message, rather than when the pipe accepts a write.
 * https://ampcode.com/docs/cli/streaming-json */
import type { SteerHold } from '../../../turn/live-input.js';

type Json = Record<string, any>;
type Message = { text: string; ready: Promise<void>; sent: boolean; resolve(): void; reject(error: Error): void };

export function ampUserMessage(text: string, steer = false): string {
  return `${JSON.stringify({ type: 'user', ...(steer ? { steer: true } : {}), message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

export function createAmpStreamTurn(options: { prompt: string; write(text: string): boolean; close(): void }) {
  const calls = new Set<string>();
  const agents = new Set<string>();
  const messages: Message[] = [];
  let initial = true;
  let busy = true;
  const followUps = new Set<string>();
  let settled = false;
  let flushing = false;
  const reject = (message: Message, error: Error): boolean => {
    const index = messages.indexOf(message);
    if (index < 0 || message.sent) return false;
    messages.splice(index, 1); message.reject(error);
    return true;
  };
  const end = (): void => {
    if (settled) return;
    settled = true;
    for (const message of messages.splice(0)) message.reject(new Error('Amp ended before accepting this message'));
    options.close();
  };
  const check = (): void => {
    if (!initial && !busy && !calls.size && !agents.size && !followUps.size && !messages.length) end();
  };
  const flush = async (): Promise<void> => {
    if (flushing || settled || calls.size || agents.size) return;
    flushing = true;
    try {
      for (;;) {
        const message = messages.find((entry) => !entry.sent);
        if (!message) break;
        if (settled || calls.size || agents.size) break;
        try { await message.ready; } catch (error) { reject(message, error instanceof Error ? error : new Error(String(error))); continue; }
        if (!messages.includes(message)) continue;
        if (settled || calls.size || agents.size) break;
        message.sent = true;
        try {
          if (!options.write(ampUserMessage(message.text, true))) { end(); break; }
        } catch { end(); break; }
        busy = true;
      }
    } finally { flushing = false; check(); }
  };
  return {
    get settled() { return settled; },
    steer(text: string, hold?: SteerHold): Promise<void> {
      if (settled) return Promise.reject(new Error('Amp is finishing'));
      const safe = !calls.size && !agents.size && !messages.length;
      if (!safe && !hold) return Promise.reject(new Error('Amp is running a tool'));
      return new Promise<void>((resolve, rejectMessage) => {
        const message: Message = { text, ready: Promise.resolve(), sent: false, resolve, reject: rejectMessage };
        messages.push(message);
        if (!safe) message.ready = hold!(() => reject(message, new Error('Message taken back')));
        message.ready.catch((error: unknown) => { reject(message, error instanceof Error ? error : new Error(String(error))); check(); });
        void flush();
      });
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
        if (agents.delete(record.tool_use_id) && record.status !== 'cancelled') followUps.add(record.tool_use_id);
      }
      // Child messages cannot finish the parent or acknowledge its inputs.
      const content: Json[] = Array.isArray(record.message?.content) ? record.message.content : [];
      if (record.type === 'user') {
        for (const part of content) if (part.type === 'tool_result') {
          calls.delete(part.tool_use_id);
          if (part.is_error) agents.delete(part.tool_use_id);
        }
        if (record.subagent_tool_use_id) { followUps.delete(record.subagent_tool_use_id); busy = true; }
        else if (content.some((part) => part.type === 'text') && !content.some((part) => part.type === 'tool_result')) {
          const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('');
          if (initial && text === options.prompt) initial = false;
          else {
            const at = messages.findIndex((message) => message.sent && message.text === text);
            if (at >= 0) messages.splice(at, 1)[0]!.resolve();
          }
          busy = true;
        }
      }
      if (record.type === 'assistant') {
        for (const part of content) if (part.type === 'tool_use' && typeof part.id === 'string') {
          calls.add(part.id);
          if (part.name === 'Task' && part.input?.mode === 'async') agents.add(part.id);
        }
        if (record.message?.stop_reason === 'end_turn') busy = false;
      }
      void flush();
      check();
    },
    ended: end,
  };
}
