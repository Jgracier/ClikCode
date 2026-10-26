import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { remotePalette, remoteResume, runRemoteChat } from './terminal-chat.js';
import { newMachineRecord, updateMachines } from './machines.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';
import { BOARD_LINE } from '../commands/ai/interactive/board.js';

const boardPicker = vi.hoisted(() => vi.fn());
vi.mock('../tui/pickers/session.js', () => ({ interactiveSessionPicker: boardPicker }));

describe('remote chat open request', () => {
  it('resumes by id and names no folder of this machine', () => {
    const request = remoteResume('chat-1');
    expect(request).toEqual({ type: 'open', mode: 'resume', sessionId: 'chat-1', features: ['session-delta'] });
    expect('workspace' in request).toBe(false);
    expect(JSON.stringify(request)).not.toContain(process.cwd());
  });
});

/** The other machine's `ide-bridge --stdio`, in memory: a chat's ready, an
 * open answered with the chat, a send answered as done -- and told to leave
 * for a newer build (host-retiring, then the close) or to drop. */
class FakeRemoteBridge extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<{ type: string; mode?: string; sessionId?: string; text?: string; query?: string }> = [];
  private chat = '';
  /** How a `send` is answered: done at once unless a test says otherwise. */
  onSend: (request: { id: string; text: string }) => void = (request) => this.say({ type: 'send-complete', id: request.id });
  constructor() {
    super();
    createInterface({ input: this.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.type === 'chat-attach') { this.chat = message.chat; this.say({ type: 'ready', version: 't', pid: 1 }); return; }
      const request = message.request;
      this.requests.push(request);
      if (request.type === 'open') {
        const sessionId = request.sessionId ?? 'new-1';
        this.say({ type: 'session', session: { id: sessionId, route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] } });
        this.say({ type: 'result', requestId: request.requestId, ok: true, data: { sessionId } });
      }
      if (request.type === 'send') this.onSend(request);
      if (request.type === 'query' && request.query === 'slash-commands') {
        this.say({ type: 'result', requestId: request.requestId, ok: true, data: [
          { command: '/model', description: 'choose the model', argHint: '[model]', group: 'Provider', argValues: [{ value: 'opus' }, { value: 'sonnet' }] },
          { command: '/resume', description: 'open another conversation', group: 'Conversation' },
          { command: '/update', description: 'update ClikCode', group: 'ClikCode' },
        ] });
      }
    });
    setImmediate(() => this.write({ type: 'host-ready', version: 't', protocol: 1, revision: 3, pid: 1 }));
  }
  private write(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  say(event: unknown): void { this.write({ type: 'chat', chat: this.chat, event }); }
  /** Leaves for a newer build, as bridge-mux.ts does. */
  retire(): void { this.write({ type: 'host-retiring', reason: 'newer-build' }); this.write({ type: 'chat-closed', chat: this.chat }); this.drop(); }
  drop(): void { this.stdout.end(); setTimeout(() => this.emit('close', 0, null), 20); }
  kill(): boolean { this.drop(); return true; }
}

/** A terminal whose prompt is answered by the test; everything else is noted. */
const fakeTerminal = () => {
  const said: string[] = [];
  /** Every other call, by name, with its arguments. */
  const calls: Array<[string, ...unknown[]]> = [];
  const prompts: Array<{ answer: (line: string) => void; items: Array<{ value: string; argValues?: () => unknown }>; options: Record<string, unknown> }> = [];
  const terminal = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => {
      if (key === 'question') {
        return (_prompt: string, items: Array<{ value: string }>, options: { signal?: AbortSignal }) => new Promise<string>((resolve, reject) => {
          const interrupted = () => reject(Object.assign(new Error('interrupted'), { code: 'ERR_PROMPT_INTERRUPTED' }));
          if (options.signal?.aborted) { interrupted(); return; }
          options.signal?.addEventListener('abort', interrupted, { once: true });
          prompts.push({ answer: resolve, items, options });
        });
      }
      if (key === 'activity') return (line: string) => said.push(line);
      if (key === 'then') return undefined;
      return (...args: unknown[]) => { calls.push([String(key), ...args]); };
    },
    set: () => true,
  }) as unknown as TerminalHarnessPrompter;
  return { terminal, said, prompts, calls };
};

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('a chat on another machine whose bridge leaves for a newer build', () => {
  it('connects again and resumes the same chat with nothing said; a real drop is still said', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const bridges: FakeRemoteBridge[] = [];
    const { terminal, said, prompts } = fakeTerminal();
    const running = runRemoteChat(terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, () => {
      const bridge = new FakeRemoteBridge();
      bridges.push(bridge);
      return bridge as unknown as ChildProcessWithoutNullStreams;
    }, [0]);
    const outcome = running.then(() => 'returned', (error: Error) => error.message);
    await until(() => prompts.length === 1);
    expect(bridges[0]!.requests[0]).toMatchObject({ type: 'open', mode: 'resume', sessionId: 'c1' });
    bridges[0]!.retire();
    await until(() => prompts.length === 2);
    expect(bridges).toHaveLength(2);
    expect(bridges[1]!.requests[0]).toMatchObject({ type: 'open', mode: 'resume', sessionId: 'c1' });
    expect(said).toEqual([]);
    // It keeps working on the new bridge.
    prompts[1]!.answer('hello again');
    await until(() => bridges[1]!.requests.some((request) => request.type === 'send'));
    expect(bridges[1]!.requests.find((request) => request.type === 'send')).toMatchObject({ text: 'hello again' });
    await until(() => prompts.length === 3);
    // A connection that is lost, not retired: said, then connected to again, the same chat resumed.
    bridges[1]!.drop();
    await until(() => bridges.length === 3 && prompts.length === 4);
    expect(said.join('\n')).toContain('Connection to devbox lost: Connection to devbox closed');
    expect(bridges[2]!.requests[0]).toMatchObject({ type: 'open', mode: 'resume', sessionId: 'c1' });
    prompts[3]!.answer('/exit');
    expect(await outcome).toBe('returned');
  }, 20_000);
});

describe('a chat on another machine\'s slash menu', () => {
  it('offers the full remote menu in history and applies setup commands to one new remote chat', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const { terminal, prompts } = fakeTerminal();
    const bridge = new FakeRemoteBridge();
    boardPicker.mockReset().mockResolvedValueOnce({ command: '/model sonnet' }).mockResolvedValueOnce({ command: '/model opus' });
    const running = runRemoteChat(terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, () => bridge as unknown as ChildProcessWithoutNullStreams, []);
    await until(() => prompts.length === 1);
    prompts[0]!.answer(BOARD_LINE);
    await until(() => prompts.length === 2);
    expect(boardPicker.mock.calls[0]![2].map((item: { value: string }) => item.value)).toEqual(prompts[0]!.items.map((item) => item.value));
    expect(bridge.requests.filter((request) => request.type === 'open')).toEqual([
      expect.objectContaining({ mode: 'resume', sessionId: 'c1' }), expect.objectContaining({ mode: 'new' }),
    ]);
    expect(bridge.requests.find((request) => request.type === 'send')).toMatchObject({ text: '/model sonnet' });
    prompts[1]!.answer(BOARD_LINE);
    await until(() => prompts.length === 3);
    expect(bridge.requests.filter((request) => request.type === 'open')).toHaveLength(2);
    prompts[2]!.answer('/exit');
    expect(await running).toEqual({ exit: true });
  });
  it('is that machine\'s commands, with /machine, and a command chosen runs there', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const bridges: FakeRemoteBridge[] = [];
    const { terminal, prompts } = fakeTerminal();
    const running = runRemoteChat(terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, () => {
      const bridge = new FakeRemoteBridge();
      bridges.push(bridge);
      return bridge as unknown as ChildProcessWithoutNullStreams;
    }, []);
    const outcome = running.then(() => 'returned', (error: Error) => error.message);
    await until(() => prompts.length === 1);
    // The menu is the machine's, read before the first prompt, opened by Right as a chat here does.
    expect(prompts[0]!.items.map((item) => item.value)).toEqual(['/model', '/update', '/machine', '/select', '/redraw', '/exit']);
    expect(prompts[0]!.options).toMatchObject({ rightArrowPalette: true });
    expect(prompts[0]!.items[0]!.argValues?.()).toEqual([{ value: 'opus' }, { value: 'sonnet' }]);
    // Chosen, it is sent to that machine; the menu is read again after it.
    const queries = (): number => bridges[0]!.requests.filter((request) => request.type === 'query').length;
    expect(queries()).toBe(1);
    prompts[0]!.answer('/model sonnet');
    await until(() => prompts.length === 2);
    expect(bridges[0]!.requests.find((request) => request.type === 'send')).toMatchObject({ text: '/model sonnet' });
    expect(queries()).toBe(2);
    bridges[0]!.drop();
    expect(await outcome).toBe('Connection to devbox closed');
  }, 20_000);

  it('/machine is offered even by a machine that does not list it; /resume is Left\'s', () => {
    expect(remotePalette([]).map((row) => row.value)).toEqual(['/machine', '/select', '/redraw', '/exit']);
    expect(remotePalette([{ command: '/machine', description: 'move' }, { command: '/resume', description: 'r' }]).map((row) => row.value)).toEqual(['/machine', '/select', '/redraw', '/exit']);
  });
});

describe('a message typed in a chat on another machine', () => {
  const start = async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const bridges: FakeRemoteBridge[] = [];
    const fake = fakeTerminal();
    const running = runRemoteChat(fake.terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, () => {
      const bridge = new FakeRemoteBridge();
      bridges.push(bridge);
      return bridge as unknown as ChildProcessWithoutNullStreams;
    }, []);
    const outcome = running.then(() => 'returned', (error: Error) => error.message);
    await until(() => fake.prompts.length === 1);
    return { ...fake, bridge: bridges[0]!, outcome };
  };
  const named = (calls: Array<[string, ...unknown[]]>, name: string) => calls.filter((call) => call[0] === name);

  it('is drawn on Enter with the turn\'s wait, before the machine answers; its turn-start carries it on', async () => {
    const { bridge, prompts, calls, outcome } = await start();
    let sent: { id: string; text: string } | undefined;
    bridge.onSend = (request) => { sent = request; };
    calls.length = 0;
    prompts[0]!.answer('hello there');
    await until(() => sent !== undefined);
    expect(calls.map((call) => call[0]).slice(0, 2)).toEqual(['submitted', 'turnStarting']);
    expect(calls[0]).toEqual(['submitted', 'hello there']);
    // The machine's turn-start: the same wait, now with its controls, and the message not drawn again.
    bridge.say({ type: 'turn-start', sessionId: 'c1', prompt: 'hello there' });
    await until(() => named(calls, 'startWaiting').length === 1);
    expect(named(calls, 'startWaiting')[0]![1]).toBe('thinking');
    expect(named(calls, 'turnStarting')).toHaveLength(1);
    expect(named(calls, 'submitted').map((call) => call[1])).toEqual(['hello there', 'hello there']);
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'waiting-stop' } });
    bridge.say({ type: 'send-complete', id: sent!.id });
    await until(() => prompts.length === 2);
    // It became a turn: nothing taken off the screen.
    expect(named(calls, 'submitted').map((call) => call[1])).not.toContain(undefined);
    bridge.drop();
    expect(await outcome).toBe('Connection to devbox closed');
  }, 20_000);

  it('stopped or refused before it ran: off the screen again, and back in the composer', async () => {
    const { bridge, prompts, calls, outcome } = await start();
    bridge.onSend = (request) => {
      bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'submit-rejected', message: 'Stopped' } });
      bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'restore-draft', text: request.text } });
      bridge.say({ type: 'send-complete', id: request.id });
    };
    calls.length = 0;
    prompts[0]!.answer('never ran');
    await until(() => prompts.length === 2);
    const order = calls.map((call) => `${call[0]}${call[1] === undefined ? '' : ` ${String(call[1])}`}`);
    expect(order).toEqual(expect.arrayContaining(['submitted never ran', 'turnStarting', 'restoreDraft never ran', 'submitted', 'stopWaiting']));
    expect(order.indexOf('submitted')).toBeGreaterThan(order.indexOf('restoreDraft never ran'));
    bridge.drop();
    expect(await outcome).toBe('Connection to devbox closed');
  }, 20_000);

  it('a command is not drawn early: it may never be a message', async () => {
    const { prompts, calls, bridge, outcome } = await start();
    calls.length = 0;
    prompts[0]!.answer('/model sonnet');
    await until(() => prompts.length === 2);
    expect(named(calls, 'turnStarting')).toEqual([]);
    bridge.drop();
    expect(await outcome).toBe('Connection to devbox closed');
  }, 20_000);

  it('joins a turn already running as "thinking", and the vendor\'s own background work as what it is', async () => {
    const base = { id: 'c1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] };
    const joined = async (live: Record<string, unknown>) => {
      const { bridge, calls, outcome } = await start();
      calls.length = 0;
      bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'snapshot', session: base, live: { text: '', ...live } } });
      await until(() => named(calls, 'startWaiting').length === 1);
      const label = named(calls, 'startWaiting')[0]![1];
      bridge.drop();
      expect(await outcome).toBe('Connection to devbox closed');
      return label;
    };
    // An ordinary live turn: the model is working.
    expect(await joined({ waitingLabel: 'reading files', prompt: 'go' })).toBe('thinking');
    // The vendor's own background work (a tool it never settled, a shell it runs) is not the model thinking:
    // it keeps the worker's wording, so the window is not drawn as a turn that "never finishes thinking".
    expect(await joined({ waitingLabel: 'background work', vendorWork: true })).toBe('background work');
  }, 30_000);

  it('shows the whole conversation from a bridge that sends only what changed', async () => {
    const { bridge, calls, outcome } = await start();
    const base = { id: 'c1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active' };
    bridge.say({ type: 'session', session: { ...base, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] } });
    bridge.say({ type: 'worker', sessionId: 'c1', messagesFrom: 2, event: { type: 'snapshot', session: { ...base, messages: [{ role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }] } } });
    bridge.say({ type: 'session', messagesFrom: 4, session: { ...base, name: 'Renamed', messages: [] } });
    await until(() => named(calls, 'render').length >= 3);
    const renders = named(calls, 'render').map((call) => call[1] as { name: string; messages: Array<{ content: string }> });
    expect(renders.at(-2)!.messages.map((message) => message.content)).toEqual(['a', 'b', 'c', 'd']);
    expect(renders.at(-1)!.messages.map((message) => message.content)).toEqual(['a', 'b', 'c', 'd']);
    expect(renders.at(-1)!.name).toBe('Renamed');
    bridge.drop();
    expect(await outcome).toBe('Connection to devbox closed');
  }, 20_000);
});

describe('a connection that drops without a retire', () => {
  const open = async (pauses: readonly number[]) => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const bridges: FakeRemoteBridge[] = [];
    const fake = fakeTerminal();
    const running = runRemoteChat(fake.terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, () => {
      const bridge = new FakeRemoteBridge();
      bridges.push(bridge);
      return bridge as unknown as ChildProcessWithoutNullStreams;
    }, pauses);
    const outcome = running.then(() => 'returned', (error: Error) => error.message);
    await until(() => fake.prompts.length === 1);
    return { ...fake, bridges, outcome };
  };

  it('is joined again, and the line that was in flight comes back as a draft', async () => {
    const { bridges, prompts, calls, said, outcome } = await open([0]);
    bridges[0]!.onSend = () => undefined;
    prompts[0]!.answer('please keep this');
    await until(() => bridges[0]!.requests.some((request) => request.type === 'send'));
    bridges[0]!.stderr.write('ssh: connect to host devbox port 22: Connection reset\nkex_exchange_identification: read: Connection reset by peer\n');
    bridges[0]!.drop();
    await until(() => bridges.length === 2 && prompts.length === 2);
    expect(calls.filter((call) => call[0] === 'restoreDraft').map((call) => call[1])).toEqual(['please keep this']);
    // The whole cause, not its last line.
    expect(said.join('\n')).toContain('Connection reset\nkex_exchange_identification');
    prompts[1]!.answer('/exit');
    expect(await outcome).toBe('returned');
  }, 20_000);

  it('ends the chat with the cause once every pause has been spent', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const bridges: FakeRemoteBridge[] = [];
    let refused = 0;
    const fake = fakeTerminal();
    const running = runRemoteChat(fake.terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, () => {
      if (bridges.length) {
        // Every later connection is refused before it is ready.
        refused += 1;
        const gone = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
        setTimeout(() => { gone.stderr.write('Host key verification failed.\n'); gone.emit('close', 255, null); }, 5);
        return gone as unknown as ChildProcessWithoutNullStreams;
      }
      const bridge = new FakeRemoteBridge();
      bridges.push(bridge);
      return bridge as unknown as ChildProcessWithoutNullStreams;
    }, [0, 0]);
    const outcome = running.then(() => 'returned', (error: Error) => error.message);
    await until(() => fake.prompts.length === 1);
    bridges[0]!.drop();
    expect(await outcome).toContain('Host key verification failed.');
    expect(refused).toBe(2);
  }, 20_000);

  it('answers a request that never gets an answer with the machine and the request named', async () => {
    const { TerminalBridge } = await import('./terminal-chat.js');
    const bridge = new TerminalBridge('devbox', () => new FakeRemoteBridge() as unknown as ChildProcessWithoutNullStreams, 50);
    await bridge.connected();
    await expect(bridge.request({ type: 'query', query: 'never-answered' } as never)).rejects.toThrow('devbox did not answer "query" within 0.05s');
  });
});

describe('the terminal\'s own commands in a chat on another machine', () => {
  it('/exit closes this window instead of being sent there; /redraw draws the chat again here', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const bridges: FakeRemoteBridge[] = [];
    const { terminal, prompts, calls } = fakeTerminal();
    const ended = runRemoteChat(terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, () => {
      const bridge = new FakeRemoteBridge();
      bridges.push(bridge);
      return bridge as unknown as ChildProcessWithoutNullStreams;
    }, []);
    await until(() => prompts.length === 1);
    const renders = (): number => calls.filter((call) => call[0] === 'render').length;
    const before = renders();
    prompts[0]!.answer('/redraw');
    await until(() => prompts.length === 2);
    expect(renders()).toBe(before + 1);
    prompts[1]!.answer('/exit');
    expect(await ended).toEqual({ exit: true });
    // Neither went to the other machine.
    expect(bridges[0]!.requests.filter((request) => request.type === 'send')).toEqual([]);
  }, 20_000);
});
