/** ModelClient for the Gateway turn route:
 * `POST {baseUrl}/api/clikcode/v1/turn`, answered as Server-Sent Events. */
import type { HarnessErrorKind, ModelClient, ModelStepRequest, ModelStepResult, ModelToolCall, TokenUsage } from '../model-client.js';
import { turnCancelledError } from '../cancellation.js';

interface GatewayModelClientOptions {
  baseUrl: string;
  apiKey: string;
  version: string;
  fetchImpl?: typeof fetch;
  sessionId?: string;
  maxOutputTokens?: number;
  effort?: string;
  task?: string;
}

export class ModelClientError extends Error {
  readonly kind: HarnessErrorKind;
  readonly statusCode?: number;
  readonly code?: string;
  /** Seconds. */
  readonly retryAfter?: number;

  constructor(message: string, details: { kind: HarnessErrorKind; statusCode?: number; code?: string; retryAfter?: number }) {
    super(message);
    this.name = 'ModelClientError';
    this.kind = details.kind;
    if (details.statusCode !== undefined) this.statusCode = details.statusCode;
    if (details.code !== undefined) this.code = details.code;
    if (details.retryAfter !== undefined) this.retryAfter = details.retryAfter;
  }
}

function errorKindForStatus(status: number | undefined): HarnessErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'quota';
  return 'other';
}

const AUTH_CODES = new Set(['unauthorized', 'unauthenticated', 'forbidden', 'auth', 'invalid_api_key', 'auth_required']);
const QUOTA_CODES = new Set(['quota', 'quota_exceeded', 'quota_exhausted', 'rate_limited', 'rate_limit', 'insufficient_credits', 'payment_required']);

function errorKindForCode(code: unknown): HarnessErrorKind {
  if (typeof code === 'number') return errorKindForStatus(code);
  const text = String(code ?? '').toLowerCase();
  if (/^\d{3}$/.test(text)) return errorKindForStatus(Number(text));
  return AUTH_CODES.has(text) ? 'auth' : QUOTA_CODES.has(text) ? 'quota' : 'other';
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
function parseRetryAfter(value: unknown, now: number = Date.now()): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

interface SseEvent { event?: string; data: string }

/** Incremental SSE parser. Bytes go in at arbitrary boundaries (mid-line,
 * mid-UTF-8 sequence, between the CR and LF of a CRLF); complete events come
 * out. Follows the WHATWG event-stream rules for the fields used here. */
class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';
  private data: string[] = [];
  private event: string | undefined;
  private sawBom = false;

  push(chunk: Uint8Array | string): SseEvent[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (!this.sawBom) { this.sawBom = true; if (this.buffer.charCodeAt(0) === 0xfeff) this.buffer = this.buffer.slice(1); }
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (!match) break;
      // A lone CR at the very end may be the first half of a CRLF that the
      // next chunk completes; wait rather than emit a phantom blank line.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** End of stream: an unterminated final event is still delivered. */
  flush(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const events: SseEvent[] = [];
    if (this.buffer) { const event = this.line(this.buffer.replace(/\r$/, '')); if (event) events.push(event); this.buffer = ''; }
    const last = this.line('');
    if (last) events.push(last);
    return events;
  }

  private line(line: string): SseEvent | undefined {
    if (line === '') {
      if (!this.data.length) { this.event = undefined; return undefined; }
      const event: SseEvent = { data: this.data.join('\n'), ...(this.event ? { event: this.event } : {}) };
      this.data = [];
      this.event = undefined;
      return event;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    return undefined;
  }
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class GatewayModelClient implements ModelClient {
  constructor(private readonly options: GatewayModelClientOptions) {}

  async step(request: ModelStepRequest): Promise<ModelStepResult> {
    const { options } = this;
    const doFetch = options.fetchImpl ?? fetch;
    const url = `${options.baseUrl.replace(/\/+$/, '')}/api/clikcode/v1/turn`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, accept: 'text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          system: request.system,
          items: request.items,
          tools: request.tools,
          hints: { task: options.task ?? 'code', effort: options.effort ?? 'auto', ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) },
          client: { name: 'clikcode', version: options.version },
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (request.signal?.aborted) throw turnCancelledError();
      throw new ModelClientError(`Could not reach ClikDeploy Gateway: ${error instanceof Error ? error.message : String(error)}`, { kind: 'other' });
    }

    if (!response.ok) {
      let message = `ClikDeploy Gateway returned HTTP ${response.status}`;
      let code: string | undefined;
      let retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      try {
        const body = JSON.parse(await response.text()) as { error?: unknown; message?: unknown; code?: unknown; retryAfter?: unknown };
        const nested = body.error && typeof body.error === 'object' ? body.error as { message?: unknown; code?: unknown; retryAfter?: unknown } : undefined;
        const text = nested?.message ?? body.message ?? (typeof body.error === 'string' ? body.error : undefined);
        if (typeof text === 'string' && text) message = text;
        const rawCode = nested?.code ?? body.code;
        if (typeof rawCode === 'string') code = rawCode;
        retryAfter ??= parseRetryAfter(nested?.retryAfter ?? body.retryAfter);
      } catch { /* non-JSON error body: the status line is the message */ }
      throw new ModelClientError(message, { kind: errorKindForStatus(response.status), statusCode: response.status, ...(code ? { code } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}) });
    }
    if (!response.body) throw new ModelClientError('ClikDeploy Gateway returned an empty response', { kind: 'other', statusCode: response.status });

    const parser = new SseParser();
    let text = '';
    const toolCalls: ModelToolCall[] = [];
    let usage: TokenUsage = {};
    let stopReason: string | undefined;
    let servedModel: string | undefined;
    let contextWindow: number | undefined;

    const handle = (event: SseEvent): void => {
      if (!event.data || event.data === '[DONE]') return;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      switch (frame.type ?? event.event) {
        case 'route':
          if (typeof frame.model === 'string') servedModel = frame.model;
          contextWindow = numberField(frame, 'contextWindow') ?? contextWindow;
          break;
        case 'text-delta':
          if (typeof frame.text === 'string' && frame.text) { text += frame.text; request.onTextDelta(frame.text); }
          break;
        case 'reasoning-delta':
          if (typeof frame.text === 'string' && frame.text) request.onReasoningDelta?.(frame.text);
          break;
        case 'tool-call':
          if (typeof frame.name === 'string') {
            toolCalls.push({
              id: typeof frame.id === 'string' && frame.id ? frame.id : `call_${toolCalls.length + 1}_${Date.now().toString(36)}`,
              name: frame.name,
              args: frame.args && typeof frame.args === 'object' && !Array.isArray(frame.args) ? frame.args as Record<string, unknown> : {},
            });
          }
          break;
        case 'usage': {
          const next: TokenUsage = {};
          for (const key of ['input', 'output', 'cached', 'cacheWrite', 'reasoning', 'costMicroUsd'] as const) {
            const value = numberField(frame, key);
            if (value !== undefined) next[key] = value;
          }
          usage = { ...usage, ...next };
          break;
        }
        case 'finish':
          stopReason = typeof frame.stopReason === 'string' ? frame.stopReason : 'stop';
          break;
        case 'error': {
          const retryAfter = parseRetryAfter(frame.retryAfter);
          throw new ModelClientError(typeof frame.message === 'string' && frame.message ? frame.message : 'ClikDeploy Gateway reported an error', {
            kind: errorKindForCode(frame.code), ...(typeof frame.code === 'string' ? { code: frame.code } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}),
          });
        }
        default: break; // unknown frame types are forward-compatible no-ops
      }
    };

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) for (const event of parser.push(value)) handle(event);
      }
      for (const event of parser.flush()) handle(event);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (request.signal?.aborted) throw turnCancelledError();
      if (error instanceof ModelClientError) throw error;
      throw new ModelClientError(`ClikDeploy Gateway stream failed: ${error instanceof Error ? error.message : String(error)}`, { kind: 'other' });
    }
    // A stream that ends without `finish` was cut off; treating the partial
    // text as a complete answer would silently drop tool calls.
    if (stopReason === undefined) throw new ModelClientError('ClikDeploy Gateway stream ended before the turn finished', { kind: 'other', code: 'incomplete_stream' });
    return { text, toolCalls, stopReason, usage, ...(servedModel ? { servedModel } : {}), ...(contextWindow ? { contextWindow } : {}) };
  }
}
