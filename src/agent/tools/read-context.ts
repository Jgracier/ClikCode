/** Retrieval is scoped to this conversation; no caller-supplied file path or
 * other session's private state can be opened through this tool. */
import { createReadStream } from 'node:fs';
import { fullRecordPath } from '../../session/full-record.js';
import type { ConversationItem } from '../model-client.js';
import { defineTool } from '../tool-contract.js';

interface Args { source?: 'history' | 'tool' | 'handoff'; id?: string; query?: string; offset?: number; limit?: number }
function text(item: ConversationItem): string {
  return item.type === 'tool_result' ? item.output : item.type === 'tool_call' ? JSON.stringify(item.args) : item.text;
}

async function readRecord(file: string, offset: number, limit: number, query?: string, signal?: AbortSignal): Promise<{ body: string; offset: number; more: boolean }> {
  let at = 0;
  let found = !query;
  let carry = '';
  let body = '';
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 8 * 1024, ...(signal ? { signal } : {}) });
  try {
    for await (const raw of stream) {
      const chunk = String(raw);
      if (!found) {
        const combined = carry + chunk;
        const match = combined.toLowerCase().indexOf(query!.toLowerCase(), Math.max(0, offset - at + carry.length));
        if (match < 0) { at += chunk.length; carry = combined.slice(-Math.max(256, query!.length)); continue; }
        offset = Math.max(offset, at - carry.length + match - 160);
        body = combined.slice(Math.max(0, offset - at + carry.length));
        found = true;
      } else if (at + chunk.length > offset) body += chunk.slice(Math.max(0, offset - at));
      at += chunk.length;
      if (body.length > limit) return { body: body.slice(0, limit), offset, more: true };
    }
    return { body, offset, more: false };
  } finally { stream.destroy(); }
}

export function readContextTool(items: () => readonly ConversationItem[], handoff = true) {
  return defineTool<Args>({
    name: 'read_context', class: 'read',
    description: 'Read or search this conversation\'s complete retained history, a tool result, or the original provider-handoff record. Use it when working context references omitted evidence. History IDs are item:N; tool IDs are call IDs. offset/limit page characters. A query locates matching text without loading the whole record into context.',
    parameters: {
      type: 'object', additionalProperties: false, properties: {
        source: { type: 'string', enum: ['history', 'tool', 'handoff'] },
        id: { type: 'string' }, query: { type: 'string', maxLength: 1_000 },
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 128, maximum: 8_192 },
      },
    },
    label: (args) => `Read context ${args.id ?? args.query ?? args.source ?? 'history'}`,
    async run(args, ctx) {
      const limit = Math.min(args.limit ?? 4_096, Math.max(128, ctx.outputCap ?? 4_096));
      let offset = args.offset ?? 0;
      const source = args.source ?? 'history';
      if (source === 'handoff') {
        if (!handoff) return { output: 'A sub-agent has its own task history, not the parent conversation\'s handoff record.', isError: true };
        try {
          const result = await readRecord(fullRecordPath(ctx.stateDir, ctx.sessionId), offset, limit, args.query, ctx.signal);
          return { output: `${result.body || '(No matching handoff text.)'}\n[handoff offset=${result.offset}${result.more ? `; continue offset=${result.offset + result.body.length}` : '; end'}]` };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { output: 'No provider-handoff record exists for this conversation. Use source=history instead.', isError: true };
          throw error;
        }
      }
      const all = items();
      let body: string;
      if (source === 'tool') {
        if (!args.id) return { output: 'id is required for source=tool: pass the call ID of the tool result. To find one, search source=history with a query.', isError: true };
        const result = all.find((item) => item.type === 'tool_result' && item.id === args.id);
        if (!result) return { output: `No tool result with ID ${JSON.stringify(args.id)} in this conversation. Search source=history for its call.`, isError: true };
        body = text(result);
      } else if (args.id) {
        const match = /^item:(\d+)$/.exec(args.id);
        const item = match ? all[Number(match[1])] : undefined;
        if (!item) return { output: `No history item ${JSON.stringify(args.id)}. IDs look like item:N with N from 0 to ${all.length - 1}; leave id out and pass a query to search for the text instead.`, isError: true };
        body = text(item);
      } else {
        body = all.flatMap((item, index) => {
          const value = text(item);
          const match = args.query ? value.toLowerCase().indexOf(args.query.toLowerCase()) : 0;
          if (match < 0) return [];
          const preview = value.slice(Math.max(0, match - 100), match + 400).replace(/\s+/g, ' ');
          return [`item:${index} ${item.type}${'id' in item ? ` id=${item.id}` : ''}${'name' in item ? ` ${item.name}` : ''} (${value.length} characters): ${preview}`];
        }).join('\n');
      }
      if (args.query && (source === 'tool' || args.id)) {
        const match = body.toLowerCase().indexOf(args.query.toLowerCase(), offset);
        if (match < 0) return { output: '(No matching text.)' };
        offset = Math.max(offset, match - 160);
      }
      const shown = body.slice(offset, offset + limit);
      return { output: `${shown || '(End of context.)'}\n[${source}${args.id ? ` id=${args.id}` : ''} offset=${offset}${offset + shown.length < body.length ? `; continue offset=${offset + shown.length}` : '; end'}]` };
    },
  });
}
