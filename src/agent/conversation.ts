/** Append-only JSONL transcript plus the renderers that turn structured
 * items into what a transport can carry. The file on disk is never rewritten:
 * compaction appends a `compaction` marker, so the full history survives. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationItem, ImageInput } from './model-client.js';

/** Images live beside the item, never inside it: a build that predates them
 * loads `item` and hands it to the Gateway, whose schema rejects unknown item
 * fields, so an image inside the item would break that older build's resume. */
type TranscriptRecord =
  | { kind: 'item'; at: string; item: ConversationItem; images?: ImageInput[] }
  /** Everything before this record is represented by `summary` when loading.
   * `keepImages` maps an index in `keep` to that item's images. */
  | { kind: 'compaction'; at: string; summary: string; keep: ConversationItem[]; keepImages?: Record<string, ImageInput[]> };

function isImages(value: unknown): value is ImageInput[] {
  return Array.isArray(value) && value.length > 0 && value.every((image) => !!image && typeof image === 'object'
    && typeof (image as ImageInput).mimeType === 'string' && typeof (image as ImageInput).data === 'string');
}

/** Moves an item's images out to the record level (see TranscriptRecord). */
function splitImages(item: ConversationItem): { item: ConversationItem; images?: ImageInput[] } {
  if (item.type !== 'text' || !item.images?.length) return { item };
  const { images, ...rest } = item;
  return { item: rest, images: [...images] };
}

function withImages(item: ConversationItem, images: unknown): ConversationItem {
  if (item.type !== 'text' || !isImages(images)) return item;
  // Rebuilt from known fields so nothing but a valid image list is attached.
  return { ...item, images: images.map((image) => ({ mimeType: image.mimeType, data: image.data, ...(typeof image.name === 'string' ? { name: image.name } : {}) })) };
}

function safeSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || sessionId === '.' || sessionId === '..') throw new Error(`Invalid session id: ${sessionId}`);
  return sessionId;
}

function transcriptPath(stateDir: string, sessionId: string): string {
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
    return this.write(items.map((original) => {
      const { item, images } = splitImages(original);
      return { kind: 'item' as const, at, item, ...(images ? { images } : {}) };
    }));
  }

  appendCompaction(summary: string, keep: readonly ConversationItem[]): Promise<void> {
    const split = keep.map(splitImages);
    const keepImages: Record<string, ImageInput[]> = {};
    split.forEach((entry, index) => { if (entry.images) keepImages[index] = entry.images; });
    return this.write([{
      kind: 'compaction', at: new Date().toISOString(), summary, keep: split.map((entry) => entry.item),
      ...(Object.keys(keepImages).length ? { keepImages } : {}),
    }]);
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
      if (entry.kind === 'item' && isItem(entry.item)) items.push(withImages(entry.item, entry.images));
      else if (entry.kind === 'compaction' && typeof entry.summary === 'string') {
        const keepImages = entry.keepImages && typeof entry.keepImages === 'object' ? entry.keepImages as Record<string, unknown> : {};
        const keep = Array.isArray(entry.keep) ? entry.keep.flatMap((item: unknown, index: number) => isItem(item) ? [withImages(item, keepImages[index])] : []) : [];
        items = [{ type: 'summary', text: entry.summary }, ...keep];
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
        const entry = JSON.parse(line) as { kind?: string; item?: unknown; images?: unknown } | null;
        if (entry && entry.kind === 'item' && isItem(entry.item)) items.push(withImages(entry.item, entry.images));
      } catch { /* torn line */ }
    }
    return items;
  }
}

/** A crash or cancel can leave a tool_call with no result. Structured
 * provider APIs reject that, so resume closes each one explicitly. */
function repairDanglingCalls(items: readonly ConversationItem[]): ConversationItem[] {
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

interface FlattenOptions {
  /** Cap for one tool result body. */
  maxResultChars?: number;
  maxArgsChars?: number;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - half * 2} characters truncated] …\n${text.slice(text.length - half)}`;
}

function renderToolCallLine(item: Extract<ConversationItem, { type: 'tool_call' }>, maxArgsChars = 4000): string {
  return `[tool call ${item.id}] ${item.name}(${clip(JSON.stringify(item.args), maxArgsChars)})`;
}

/** Future-proof structured form: one message per role run, with typed parts a
 * native tool-calling transport can map 1:1 onto its wire format. */
type StructuredPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: string; isError: boolean };

interface StructuredMessage { role: 'user' | 'assistant' | 'tool'; content: StructuredPart[] }

function toStructuredMessages(items: readonly ConversationItem[]): StructuredMessage[] {
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
