/** `clikcode computer tab-stream <tab id>`: one agent tab's live view over a pipe, for a program on this computer that shows it
 * somewhere else (the ClikDeploy agent puts each agent tab on its remote desktop as a display of its own). It is the desk's live view
 * (handoff-live.ts, watching: the tab keeps the size the agent works in) with stdin and stdout in place of the WebSocket.
 *
 * Out (stdout), one record after another: [u32 big-endian length of what follows][u8 type][payload].
 *   type 1: a JPEG frame of the tab. type 2: a JSON message ({t:'size',w,h} the tab's size in page pixels, {t:'page',host}).
 * In (stdin), one JSON message per line, the live view's own: {t:'hello',w,h,dpr,m:'mouse'} first (the largest frame wanted),
 *   {t:'mouse',k:'m'|'d'|'u'|'w',x,y,b,down,dx,dy} in page pixels, {t:'key',key:'Enter'|'Tab'|…}, {t:'text',s:'a'},
 *   {t:'fill',…}, and {t:'ack'} once a frame has been used (the next frame waits for it).
 * The stream ends when stdin closes or the tab does. */
import type { Readable, Writable } from 'node:stream';
import type { LiteSocket } from './ws-lite.js';

export const TAB_FRAME_JPEG = 1;
export const TAB_FRAME_JSON = 2;
/** A line longer than this is not one of the live view's messages. */
const MAX_LINE = 256 * 1024;

export function tabRecord(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, payload]);
}

/** Reads the records tabRecord writes, from chunks cut anywhere. */
export class TabRecordReader {
  private pending: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Array<{ type: number; payload: Buffer }> {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: Array<{ type: number; payload: Buffer }> = [];
    while (this.pending.length >= 5) {
      const length = this.pending.readUInt32BE(0);
      if (length < 1 || length > 64 * 1024 * 1024) throw new Error(`tab-stream: a record of ${length} bytes is not one`);
      if (this.pending.length < 4 + length) break;
      out.push({ type: this.pending.readUInt8(4), payload: this.pending.subarray(5, 4 + length) });
      this.pending = this.pending.subarray(4 + length);
    }
    return out;
  }
}

/** The live view's socket over a pair of pipes: a binary message (a frame, sent as [1][jpeg]) goes out as a JPEG record, a text one as JSON. */
export function stdioSocket(input: Readable, output: Writable): LiteSocket {
  let closed = false;
  const messages: Array<(data: string | Buffer, binary: boolean) => void> = [];
  const closes: Array<() => void> = [];
  const end = (): void => {
    if (closed) return;
    closed = true;
    for (const handler of closes) handler();
  };
  let line = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    line += chunk;
    if (line.length > MAX_LINE && !line.includes('\n')) { line = ''; return; }
    for (let at = line.indexOf('\n'); at >= 0; at = line.indexOf('\n')) {
      const text = line.slice(0, at).trim();
      line = line.slice(at + 1);
      if (text) for (const handler of messages) handler(text, false);
    }
  });
  input.once('end', end);
  input.once('close', end);
  output.once('error', end);
  output.once('close', end);
  return {
    send(data) {
      if (closed) return;
      if (typeof data === 'string') output.write(tabRecord(TAB_FRAME_JSON, Buffer.from(data)));
      else if (data[0] === 1) output.write(tabRecord(TAB_FRAME_JPEG, data.subarray(1)));
    },
    close() { end(); },
    get buffered() { return output.writableLength; },
    get closed() { return closed; },
    onMessage(handler) { messages.push(handler); },
    onClose(handler) { closes.push(handler); },
  };
}
