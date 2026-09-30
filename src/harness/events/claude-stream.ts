/** Content blocks in flight on a Claude-shaped stream (`--include-partial-
 * messages`): what the `stream_event` records say before a block completes.
 *
 * The completed block arrives later as an `assistant` record, and that is what
 * activity-events.ts reads. Reading only that, a tool row appeared when the
 * model had finished WRITING the call -- after a long Write or Edit, many
 * seconds after the model had chosen the tool -- and thinking showed as one
 * frozen "thinking" until its whole block was done. Here a tool row starts at
 * `content_block_start` under its name, and takes its full label (path,
 * command) when its arguments are complete; the completed record then
 * settles the same row, by the same id. Thinking is shown as it streams, the
 * whole thought so far on each delta, keyed so each delta replaces the last. */

import { claudeThinkingId, claudeToolStart, thoughtLabel, type NativeActivityEvent } from '../protocol/activity-events.js';
import { asRecord, type JsonRecord } from '../protocol/json-lines.js';

interface OpenBlock { kind: 'tool' | 'thinking'; id: string; name?: string; text: string }

export class ClaudeBlocks {
  /** Keyed by thread (a sub-agent's parent_tool_use_id, or '' for the main
   * agent) and block index: sub-agent streams interleave with the main one. */
  private readonly open = new Map<string, OpenBlock>();
  private readonly messageOf = new Map<string, string>();

  constructor(private readonly command: string) {}

  /** The activity one stream record means, if any. */
  note(record: JsonRecord): NativeActivityEvent[] {
    if (record.type !== 'stream_event') return [];
    const event = asRecord(record.event);
    const thread = typeof record.parent_tool_use_id === 'string' ? record.parent_tool_use_id : '';
    const parent = thread ? { parentId: thread } : {};
    const key = `${thread}:${String(event?.index ?? '')}`;
    switch (event?.type) {
      case 'message_start': {
        const id = asRecord(event.message)?.id;
        if (typeof id === 'string') this.messageOf.set(thread, id);
        return [];
      }
      case 'content_block_start': {
        const block = asRecord(event.content_block);
        if ((block?.type === 'tool_use' || block?.type === 'server_tool_use') && typeof block.id === 'string') {
          const name = String(block.name ?? 'tool');
          this.open.set(key, { kind: 'tool', id: block.id, name, text: '' });
          return [{ ...claudeToolStart({ id: block.id, name }, this.command), ...parent }];
        }
        if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
          const id = claudeThinkingId(this.messageOf.get(thread) ?? key);
          this.open.set(key, { kind: 'thinking', id, text: '' });
          // The block START is what tells the UI the model has gone quiet
          // because it is thinking.
          return [{ kind: 'thinking', label: 'thinking', id, ...parent }];
        }
        return [];
      }
      case 'content_block_delta': {
        const block = this.open.get(key);
        const delta = asRecord(event.delta);
        if (!block || !delta) return [];
        if (block.kind === 'tool' && typeof delta.partial_json === 'string') {
          block.text += delta.partial_json;
          return [];
        }
        if (block.kind === 'thinking' && typeof delta.thinking === 'string' && delta.thinking) {
          block.text += delta.thinking;
          return [{ kind: 'thinking', label: thoughtLabel(block.text), id: block.id, ...parent }];
        }
        return [];
      }
      case 'content_block_stop': {
        const block = this.open.get(key);
        this.open.delete(key);
        if (block?.kind !== 'tool' || !block.text.trim()) return [];
        let input: unknown;
        try { input = JSON.parse(block.text); } catch { return []; } // fail-open-ok: the completed record carries the same call whole
        return [{ ...claudeToolStart({ id: block.id, name: block.name, input }, this.command), ...parent }];
      }
      default:
        return [];
    }
  }
}
