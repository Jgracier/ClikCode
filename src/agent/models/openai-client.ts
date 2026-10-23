import { ContextFitError, estimateRequestTokens, responseReserve } from '../context-view.js';
/** ModelClient for any OpenAI-compatible server (llama.cpp's llama-server,
 * vLLM, OpenAI itself, most hosted providers):
 * `POST {baseUrl}/v1/chat/completions` with `stream: true`. */
import type { ConversationItem, ImageInput, ModelClient, ReasoningBlock, ModelStepRequest, ModelStepResult, ModelToolCall, TokenUsage, ToolSpec } from '../model-client.js';
import { turnCancelledError } from '../cancellation.js';
import { lifecycle } from '../../runtime/lifecycle-log.js';
import type { ContextHints } from '../context-profile.js';
import { ModelClientError, parseRetryAfter, readWithin, SseParser, STREAM_IDLE_TIMEOUT_MS, type SseEvent } from './gateway-client.js';

/** llama-server's per-request timings, passed through for callers that show speed. */
interface LlamaTimings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
  cache_n?: number;
}

interface OpenAIModelClientOptions {
  /** Server root, with or without a trailing `/v1`. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** The window the server was started with; reported back to the loop. */
  contextWindow?: number;
  /** Measured prompt reading speed, tokens/s, when the server's owner knows
   * it (ClikCode Local); with the window it picks the context profile. */
  promptPerSecond?: number;
  /** Send user images as `image_url` parts. Off by default: a text-only
   * server either rejects them or silently drops them. */
  vision?: boolean;
  headers?: Readonly<Record<string, string>>;
  /** Merged over the request body last, e.g. `{ temperature: 0.2 }`. */
  body?: Readonly<Record<string, unknown>>;
  /** Display name for error messages. */
  label?: string;
  fetchImpl?: typeof fetch;
  /** Longest silence once the answer has started (STREAM_IDLE_TIMEOUT_MS). */
  idleTimeoutMs?: number;
  /** Longest wait for the first chunk. Far longer than the idle limit: a
   * server on a CPU reads a deep prompt for minutes before it says anything,
   * and llama-server sends nothing at all while it reads. */
  firstChunkTimeoutMs?: number;
  /** A hosted service rather than a server on this machine (context-profile.ts). */
  hosted?: boolean;
  /** The server's own error codes, as the codes the agent loop acts on
   * (turn-recovery.ts stepRecovery), e.g. `{ rate_limit_exceeded: 'MODEL_RATE_LIMITED' }`.
   * An unmapped code is kept in the message only. */
  errorCodes?: Readonly<Record<string, string>>;
  /** Added to an out-of-credit refusal (HTTP 402): how to add credit. */
  creditHint?: string;
  /** The most the model writes in one answer: sent as `max_tokens`, less
   * whatever of the window the prompt already takes. */
  maxOutputTokens?: number;
  /** What the server refuses outright; a request is fitted to these before
   * it is sent rather than sent to be rejected. */
  limits?: RequestLimits;
  /** The server's own error in words that say what to do about it; undefined
   * keeps the server's message. */
  describeError?: (error: { status?: number; code?: string; message: string; retryAfter?: number }) => string | undefined;
}

/** Hard limits on one request, as a server enforces them with a 400. */
interface RequestLimits {
  /** Chat messages, the system prompt included. */
  messages?: number;
  /** Conversation items: a server that counts what a message carries (a call, a result, a text) counts more than messages. */
  items?: number;
  tools?: number;
  /** One tool's `parameters`, serialized. */
  schemaBytes?: number;
  systemBytes?: number;
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A schema with its descriptions taken out: the first thing to go when one
 * is over the size a server takes. */
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => !(key === 'description' && typeof child === 'string')).map(([key, child]) => [key, withoutDescriptions(child)]));
}

/** The system prompt and the tools as the server takes them. Tools are kept
 * in the order given (the built-in ones first), an oversized schema loses its
 * descriptions before its tool is dropped, and a system prompt over the
 * limit loses its end. A conversation with too many messages is not cut
 * here: the loop compacts it (CONTEXT_TOO_LARGE). */
export function fitToLimits(system: string, tools: readonly ToolSpec[], limits: RequestLimits): { system: string; tools: ToolSpec[] } {
  const fitted: ToolSpec[] = [];
  const dropped: string[] = [];
  for (const tool of tools) {
    if (limits.tools !== undefined && fitted.length >= limits.tools) { dropped.push(tool.name); continue; }
    if (limits.schemaBytes === undefined || bytes(JSON.stringify(tool.parameters)) <= limits.schemaBytes) { fitted.push(tool); continue; }
    const parameters = withoutDescriptions(tool.parameters) as Record<string, unknown>;
    if (bytes(JSON.stringify(parameters)) <= limits.schemaBytes) fitted.push({ ...tool, parameters });
    else dropped.push(tool.name);
  }
  if (dropped.length) throw new ModelClientError(`The server cannot accept the required tool schemas: ${dropped.join(', ')}. No tool was silently removed.`, { kind: 'other', code: 'REQUEST_LIMIT_EXCEEDED' });
  if (limits.systemBytes !== undefined && bytes(system) > limits.systemBytes) {
    throw new ModelClientError(`The instructions exceed the server's ${limits.systemBytes}-byte system limit. No instructions were removed.`, { kind: 'other', code: 'REQUEST_LIMIT_EXCEEDED' });
  }
  return { system, tools: fitted };
}

const FIRST_CHUNK_TIMEOUT_MS = 30 * 60_000;

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface WireToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

/** OpenRouter's `reasoning_details` entry: how the Gateway sends a block's signature out and takes it back. */
type ReasoningDetail = { type: 'reasoning.text'; text: string; signature: string } | { type: 'reasoning.encrypted'; data: string };

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[]; reasoning_details?: ReasoningDetail[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Consecutive user text (a summary followed by a steer, say) is merged into
 * one message, and an assistant's text joins the tool calls that follow it:
 * several chat templates reject two messages of one role in a row.
 * A tool message carries text only, so images a tool showed (read_file on a
 * picture) follow the run of tool messages as one user message, as other
 * harnesses send them; the calls' results stay together, as the API needs. */
export function toChatMessages(system: string, items: readonly ConversationItem[], vision: boolean, model?: string): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  const pushUser = (text: string, images: readonly ImageInput[] = []): void => {
    const parts: ContentPart[] = [{ type: 'text', text }, ...(vision ? images.map((image): ContentPart => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } })) : [])];
    const last = out[out.length - 1];
    if (last?.role === 'user') {
      const previous: ContentPart[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      last.content = [...previous, ...parts];
    } else out.push({ role: 'user', content: parts });
  };
  const assistant = (): Extract<ChatMessage, { role: 'assistant' }> => {
    const last = out[out.length - 1];
    if (last?.role === 'assistant') return last;
    const created: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', content: null };
    out.push(created);
    return created;
  };
  let toolImages: ImageInput[] = [];
  const flushToolImages = (): void => {
    if (!toolImages.length) return;
    const shown = toolImages;
    toolImages = [];
    pushUser(`[${shown.length === 1 ? 'Image' : 'Images'} from the tool results above: ${shown.map((image, index) => image.name ?? `image ${index + 1}`).join(', ')}]`, shown);
  };
  for (const item of items) {
    if (item.type !== 'tool_result') flushToolImages();
    if (item.type === 'summary') pushUser(`Summary of the earlier conversation:\n${item.text}`);
    // Reasoning goes back only to the model that wrote it: another vendor rejects its signature.
    else if (item.type === 'reasoning') {
      if (item.model !== model) continue;
      const detail: ReasoningDetail | undefined = item.redactedData ? { type: 'reasoning.encrypted', data: item.redactedData } : item.signature ? { type: 'reasoning.text', text: item.text, signature: item.signature } : undefined;
      if (detail) (assistant().reasoning_details ??= []).push(detail);
    }
    else if (item.type === 'text' && item.role === 'user') pushUser(item.text, item.images);
    else if (item.type === 'text') {
      const message = assistant();
      // Text after tool calls starts a new message: the calls' results sit between them.
      if (message.tool_calls?.length) out.push({ role: 'assistant', content: item.text });
      else message.content = message.content ? `${message.content}\n\n${item.text}` : item.text;
    } else if (item.type === 'tool_call') {
      const message = assistant();
      (message.tool_calls ??= []).push({ id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } });
    } else {
      out.push({ role: 'tool', tool_call_id: item.id, content: item.isError ? `Error: ${item.output}` : item.output });
      if (vision && item.images?.length) toolImages.push(...item.images);
    }
  }
  flushToolImages();
  // Plain strings where no image is involved: the widest-supported form.
  for (const message of out) {
    if (message.role === 'user' && Array.isArray(message.content) && message.content.every((part) => part.type === 'text')) {
      message.content = message.content.map((part) => (part as { text: string }).text).join('\n\n');
    }
  }
  return out;
}

function toolsBody(tools: readonly ToolSpec[], toolChoice?: 'none'): { tools?: unknown[]; tool_choice?: 'none' } {
  if (!tools.length) return {};
  return {
    tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

/** Models emit arguments wrapped in a code fence, or with a trailing comma,
 * often enough to be worth one repair attempt before calling them broken. */
export function parseToolArguments(raw: string): { args: Record<string, unknown>; error?: string } {
  const text = raw.trim();
  if (!text) return { args: {} };
  const attempts = [text, text.replace(/^```(?:json)?\s*|\s*```$/g, '').replace(/,\s*([}\]])/g, '$1')];
  let failure = '';
  for (const attempt of attempts) {
    try {
      const value: unknown = JSON.parse(attempt);
      // Some models double-encode: a JSON string holding the object.
      const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { args: parsed as Record<string, unknown> };
      failure = `got ${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed}`;
    } catch (error) { failure ||= error instanceof Error ? error.message : String(error); }
  }
  return { args: {}, error: `${failure}; received: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}` };
}

/** The arguments of a call still being written, as far as they are known:
 * every top-level field whose value has arrived whole. `{"path":"src/a.ts",
 * "content":"export…` is `{ path: 'src/a.ts' }`, enough to name the row. */
export function completedArguments(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text.startsWith('{')) return {};
  const whole = parseToolArguments(text);
  if (!whole.error) return whole.args;
  // The commas between top-level fields, outside any string or nested value.
  const ends: number[] = [];
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    else if (char === ',' && depth === 1) ends.push(index);
  }
  for (const end of ends.reverse()) {
    try {
      const value: unknown = JSON.parse(`${text.slice(0, end)}}`);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* an earlier field boundary may still parse */ }
  }
  return {};
}

const STOP_REASONS: Readonly<Record<string, string>> = { stop: 'stop', tool_calls: 'tool-calls', function_call: 'tool-calls', length: 'length', content_filter: 'content-filter' };

/** Servers word "does not fit" differently; each becomes the Gateway's code,
 * which the loop already answers by compacting and retrying once. */
function isContextOverflow(status: number, code: string | undefined, message: string): boolean {
  if (code === 'context_length_exceeded' || code === 'exceed_context_size_error') return true;
  return status === 400 && /context (?:length|size|window)|maximum context|too many tokens|exceeds? the available context/i.test(message);
}

/** Out of quota or credit, in the words servers use for it. */
const QUOTA_CODES = new Set(['rate_limit_exceeded', 'insufficient_quota', 'insufficient_credits', 'rate_limit_error']);

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Some model-serving stacks return `<think>…</think>` inside ordinary
 * content deltas instead of separating reasoning. Keep reasoning tags out of
 * the saved/displayed answer for Gateway models. Incremental parsing means
 * tags split across SSE frames are never flashed; the normal turn animation
 * remains active, then the answer streams through the shared Markdown path. */
class InlineThinkFilter {
  private buffer = '';
  private thinking = false;

  push(
    chunk: string,
    onText: (text: string) => void,
  ): void {
    this.buffer += chunk;
    for (;;) {
      if (this.thinking) {
        const end = this.buffer.indexOf('</think>');
        if (end >= 0) {
          this.buffer = this.buffer.slice(end + '</think>'.length);
          this.thinking = false;
          continue;
        }
        const keep = this.suffixPrefixLength(this.buffer, '</think>');
        const safe = this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(safe.length);
        return;
      }
      const start = this.buffer.indexOf('<think>');
      if (start >= 0) {
        if (start) onText(this.buffer.slice(0, start));
        this.buffer = this.buffer.slice(start + '<think>'.length);
        this.thinking = true;
        continue;
      }
      const keep = this.suffixPrefixLength(this.buffer, '<think>');
      const safe = this.buffer.slice(0, this.buffer.length - keep);
      if (safe) onText(safe);
      this.buffer = this.buffer.slice(safe.length);
      return;
    }
  }

  /** Flush ordinary trailing text; an unterminated reasoning block stays hidden. */
  finish(onText: (text: string) => void): void {
    if (!this.thinking && this.buffer) onText(this.buffer);
    this.buffer = '';
  }

  private suffixPrefixLength(text: string, token: string): number {
    const max = Math.min(text.length, token.length - 1);
    for (let size = max; size > 0; size--) if (text.endsWith(token.slice(0, size))) return size;
    return 0;
  }
}

interface PendingCall { id?: string; name: string; arguments: string; argsObject?: Record<string, unknown>; shownId?: string }

/** Tokens a request's text is taken to hold, for leaving the answer room in
 * the window: a deliberately rough four characters each. */

export class OpenAIModelClient implements ModelClient {
  /** Set by the Gateway client (for-session.ts): how the start of the user's own model is going. */
  startStatus?: ModelClient['startStatus'];
  readonly acceptsImages: boolean;
  readonly contextHints: ContextHints;

  constructor(private readonly options: OpenAIModelClientOptions) {
    this.acceptsImages = options.vision === true;
    this.contextHints = {
      ...(options.hosted ? { hosted: true } : {}),
      ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
      ...(options.promptPerSecond ? { promptPerSecond: options.promptPerSecond } : {}),
    };
  }

  /** The window the server said it serves, from an earlier step. */
  private servedWindow: number | undefined;

  private get label(): string { return this.options.label ?? 'The model server'; }

  /** `max_tokens` for this request: the model's own limit, or less when the
   * prompt leaves less than that of the window. */
  private maxTokens(request: ModelStepRequest): number | undefined {
    const window = this.servedWindow ?? this.options.contextWindow;
    const limit = this.options.maxOutputTokens;
    if (!window) return limit;
    const reserve = responseReserve(window, limit);
    const input = estimateRequestTokens(request.system, request.items, request.tools);
    if (input + reserve + Math.max(128, Math.ceil(window * 0.05)) > window) throw new ContextFitError(input + reserve, window);
    return reserve;
  }

  private describe(message: string, details: { status?: number; code?: string; retryAfter?: number }): string {
    return this.options.describeError?.({ ...details, message }) ?? message;
  }

  private endpoint(): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    return `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`;
  }

  async step(request: ModelStepRequest): Promise<ModelStepResult> {
    const { options } = this;
    const doFetch = options.fetchImpl ?? fetch;
    const fitted = options.limits ? fitToLimits(request.system, request.tools, options.limits) : { system: request.system, tools: request.tools };
    const messages = toChatMessages(fitted.system, request.items, this.acceptsImages, options.model);
    if (options.limits?.items !== undefined && request.items.length > options.limits.items) {
      throw new ModelClientError(`${this.label}: the conversation has ${request.items.length} items, more than the ${options.limits.items} one request may carry`, { kind: 'other', code: 'CONTEXT_TOO_LARGE' });
    }
    if (options.limits?.messages !== undefined && messages.length > options.limits.messages) {
      throw new ModelClientError(`${this.label}: the conversation has ${messages.length} messages, more than the ${options.limits.messages} one request may carry`, { kind: 'other', code: 'CONTEXT_TOO_LARGE' });
    }
    const tools = toolsBody(fitted.tools, request.toolChoice);
    const maxTokens = this.maxTokens({ ...request, system: fitted.system, tools: fitted.tools });
    let response: Response;
    const requestedAt = Date.now();
    try {
      response = await doFetch(this.endpoint(), {
        method: 'POST',
        headers: {
          accept: 'text/event-stream', 'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...options.headers,
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          ...tools,
          stream: true,
          // Without this OpenAI sends no usage at all on a stream; servers that
          // report usage anyway (llama-server) accept and ignore it.
          stream_options: { include_usage: true },
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...options.body,
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (request.signal?.aborted) throw turnCancelledError();
      lifecycle('model.request', { label: this.label, model: options.model, ms: Date.now() - requestedAt, outcome: 'unreachable' });
      throw new ModelClientError(`Could not reach ${this.label} at ${options.baseUrl}: ${error instanceof Error ? error.message : String(error)}`, { kind: 'other' });
    }
    lifecycle('model.request', { label: this.label, model: options.model, status: response.status, ms: Date.now() - requestedAt });
    if (!response.ok) throw await this.httpError(response);
    // A server that names each request (the Gateway, OpenAI) has that name
    // put on every error, so a failure can be looked up where it happened.
    const requestId = response.headers.get('x-request-id')?.trim() || undefined;
    const withRequestId = (message: string) => (requestId ? `${message} [request ${requestId}]` : message);
    if (!response.body) throw new ModelClientError(`${this.label} returned an empty response`, { kind: 'other', statusCode: response.status });

    const parser = new SseParser();
    let text = '';
    const pending: PendingCall[] = [];
    const byIndex = new Map<number, PendingCall>();
    let usage: TokenUsage = {};
    let stopReason: string | undefined;
    let done = false;
    let servedModel: string | undefined;
    let servedWindow: number | undefined;
    let timings: LlamaTimings | undefined;
    const blocks: ReasoningBlock[] = [];
    // `auto` and Gateway aliases do not always identify the selected model in
    // the request. The stream's `model` field is authoritative when present.
    let inlineThink = this.label === 'ClikDeploy Gateway'
      // Gateway aliases may resolve to any served model, and content can
      // arrive before the stream identifies the selected model.
      ? new InlineThinkFilter()
      : undefined;
    const emitText = (chunk: string): void => { if (chunk) { text += chunk; request.onTextDelta(chunk); } };

    const handle = (event: SseEvent): void => {
      if (!event.data) return;
      if (event.data.trim() === '[DONE]') { done = true; return; }
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      if (frame.error) {
        const error = (typeof frame.error === 'object' ? frame.error : { message: frame.error }) as { message?: unknown; code?: unknown; type?: unknown; retry_after?: unknown };
        const message = typeof error.message === 'string' && error.message ? error.message : `${this.label} reported an error`;
        const code = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : undefined;
        const loopCode = isContextOverflow(400, code, message) ? 'CONTEXT_TOO_LARGE' : code ? options.errorCodes?.[code] : undefined;
        const retryAfter = parseRetryAfter(error.retry_after);
        const kind = code && QUOTA_CODES.has(code) ? 'quota' : 'other';
        const described = this.describe(`${this.label}: ${message}`, { ...(code ? { code } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}) });
        throw new ModelClientError(withRequestId(described), { kind, ...(loopCode ? { code: loopCode } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}) });
      }
      // Not OpenAI's: a gateway saying how large the serving model's window
      // is (`context_length` as its model list names it).
      const window = numberOf(frame.context_window) ?? numberOf(frame.context_length);
      if (window) { servedWindow = window; this.servedWindow = window; }
      if (typeof frame.model === 'string' && frame.model && frame.model !== servedModel) {
        servedModel = frame.model;
        // Also handle Gateway model IDs that arrive after initial content.
        if (!inlineThink && this.label === 'ClikDeploy Gateway') inlineThink = new InlineThinkFilter();
        request.onServedModel?.(servedModel, servedWindow);
      }
      if (frame.usage && typeof frame.usage === 'object') usage = { ...usage, ...usageFrom(frame.usage as Record<string, unknown>) };
      if (frame.timings && typeof frame.timings === 'object') timings = frame.timings as LlamaTimings;
      const choice = Array.isArray(frame.choices) ? frame.choices[0] as Record<string, unknown> | undefined : undefined;
      if (!choice) return;
      const delta = (choice.delta && typeof choice.delta === 'object' ? choice.delta : {}) as Record<string, unknown>;
      if (typeof delta.content === 'string' && delta.content) {
        if (inlineThink) inlineThink.push(delta.content, emitText);
        else emitText(delta.content);
      }
      // `reasoning_content` is llama.cpp and DeepSeek; `reasoning` is OpenRouter and vLLM.
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
      // Keep private model reasoning out of the transcript. Final content
      // still uses the normal streaming Markdown renderer and tool calls remain
      // structured events. Other OpenAI-compatible providers keep their
      // existing reasoning activity behavior.
      if (reasoning && this.label !== 'ClikDeploy Gateway') request.onReasoningDelta?.(reasoning);
      // The Gateway's finished blocks, with the signature that lets them be sent back.
      if (Array.isArray(delta.reasoning_details)) {
        for (const raw of delta.reasoning_details as Record<string, unknown>[]) {
          if (!raw || typeof raw !== 'object') continue;
          if (raw.type === 'reasoning.encrypted' && typeof raw.data === 'string' && raw.data) blocks.push({ text: '', redactedData: raw.data, model: options.model });
          else if (raw.type === 'reasoning.text' && typeof raw.signature === 'string' && raw.signature) blocks.push({ text: typeof raw.text === 'string' ? raw.text : '', signature: raw.signature, model: options.model });
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls as Record<string, unknown>[]) {
          if (!raw || typeof raw !== 'object') continue;
          const fn = (raw.function && typeof raw.function === 'object' ? raw.function : {}) as Record<string, unknown>;
          const id = typeof raw.id === 'string' && raw.id ? raw.id : undefined;
          // Fragments are keyed by index. A server that omits it sends each
          // call whole or continues the last one, so an id marks a new call.
          const index = numberOf(raw.index);
          let call = index !== undefined ? byIndex.get(index) : (id ? pending.find((entry) => entry.id === id) : undefined) ?? (id ? undefined : pending[pending.length - 1]);
          if (!call) {
            call = { name: '', arguments: '' };
            pending.push(call);
            if (index !== undefined) byIndex.set(index, call);
          }
          if (id && !call.id) call.id = id;
          // The name is sent once; a server that repeats it in every fragment
          // (or sends it whole each time) must not have it concatenated.
          if (typeof fn.name === 'string' && fn.name && call.name !== fn.name) call.name = call.name && !fn.name.startsWith(call.name) ? `${call.name}${fn.name}` : fn.name;
          if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
          else if (fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)) call.argsObject = fn.arguments as Record<string, unknown>;
          // Shown from the moment it has a name, under the id it will finish
          // with: a call that streams its arguments is on screen while it is
          // written, as a vendor CLI's is.
          if (call.name && request.onToolCallDelta) {
            call.shownId ??= call.id ?? `call_${pending.indexOf(call) + 1}_${Date.now().toString(36)}`;
            request.onToolCallDelta({ id: call.shownId, name: call.name, arguments: call.argsObject && !call.arguments.trim() ? JSON.stringify(call.argsObject) : call.arguments });
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) stopReason = STOP_REASONS[choice.finish_reason] ?? choice.finish_reason;
    };

    const reader = response.body.getReader();
    try {
      let started = false;
      for (;;) {
        const limit = started ? options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS : options.firstChunkTimeoutMs ?? FIRST_CHUNK_TIMEOUT_MS;
        const { done: ended, value } = await readWithin(reader, limit, this.label);
        started = true;
        if (ended) break;
        if (value) for (const event of parser.push(value)) handle(event);
      }
      for (const event of parser.flush()) handle(event);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (request.signal?.aborted) throw turnCancelledError();
      if (error instanceof ModelClientError) throw error;
      throw new ModelClientError(`${this.label} stream failed: ${error instanceof Error ? error.message : String(error)}`, { kind: 'other' });
    }
    inlineThink?.finish(emitText);
    // Neither a finish reason nor [DONE]: the connection was cut mid-answer,
    // and taking the partial text as the answer would drop its tool calls.
    if (stopReason === undefined && !done) throw new ModelClientError(`${this.label} stream ended before the answer finished`, { kind: 'other', code: 'incomplete_stream' });

    if (timings) {
      // llama-server without usage: its timings carry the same counts.
      const prompt = numberOf(timings.prompt_n);
      const cached = numberOf(timings.cache_n);
      if (usage.input === undefined && prompt !== undefined) usage.input = prompt + (cached ?? 0);
      if (usage.output === undefined && numberOf(timings.predicted_n) !== undefined) usage.output = timings.predicted_n;
      if (usage.cached === undefined && cached) usage.cached = cached;
    }

    const toolCalls: ModelToolCall[] = pending.filter((call) => call.name).map((call, offset) => {
      const id = call.shownId ?? call.id ?? `call_${offset + 1}_${Date.now().toString(36)}`;
      if (call.argsObject && !call.arguments.trim()) return { id, name: call.name, args: call.argsObject };
      const parsed = parseToolArguments(call.arguments);
      return { id, name: call.name, args: parsed.args, ...(parsed.error ? { argumentsError: parsed.error } : {}) };
    });
    return {
      text, toolCalls,
      stopReason: stopReason ?? (toolCalls.length ? 'tool-calls' : 'stop'),
      usage,
      ...(blocks.length ? { reasoning: blocks } : {}),
      ...(servedModel ? { servedModel } : {}),
      ...(servedWindow ?? options.contextWindow ? { contextWindow: servedWindow ?? options.contextWindow } : {}),
    };
  }

  private async httpError(response: Response): Promise<ModelClientError> {
    const status = response.status;
    let message = `${this.label} returned HTTP ${status}`;
    let code: string | undefined;
    let retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    let raw = '';
    try { raw = await response.text(); } catch { /* the status line is the message */ }
    try {
      const body = JSON.parse(raw) as { error?: unknown; message?: unknown; code?: unknown };
      const nested = body.error && typeof body.error === 'object' ? body.error as { message?: unknown; code?: unknown; type?: unknown; retry_after?: unknown } : undefined;
      retryAfter ??= parseRetryAfter(nested?.retry_after);
      const detail = nested?.message ?? body.message ?? (typeof body.error === 'string' ? body.error : undefined);
      if (typeof detail === 'string' && detail) message = `${message}: ${detail}`;
      const rawCode = nested?.code ?? body.code ?? nested?.type;
      if (typeof rawCode === 'string') code = rawCode;
      else if (typeof rawCode === 'number') code = String(rawCode);
    } catch {
      if (raw.trim()) message = `${message}: ${raw.trim().slice(0, 500)}`;
    }
    const kind = status === 401 || status === 403 ? 'auth' : status === 402 || status === 429 ? 'quota' : 'other';
    // Only a code the loop acts on is passed through: any other code would
    // stop it retrying a 5xx (stepRecovery (turn-recovery.ts) treats an unknown code as final).
    // The server's own code is still in the message.
    if (code && !message.includes(code)) message = `${message} (${code})`;
    if (status === 402 && this.options.creditHint) message = `${message} ${this.options.creditHint}`;
    message = this.describe(message, { status, ...(code ? { code } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}) });
    const requestId = response.headers.get('x-request-id')?.trim();
    if (requestId) message = `${message} [request ${requestId}]`;
    const loopCode = isContextOverflow(status, code, message) ? 'CONTEXT_TOO_LARGE' : code ? this.options.errorCodes?.[code] : undefined;
    return new ModelClientError(message, { kind, statusCode: status, ...(loopCode ? { code: loopCode } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}) });
  }
}

function usageFrom(raw: Record<string, unknown>): TokenUsage {
  const out: TokenUsage = {};
  const input = numberOf(raw.prompt_tokens);
  const output = numberOf(raw.completion_tokens);
  const promptDetails = (raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object' ? raw.prompt_tokens_details : {}) as Record<string, unknown>;
  const completionDetails = (raw.completion_tokens_details && typeof raw.completion_tokens_details === 'object' ? raw.completion_tokens_details : {}) as Record<string, unknown>;
  const cached = numberOf(promptDetails.cached_tokens);
  const reasoning = numberOf(completionDetails.reasoning_tokens);
  // USD; OpenRouter and the ClikDeploy Gateway report what the call cost. When the provider was
  // paid directly rather than through the server (OpenRouter's own-key calls, the Gateway's
  // operator, charged 0) that part is cost_details.upstream_inference_cost: the spend is the sum.
  const costDetails = (raw.cost_details && typeof raw.cost_details === 'object' ? raw.cost_details : {}) as Record<string, unknown>;
  const cost = numberOf(raw.cost);
  const upstream = numberOf(costDetails.upstream_inference_cost);
  if (cost !== undefined || upstream !== undefined) out.costMicroUsd = Math.round(((cost ?? 0) + (upstream ?? 0)) * 1_000_000);
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cached !== undefined) out.cached = cached;
  if (reasoning !== undefined) out.reasoning = reasoning;
  return out;
}
