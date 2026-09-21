/** Append-only JSONL transcript plus the renderers that turn structured
 * items into what a transport can carry. The file on disk is never rewritten:
 * compaction appends a `compaction` marker, so the full history survives. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationItem } from './model-client.js';

export type TranscriptRecord =
  | { kind: 'item'; at: string; item: ConversationItem }
  /** Everything before this record is represented by `summary` when loading. */
  | { kind: 'compaction'; at: string; summary: string; keep: ConversationItem[] };

function safeSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || sessionId === '.' || sessionId === '..') throw new Error(`Invalid session id: ${sessionId}`);
  return sessionId;
}

export function transcriptPath(stateDir: string, sessionId: string): string {
  return path.join(stateDir, 'sessions', safeSessionId(sessionId), 'harness.jsonl');
}

function isItem(value: unknown): value is ConversationItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  switch (item.type) {
    case 'text': return (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string';
    case 'tool_call': return typeof item.id === 'string' && typeof item.name === 'string' && !!item.args && typeof item.args === 'object';
    case 'tool_result': return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.output === 'string';
    case 'summary': return typeof item.text === 'string';
    default: return false;
  }
}

export class ConversationStore {
  readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, sessionId: string) {
    this.file = transcriptPath(stateDir, sessionId);
  }

  private write(records: readonly TranscriptRecord[]): Promise<void> {
    const work = async (): Promise<void> => {
      if (!records.length) return;
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      // A torn previous write leaves no trailing newline; start on a fresh
      // line so the new record is not glued onto the damaged one.
      let prefix = '';
      try {
        const handle = await fs.open(this.file, 'r');
        try {
          const { size } = await handle.stat();
          if (size > 0) {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, size - 1);
            if (last[0] !== 0x0a) prefix = '\n';
          }
        } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fs.appendFile(this.file, prefix + records.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 });
    };
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  append(...items: ConversationItem[]): Promise<void> {
    const at = new Date().toISOString();
    return this.write(items.map((item) => ({ kind: 'item' as const, at, item })));
  }

  appendCompaction(summary: string, keep: readonly ConversationItem[]): Promise<void> {
    return this.write([{ kind: 'compaction', at: new Date().toISOString(), summary, keep: [...keep] }]);
  }

  /** The live (post-compaction) conversation. Unparseable lines — normally
   * only a torn final line after a crash — are skipped, never fatal. */
  async load(): Promise<ConversationItem[]> {
    let raw: string;
    try { raw = await fs.readFile(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    let items: ConversationItem[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object') continue;
      const entry = record as Partial<TranscriptRecord> & Record<string, unknown>;
      if (entry.kind === 'item' && isItem(entry.item)) items.push(entry.item);
      else if (entry.kind === 'compaction' && typeof entry.summary === 'string') {
        items = [{ type: 'summary', text: entry.summary }, ...(Array.isArray(entry.keep) ? entry.keep.filter(isItem) : [])];
      }
    }
    return repairDanglingCalls(items);
  }

  /** Every item ever recorded, ignoring compaction markers. */
  async loadFullHistory(): Promise<ConversationItem[]> {
    let raw: string;
    try { raw = await fs.readFile(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const items: ConversationItem[] = [];
    for (const line of raw.split('\n')) {
      try {
        const entry = JSON.parse(line) as { kind?: string; item?: unknown } | null;
        if (entry && entry.kind === 'item' && isItem(entry.item)) items.push(entry.item);
      } catch { /* torn line */ }
    }
    return items;
  }
}

/** A crash or cancel can leave a tool_call with no result. Structured
 * provider APIs reject that, so resume closes each one explicitly. */
export function repairDanglingCalls(items: readonly ConversationItem[]): ConversationItem[] {
  const answered = new Set(items.flatMap((item) => item.type === 'tool_result' ? [item.id] : []));
  const out: ConversationItem[] = [];
  let pending: Extract<ConversationItem, { type: 'tool_call' }>[] = [];
  const flush = (): void => {
    for (const call of pending) out.push({ type: 'tool_result', id: call.id, name: call.name, output: 'Interrupted before this tool call produced a result.', isError: true });
    pending = [];
  };
  for (const item of items) {
    if (item.type === 'tool_call') { out.push(item); if (!answered.has(item.id)) pending.push(item); continue; }
    if (item.type !== 'tool_result') flush();
    out.push(item);
  }
  flush();
  return out;
}

// ── transport renderers ──────────────────────────────────────────────────────

export interface FlatMessage { role: 'user' | 'assistant'; content: string }

export interface FlattenOptions {
  /** Cap for one tool result body. */
  maxResultChars?: number;
  maxArgsChars?: number;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - half * 2} characters truncated] …\n${text.slice(text.length - half)}`;
}

export function renderToolCallLine(item: Extract<ConversationItem, { type: 'tool_call' }>, maxArgsChars = 4000): string {
  return `[tool call ${item.id}] ${item.name}(${clip(JSON.stringify(item.args), maxArgsChars)})`;
}

/** String-threaded form for transports that only carry `{role, content}`.
 * Adjacent same-role fragments are merged so roles strictly alternate, and
 * the list always starts with a user message — both are hard requirements of
 * several provider APIs. */
export function flattenForTransport(items: readonly ConversationItem[], options: FlattenOptions = {}): FlatMessage[] {
  const maxResult = options.maxResultChars ?? 16_000;
  const parts: FlatMessage[] = [];
  for (const item of items) {
    if (item.type === 'text') { if (item.text) parts.push({ role: item.role, content: item.text }); }
    else if (item.type === 'summary') parts.push({ role: 'user', content: `Summary of the earlier conversation:\n${item.text}` });
    else if (item.type === 'tool_call') parts.push({ role: 'assistant', content: renderToolCallLine(item, options.maxArgsChars) });
    else parts.push({ role: 'user', content: `Tool result for ${item.name}(${item.id})${item.isError ? ' [error]' : ''}:\n${clip(item.output, maxResult) || '(no output)'}` });
  }
  const merged: FlatMessage[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && last.role === part.role) last.content = `${last.content}\n\n${part.content}`;
    else merged.push({ ...part });
  }
  if (merged[0]?.role === 'assistant') merged.unshift({ role: 'user', content: '(conversation resumed)' });
  return merged;
}

/** Future-proof structured form: one message per role run, with typed parts a
 * native tool-calling transport can map 1:1 onto its wire format. */
export type StructuredPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: string; isError: boolean };

export interface StructuredMessage { role: 'user' | 'assistant' | 'tool'; content: StructuredPart[] }

export function toStructuredMessages(items: readonly ConversationItem[]): StructuredMessage[] {
  const out: StructuredMessage[] = [];
  const push = (role: StructuredMessage['role'], part: StructuredPart): void => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(part);
    else out.push({ role, content: [part] });
  };
  for (const item of items) {
    if (item.type === 'text') push(item.role, { type: 'text', text: item.text });
    else if (item.type === 'summary') push('user', { type: 'text', text: `Summary of the earlier conversation:\n${item.text}` });
    else if (item.type === 'tool_call') push('assistant', { type: 'tool-call', toolCallId: item.id, toolName: item.name, input: item.args });
    else push('tool', { type: 'tool-result', toolCallId: item.id, toolName: item.name, output: item.output, isError: item.isError === true });
  }
  return out;
}
