/** A WebSocket server for one small job: the phone handoff's live view. RFC 6455, server side only: the opening handshake,
 * text and binary messages (fragmented or not), ping/pong and close. Nothing else (no extensions, no compression, no
 * subprotocols), so there is nothing to negotiate and nothing to attack beyond the frame parser below, which refuses
 * oversized messages, unmasked client frames and reserved bits. Used instead of a dependency: the dependency list of the
 * published package is part of what the build asserts. */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024;

export interface LiteSocket {
  /** A string goes as a text message, a Buffer as a binary one. */
  send(data: string | Buffer): void;
  close(code?: number): void;
  /** Bytes accepted by send() that the network has not taken yet: a sender that streams frames skips one while this is large. */
  readonly buffered: number;
  readonly closed: boolean;
  onMessage(handler: (data: string | Buffer, binary: boolean) => void): void;
  onClose(handler: () => void): void;
}

/** The server's answer key for a client's Sec-WebSocket-Key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** One server-to-client frame (never masked). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const head = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (length < 126) head[1] = length;
  else if (length < 65536) { head[1] = 126; head.writeUInt16BE(length, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(length), 2); }
  return Buffer.concat([head, payload]);
}

type Frame = { fin: boolean; opcode: number; payload: Buffer };

/** Reads client frames out of whatever bytes have arrived; keeps the rest for the next chunk. Throws on a protocol violation. */
export class FrameParser {
  private pending: Buffer = Buffer.alloc(0);
  constructor(private readonly maxPayload = MAX_MESSAGE) {}

  push(chunk: Buffer): Frame[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const frames: Frame[] = [];
    for (;;) {
      const buffer = this.pending;
      if (buffer.length < 2) break;
      const first = buffer[0]!, second = buffer[1]!;
      if (first & 0x70) throw new Error('reserved bits set');
      if (!(second & 0x80)) throw new Error('client frame not masked');
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (buffer.length < 10) break;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new Error('message too large');
        length = Number(big); offset = 10;
      }
      if (length > this.maxPayload) throw new Error('message too large');
      if (buffer.length < offset + 4 + length) break;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
      frames.push({ fin: Boolean(first & 0x80), opcode: first & 0x0f, payload });
      this.pending = buffer.subarray(offset + 4 + length);
    }
    return frames;
  }
}

/** Completes the handshake for an `upgrade` request and returns the socket, or answers 400 and returns undefined. */
export function acceptWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer, options: { maxPayload?: number; allowOrigin?: (origin: string | undefined) => boolean } = {}): LiteSocket | undefined {
  const key = request.headers['sec-websocket-key'];
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
  const version = request.headers['sec-websocket-version'];
  const refuse = (): undefined => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return undefined; };
  if (upgrade !== 'websocket' || typeof key !== 'string' || version !== '13') return refuse();
  // A page on another site must not be able to open this socket from the user's browser: the Origin, when sent, has to be this server.
  if (options.allowOrigin && !options.allowOrigin(request.headers.origin)) return refuse();
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);

  const parser = new FrameParser(options.maxPayload);
  const messageHandlers: Array<(data: string | Buffer, binary: boolean) => void> = [];
  const closeHandlers: Array<() => void> = [];
  let closed = false;
  const backlog: Array<[string | Buffer, boolean]> = [];
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  let fragmentBytes = 0;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler();
    socket.destroy();
  };
  const write = (opcode: number, payload: Buffer): void => { if (!closed && socket.writable) socket.write(encodeFrame(opcode, payload)); };
  const close = (code = 1000): void => {
    if (closed) return;
    const reason = Buffer.alloc(2); reason.writeUInt16BE(code);
    write(0x8, reason);
    finish();
  };
  const handle = (frame: Frame): void => {
    switch (frame.opcode) {
      case 0x8: close(); return;
      case 0x9: write(0xA, frame.payload); return;
      case 0xA: return;
      case 0x0: case 0x1: case 0x2: {
        if (frame.opcode !== 0x0) { fragments = []; fragmentBytes = 0; fragmentOpcode = frame.opcode; }
        else if (!fragmentOpcode) throw new Error('unexpected continuation');
        fragments.push(frame.payload);
        fragmentBytes += frame.payload.length;
        if (fragmentBytes > (options.maxPayload ?? MAX_MESSAGE)) throw new Error('message too large');
        if (!frame.fin) return;
        const data = Buffer.concat(fragments);
        const binary = fragmentOpcode === 0x2;
        fragments = []; fragmentBytes = 0; fragmentOpcode = 0;
        const value = binary ? data : data.toString('utf8');
        // Nobody listening yet (the owner is still setting up): keep it for the first listener rather than lose what a client sends at once.
        if (!messageHandlers.length) { if (backlog.length < 100) backlog.push([value, binary]); return; }
        for (const handler of messageHandlers) handler(value, binary);
        return;
      }
      default: throw new Error('unknown opcode');
    }
  };
  const onData = (chunk: Buffer): void => {
    try { for (const frame of parser.push(chunk)) handle(frame); }
    catch { close(1002); }
  };
  socket.on('data', onData);
  socket.on('close', finish);
  socket.on('error', finish);
  (socket as unknown as { setNoDelay?(on: boolean): void }).setNoDelay?.(true);
  if (head.length) onData(head);

  return {
    send: (data) => write(typeof data === 'string' ? 0x1 : 0x2, typeof data === 'string' ? Buffer.from(data, 'utf8') : data),
    close,
    get buffered() { return socket.writableLength; },
    get closed() { return closed; },
    onMessage: (handler) => { messageHandlers.push(handler); for (const [value, binary] of backlog.splice(0)) handler(value, binary); },
    onClose: (handler) => { closeHandlers.push(handler); },
  };
}
