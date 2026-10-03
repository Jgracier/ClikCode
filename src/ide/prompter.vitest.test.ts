import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { IdePrompter, pickItems } from './prompter.js';
import { captureStdout } from './bridge.js';
import { decodeTerminalSpec, encodeTerminalSpec, type IdeEvent } from './protocol.js';

function harness(): { prompter: IdePrompter; events: IdeEvent[]; nextRequest: () => Promise<Extract<IdeEvent, { type: 'ui-request' }>> } {
  const events: IdeEvent[] = [];
  let waiters: Array<(event: Extract<IdeEvent, { type: 'ui-request' }>) => void> = [];
  const prompter = new IdePrompter({
    send: (event) => {
      events.push(event);
      if (event.type === 'ui-request') { const waiter = waiters.shift(); waiter?.(event); }
    },
  });
  return {
    prompter, events,
    nextRequest: () => new Promise((resolve) => {
      const pending = events.filter((event): event is Extract<IdeEvent, { type: 'ui-request' }> => event.type === 'ui-request');
      waiters.push(resolve);
      void pending;
    }),
  };
}

describe('IdePrompter', () => {
  it('answers a picker with the chosen row value', async () => {
    const { prompter, nextRequest } = harness();
    const request = nextRequest();
    const chosen = prompter.select('Choose', [{ label: 'a', value: 1 }, { label: 'b', value: 2, detail: 'second' }]);
    const asked = await request;
    expect(asked.request).toEqual({ kind: 'pick', title: 'Choose', canGoBack: false, items: [{ label: 'a' }, { label: 'b', detail: 'second' }] });
    prompter.answer(asked.id, { index: 1 });
    expect(await chosen).toBe(2);
  });

  it('runs a row action and asks again with the refreshed rows', async () => {
    const { prompter, nextRequest } = harness();
    const actions: string[] = [];
    let rows = [{ label: 'x', value: 'x', actions: [{ label: 'Sign in again', value: 'reauth' }] }];
    const first = nextRequest();
    const chosen = prompter.select('Accounts', rows, async (value, action) => { actions.push(`${value}:${action}`); rows = [{ ...rows[0]!, label: 'x (done)' }]; }, { refreshedOptions: () => rows });
    prompter.answer((await first).id, { index: 0, action: 'reauth' });
    const second = await nextRequest();
    expect(second.request.kind === 'pick' && second.request.items[0]?.label).toBe('x (done)');
    prompter.answer(second.id, { cancelled: true });
    expect(await chosen).toBeUndefined();
    expect(actions).toEqual(['x:reauth']);
  });

  it('cycles an inline setting in place', async () => {
    const { prompter, nextRequest } = harness();
    const applied: string[] = [];
    const first = nextRequest();
    const chosen = prompter.select('Settings', [{ label: 'mode', value: 'mode', inline: { choices: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], current: 'a', apply: async (value: string) => { applied.push(value); } } }]);
    prompter.answer((await first).id, { index: 0 });
    const second = await nextRequest();
    expect(second.request.kind === 'pick' && second.request.items[0]?.inline?.current).toBe('b');
    prompter.answer(second.id, { cancelled: true, back: true });
    expect(await chosen).toBeUndefined();
    expect(applied).toEqual(['b']);
  });

  it('sets the inline value the editor clicked, however far along', async () => {
    const { prompter, nextRequest } = harness();
    const applied: string[] = [];
    const first = nextRequest();
    const choices = ['default', 'low', 'high'].map((value) => ({ label: value, value }));
    const chosen = prompter.select('Settings', [{ label: 'Effort', value: 'effort', inline: { choices, current: 'default', apply: async (value: string) => { applied.push(value); } } }]);
    prompter.answer((await first).id, { index: 0, value: 'high' });
    const second = await nextRequest();
    expect(second.request.kind === 'pick' && second.request.items[0]?.inline?.current).toBe('high');
    prompter.answer(second.id, { cancelled: true });
    expect(await chosen).toBeUndefined();
    expect(applied).toEqual(['high']);
  });

  it('turns a cancelled question into an empty answer, and cancels everything on close', async () => {
    const { prompter, nextRequest } = harness();
    const request = nextRequest();
    const answer = prompter.question('Conversation name › ');
    const asked = await request;
    expect(asked.request).toEqual({ kind: 'input', prompt: 'Conversation name' });
    prompter.close();
    expect(await answer).toBe('');
  });

  it('carries row actions and delete actions to the editor', () => {
    expect(pickItems([{ label: 'r', value: 1, group: 'G', argHint: '<x>', deleteAction: { label: 'Remove', value: 'remove' } }]))
      .toEqual([{ label: 'r', group: 'G', argHint: '<x>', deleteAction: { label: 'Remove', value: 'remove' } }]);
  });
});

describe('captureStdout', () => {
  it('sends JSON records as output and logs everything else', () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    const events: IdeEvent[] = [];
    const logged: string[] = [];
    captureStdout({ send: (event) => events.push(event) }, stream, (line) => logged.push(line));
    stream.write('{"panel":"settings","ok":true}\nnot json\n{"pa');
    stream.write('nel":"help"}\n');
    expect(events).toEqual([{ type: 'output', payload: { panel: 'settings', ok: true } }, { type: 'output', payload: { panel: 'help' } }]);
    expect(logged).toEqual(['not json']);
  });
});

describe('terminal spec', () => {
  it('round-trips and rejects anything else', () => {
    const spec = { command: 'hermes', mode: 'run' as const, argv: ['model', '--x=a b'] };
    expect(decodeTerminalSpec(encodeTerminalSpec(spec))).toEqual(spec);
    expect(() => decodeTerminalSpec(Buffer.from('{"command":1}').toString('base64url'))).toThrow();
    // Sign-ins never run in an editor terminal any more.
    expect(() => decodeTerminalSpec(Buffer.from('{"command":"claude","mode":"login","argv":[]}').toString('base64url'))).toThrow();
  });
});
