/** What every streamed model client shares: its error type, the SSE parser,
 * and the idle limit on a stream. (The Gateway itself is an OpenAI-compatible
 * API, served by openai-client.ts; see for-session.ts gatewayModelClient.) */
import type { HarnessErrorKind } from '../model-client.js';

/** A model stream that has said nothing for this long is treated as cut off:
 * the connection is dropped and the step fails as `incomplete_stream`, which
 * the loop resends when nothing had streamed yet. Without it a stalled
 * connection -- a proxy that stopped forwarding, a server that wedged
 * mid-answer -- held the turn open forever with no error to show. Reset by
 * every chunk, so a slow but live answer is never cut. */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** One read of a model stream, failing as `incomplete_stream` if nothing
 * arrives within `ms`. Zero or undefined waits as long as it takes. */
export async function readWithin<T>(reader: ReadableStreamDefaultReader<T>, ms: number | undefined, label: string): Promise<{ done: boolean; value?: T }> {
  if (!ms || ms <= 0) return reader.read();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ModelClientError(`${label} sent nothing for ${Math.round(ms / 1000)}s; the connection was dropped`, { kind: 'other', code: 'incomplete_stream' })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: unknown, now: number = Date.now()): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

export interface SseEvent { event?: string; data: string }

/** Incremental SSE parser. Bytes go in at arbitrary boundaries (mid-line,
 * mid-UTF-8 sequence, between the CR and LF of a CRLF); complete events come
 * out. Follows the WHATWG event-stream rules for the fields used here. */
export class SseParser {
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
