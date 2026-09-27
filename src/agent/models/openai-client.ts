/** ModelClient for any OpenAI-compatible server (llama.cpp's llama-server,
 * vLLM, OpenAI itself, most hosted providers):
 * `POST {baseUrl}/v1/chat/completions` with `stream: true`. */
import type { ConversationItem, ImageInput, ModelClient, ModelStepRequest, ModelStepResult, ModelToolCall, TokenUsage, ToolSpec } from '../model-client.js';
import { turnCancelledError } from '../cancellation.js';
import type { ContextHints } from '../context-profile.js';
import { ModelClientError, parseRetryAfter, SseParser, type SseEvent } from './gateway-client.js';

/** llama-server's per-request timings, passed through for callers that show speed. */
export interface LlamaTimings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
  cache_n?: number;
}

export interface OpenAIModelClientOptions {
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
  onTimings?: (timings: LlamaTimings) => void;
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface WireToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Consecutive user text (a summary followed by a steer, say) is merged into
 * one message, and an assistant's text joins the tool calls that follow it:
 * several chat templates reject two messages of one role in a row. */
export function toChatMessages(system: string, items: readonly ConversationItem[], vision: boolean): ChatMessage[] {
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
  for (const item of items) {
    if (item.type === 'summary') pushUser(`Summary of the earlier conversation:\n${item.text}`);
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
    }
  }
  // Plain strings where no image is involved: the widest-supported form.
  for (const message of out) {
    if (message.role === 'user' && Array.isArray(message.content) && message.content.every((part) => part.type === 'text')) {
      message.content = message.content.map((part) => (part as { text: string }).text).join('\n\n');
    }
  }
  return out;
}

function toolsBody(tools: readonly ToolSpec[]): Record<string, unknown> {
  if (!tools.length) return {};
  return { tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) };
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

const STOP_REASONS: Readonly<Record<string, string>> = { stop: 'stop', tool_calls: 'tool-calls', function_call: 'tool-calls', length: 'length', content_filter: 'content-filter' };

/** Servers word "does not fit" differently; each becomes the Gateway's code,
 * which the loop already answers by compacting and retrying once. */
function isContextOverflow(status: number, code: string | undefined, message: string): boolean {
  if (code === 'context_length_exceeded' || code === 'exceed_context_size_error') return true;
  return status === 400 && /context (?:length|size|window)|maximum context|too many tokens|exceeds? the available context/i.test(message);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

interface PendingCall { id?: string; name: string; arguments: string; argsObject?: Record<string, unknown> }

export class OpenAIModelClient implements ModelClient {
  readonly acceptsImages: boolean;
  readonly contextHints: ContextHints;

  constructor(private readonly options: OpenAIModelClientOptions) {
    this.acceptsImages = options.vision === true;
    this.contextHints = {
      ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
      ...(options.promptPerSecond ? { promptPerSecond: options.promptPerSecond } : {}),
    };
  }

  private get label(): string { return this.options.label ?? 'The model server'; }

  private endpoint(): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    return `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`;
  }

  async step(request: ModelStepRequest): Promise<ModelStepResult> {
    const { options } = this;
    const doFetch = options.fetchImpl ?? fetch;
    let response: Response;
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
          messages: toChatMessages(request.system, request.items, this.acceptsImages),
          ...toolsBody(request.tools),
          stream: true,
          // Without this OpenAI sends no usage at all on a stream; servers that
          // report usage anyway (llama-server) accept and ignore it.
          stream_options: { include_usage: true },
          ...options.body,
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (request.signal?.aborted) throw turnCancelledError();
      throw new ModelClientError(`Could not reach ${this.label} at ${options.baseUrl}: ${error instanceof Error ? error.message : String(error)}`, { kind: 'other' });
    }
    if (!response.ok) throw await this.httpError(response);
    if (!response.body) throw new ModelClientError(`${this.label} returned an empty response`, { kind: 'other', statusCode: response.status });

    const parser = new SseParser();
    let text = '';
    const pending: PendingCall[] = [];
    const byIndex = new Map<number, PendingCall>();
    let usage: TokenUsage = {};
    let stopReason: string | undefined;
    let done = false;
    let servedModel: string | undefined;
    let timings: LlamaTimings | undefined;

    const handle = (event: SseEvent): void => {
      if (!event.data) return;
      if (event.data.trim() === '[DONE]') { done = true; return; }
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      if (frame.error) {
        const error = (typeof frame.error === 'object' ? frame.error : { message: frame.error }) as { message?: unknown; code?: unknown; type?: unknown };
        const message = typeof error.message === 'string' && error.message ? error.message : `${this.label} reported an error`;
        const code = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : undefined;
        throw new ModelClientError(`${this.label}: ${message}`, { kind: 'other', ...(isContextOverflow(400, code, message) ? { code: 'CONTEXT_TOO_LARGE' } : {}) });
      }
      if (typeof frame.model === 'string' && frame.model) servedModel = frame.model;
      if (frame.usage && typeof frame.usage === 'object') usage = { ...usage, ...usageFrom(frame.usage as Record<string, unknown>) };
      if (frame.timings && typeof frame.timings === 'object') timings = frame.timings as LlamaTimings;
      const choice = Array.isArray(frame.choices) ? frame.choices[0] as Record<string, unknown> | undefined : undefined;
      if (!choice) return;
      const delta = (choice.delta && typeof choice.delta === 'object' ? choice.delta : {}) as Record<string, unknown>;
      if (typeof delta.content === 'string' && delta.content) { text += delta.content; request.onTextDelta(delta.content); }
      // `reasoning_content` is llama.cpp and DeepSeek; `reasoning` is OpenRouter and vLLM.
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
      if (reasoning) request.onReasoningDelta?.(reasoning);
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
          if (typeof fn.name === 'string') call.name += fn.name;
          if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
          else if (fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)) call.argsObject = fn.arguments as Record<string, unknown>;
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) stopReason = STOP_REASONS[choice.finish_reason] ?? choice.finish_reason;
    };

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
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
    // Neither a finish reason nor [DONE]: the connection was cut mid-answer,
    // and taking the partial text as the answer would drop its tool calls.
    if (stopReason === undefined && !done) throw new ModelClientError(`${this.label} stream ended before the answer finished`, { kind: 'other', code: 'incomplete_stream' });

    if (timings) {
      options.onTimings?.(timings);
      // llama-server without usage: its timings carry the same counts.
      const prompt = numberOf(timings.prompt_n);
      const cached = numberOf(timings.cache_n);
      if (usage.input === undefined && prompt !== undefined) usage.input = prompt + (cached ?? 0);
      if (usage.output === undefined && numberOf(timings.predicted_n) !== undefined) usage.output = timings.predicted_n;
      if (usage.cached === undefined && cached) usage.cached = cached;
    }

    const toolCalls: ModelToolCall[] = pending.filter((call) => call.name).map((call, offset) => {
      const id = call.id ?? `call_${offset + 1}_${Date.now().toString(36)}`;
      if (call.argsObject && !call.arguments.trim()) return { id, name: call.name, args: call.argsObject };
      const parsed = parseToolArguments(call.arguments);
      return { id, name: call.name, args: parsed.args, ...(parsed.error ? { argumentsError: parsed.error } : {}) };
    });
    return {
      text, toolCalls,
      stopReason: stopReason ?? (toolCalls.length ? 'tool-calls' : 'stop'),
      usage,
      ...(servedModel ? { servedModel } : {}),
      ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
    };
  }

  private async httpError(response: Response): Promise<ModelClientError> {
    const status = response.status;
    let message = `${this.label} returned HTTP ${status}`;
    let code: string | undefined;
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    let raw = '';
    try { raw = await response.text(); } catch { /* the status line is the message */ }
    try {
      const body = JSON.parse(raw) as { error?: unknown; message?: unknown; code?: unknown };
      const nested = body.error && typeof body.error === 'object' ? body.error as { message?: unknown; code?: unknown; type?: unknown } : undefined;
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
    // stop it retrying a 5xx (stepRecovery treats an unknown code as final).
    // The server's own code is still in the message.
    if (code && !message.includes(code)) message = `${message} (${code})`;
    const loopCode = isContextOverflow(status, code, message) ? 'CONTEXT_TOO_LARGE' : undefined;
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
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cached !== undefined) out.cached = cached;
  if (reasoning !== undefined) out.reasoning = reasoning;
  return out;
}
