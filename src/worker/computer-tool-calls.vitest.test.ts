import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ToolCalls, type ToolCallResult } from './computer-tool-calls.js';

const socket = (): Socket => Object.assign(new EventEmitter(), { destroyed: false }) as unknown as Socket;

describe('a computer tool call asked for twice', () => {
  it('runs once; the repeat hears the same result, during the run or after it', async () => {
    const heard: Array<[Socket, string, string?]> = [];
    const calls = new ToolCalls((to, event) => heard.push([to, event.type, 'output' in event ? event.output : undefined]));
    let runs = 0;
    let finish!: (result: ToolCallResult) => void;
    const run = (): Promise<ToolCallResult> => { runs++; return new Promise(resolve => { finish = resolve; }); };
    const first = socket(), second = socket(), late = socket();
    calls.take(first, 'call-1', run);
    calls.take(second, 'call-1', run);
    expect(runs).toBe(1);
    finish({ ok: true, output: 'created one key' });
    await new Promise(resolve => setTimeout(resolve, 0));
    calls.take(late, 'call-1', run);
    expect(runs).toBe(1);
    expect(heard.filter(([, type]) => type === 'computer-tool-result').map(([to, , output]) => [to, output])).toEqual([[first, 'created one key'], [second, 'created one key'], [late, 'created one key']]);
  });

  it('is stopped only when every caller waiting on it has gone', async () => {
    const calls = new ToolCalls(() => undefined);
    let signal!: AbortSignal;
    const a = socket(), b = socket();
    calls.take(a, 'call-2', s => { signal = s; return new Promise(() => undefined); });
    calls.take(b, 'call-2', () => { throw new Error('ran twice'); });
    a.emit('close');
    expect(signal.aborted).toBe(false);
    b.emit('close');
    expect(signal.aborted).toBe(true);
  });
});
