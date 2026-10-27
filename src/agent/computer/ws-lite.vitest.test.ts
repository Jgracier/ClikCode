import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptKey, acceptWebSocket, encodeFrame, FrameParser, type LiteSocket } from './ws-lite.js';

const mask = (opcode: number, payload: Buffer, fin = true): Buffer => {
  const key = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(payload.map((byte, i) => byte ^ key[i % 4]!));
  const head = payload.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, key, body]);
};

describe('frames', () => {
  it('answers the key the way RFC 6455 does', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('encodes short, medium and long server frames', () => {
    expect([...encodeFrame(1, Buffer.from('hi'))]).toEqual([0x81, 2, 104, 105]);
    const medium = encodeFrame(2, Buffer.alloc(300));
    expect([medium[0], medium[1], medium.readUInt16BE(2), medium.length]).toEqual([0x82, 126, 300, 304]);
    const long = encodeFrame(2, Buffer.alloc(70_000));
    expect([long[1], Number(long.readBigUInt64BE(2)), long.length]).toEqual([127, 70_000, 70_010]);
  });

  it('reads masked frames split across chunks, and several in one chunk', () => {
    const parser = new FrameParser();
    const one = mask(1, Buffer.from('hello'));
    expect(parser.push(one.subarray(0, 3))).toEqual([]);
    expect(parser.push(one.subarray(3)).map(frame => frame.payload.toString())).toEqual(['hello']);
    const both = Buffer.concat([mask(1, Buffer.from('a')), mask(2, Buffer.from([1, 2, 3]))]);
    expect(parser.push(both).map(frame => frame.opcode)).toEqual([1, 2]);
  });

  it('refuses what a server must not accept', () => {
    expect(() => new FrameParser().push(Buffer.from([0x81, 0x01, 0x41]))).toThrow('not masked');
    expect(() => new FrameParser().push(Buffer.from([0xC1, 0x80, 0, 0, 0, 0]))).toThrow('reserved');
    expect(() => new FrameParser(10).push(mask(1, Buffer.alloc(11)))).toThrow('too large');
  });
});

describe('a live socket', () => {
  let server: Server | undefined;
  afterEach(() => { server?.closeAllConnections(); server?.close(); server = undefined; });

  const serve = async (onSocket: (socket: LiteSocket) => void, allowOrigin?: (origin: string | undefined) => boolean): Promise<string> => {
    server = createServer((_request, response) => { response.writeHead(404).end(); });
    server.on('upgrade', (request, socket, head) => { const accepted = acceptWebSocket(request, socket, head, allowOrigin ? { allowOrigin } : {}); if (accepted) onSocket(accepted); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  };
  const opened = (url: string): Promise<WebSocket> => new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; ws.onopen = () => resolve(ws); ws.onerror = () => reject(new Error('refused')); });

  it('echoes text and binary both ways, a long message, and answers a ping through the client library', async () => {
    const url = await serve(socket => socket.onMessage((data, binary) => socket.send(binary ? Buffer.from(data as Buffer) : `echo:${String(data)}`)));
    const ws = await opened(url);
    const next = (): Promise<unknown> => new Promise(resolve => { ws.onmessage = event => resolve(event.data); });
    ws.send('hi'); expect(await next()).toBe('echo:hi');
    ws.send(new Uint8Array([9, 8, 7])); expect([...new Uint8Array(await next() as ArrayBuffer)]).toEqual([9, 8, 7]);
    const big = 'x'.repeat(40_000); ws.send(big); expect(await next()).toBe(`echo:${big}`);
    ws.close();
  });

  it('keeps what a client sends at once for the first listener', async () => {
    let attach!: () => void;
    const attached = new Promise<void>(resolve => { attach = resolve; });
    const heard: string[] = [];
    const url = await serve(socket => { void attached.then(() => socket.onMessage(data => { heard.push(String(data)); })); });
    const ws = await opened(url);
    ws.send('first'); ws.send('second');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(heard).toEqual([]);
    attach();
    for (let i = 0; i < 50 && heard.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(heard).toEqual(['first', 'second']);
    ws.close();
  });

  it('reports a close from either side, and a message that is too large closes it', async () => {
    let closed = 0;
    const url = await serve(socket => { socket.onClose(() => { closed++; }); });
    const ws = await opened(url);
    ws.close();
    for (let i = 0; i < 50 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(1);
    const second = await opened(url);
    const gone = new Promise<number>(resolve => { second.onclose = event => resolve(event.code); });
    second.send('y'.repeat(70_000));
    expect(await gone).toBe(1002);
  });

  it('refuses a request that is not a WebSocket one, and a foreign Origin', async () => {
    const url = await serve(() => undefined, origin => origin === undefined || origin === 'http://good');
    const http = url.replace('ws://', 'http://');
    expect((await fetch(http, { headers: { connection: 'Upgrade', upgrade: 'websocket' } }).catch(() => ({ status: 400 }))).status).toBeGreaterThanOrEqual(400);
    const foreign = await new Promise<boolean>(resolve => {
      const request = httpRequest(http, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'http://evil' } });
      request.on('upgrade', () => resolve(true)); request.on('response', () => resolve(false)); request.on('error', () => resolve(false)); request.end();
    });
    expect(foreign).toBe(false);
  });
});
