import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { remotePalette, remoteResume, runRemoteChat } from './terminal-chat.js';
import { newMachineRecord, updateMachines } from './machines.js';
import { remoteRowValue } from './board-rows.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';
import { BOARD_LINE } from '../commands/ai/interactive/board.js';

const boardPicker = vi.hoisted(() => vi.fn());
vi.mock('../tui/pickers/session.js', () => ({ interactiveSessionPicker: boardPicker }));
// The clipboard of this computer: a spy, so /copy on another machine can be seen to land here.
const clipboard = vi.hoisted(() => ({ copied: [] as string[] }));
vi.mock('../session/attachments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session/attachments.js')>()),
  copyToClipboard: async (text: string) => { clipboard.copied.push(text); return 'binary' as const; },
}));
// The copy of an image to the machine: ssh in life, a fixed place there here (or a refusal, when a test says so).
const copying = vi.hoisted(() => ({ fail: undefined as string | undefined, uploads: [] as string[] }));
vi.mock('./image.js', () => ({
  uploadRemoteImage: async (_target: string, name: string) => {
    if (copying.fail) throw new Error(copying.fail);
    copying.uploads.push(name);
    return '/tmp/clikcode-image.TEST0001/image.png';
  },
  removeRemoteImage: async () => undefined,
}));

describe('remote chat open request', () => {
  it('resumes by id and names no folder of this machine', () => {
    const request = remoteResume('chat-1');
    expect(request).toEqual({ type: 'open', mode: 'resume', sessionId: 'chat-1', features: ['session-delta', 'copy'] });
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
  readonly requests: Array<{ type: string; mode?: string; sessionId?: string; text?: string; query?: string; action?: string; parentId?: string; requestId?: string }> = [];
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
      if (request.type === 'subagent') {
        const answered = request.action === 'read' ? { rows: [{ kind: 'prompt', text: 'Find why the deploy stalls' }, { kind: 'text', text: `read ${request.parentId}` }], steer: 'relay' } : undefined;
        if (request.parentId === 'refused') this.say({ type: 'result', requestId: request.requestId, ok: false, error: 'Not sent: the sub-agent has finished.' });
        else this.say({ type: 'result', requestId: request.requestId, ok: true, ...(answered ? { data: answered } : {}) });
      }
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
  /** What the chat set on the terminal (its sub-agent reader and sender), by name. */
  const assigned: Record<string, unknown> = {};
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
      if (String(key) in assigned && assigned[String(key)] !== undefined) return assigned[String(key)];
      if (key === 'activity') return (line: string) => said.push(line);
      // An approval stays open until its signal aborts (answered in another window), then ends undecided.
      if (key === 'approval') {
        return (...args: unknown[]) => {
          const signal = args[4] as AbortSignal | undefined;
          calls.push(['approval', ...args]);
          return new Promise<boolean>((resolve) => signal?.addEventListener('abort', () => resolve(false), { once: true }));
        };
      }
      if (key === 'then') return undefined;
      return (...args: unknown[]) => { calls.push([String(key), ...args]); };
    },
    set: (_target, key, value) => { assigned[String(key)] = value; return true; },
  }) as unknown as TerminalHarnessPrompter;
  return { terminal, said, prompts, calls, assigned };
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
    // Left on a chat of another machine opens the list on that chat's row, not on the chat this window was started from.
    expect(boardPicker.mock.calls[0]![3]).toEqual({ initial: remoteRowValue(machine.id, 'c1') });
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
    // (turnStarting is given the way to step away from the turn; only that it was drawn matters here.)
    const order = calls.map((call) => (call[0] === 'turnStarting' ? 'turnStarting' : `${call[0]}${call[1] === undefined ? '' : ` ${String(call[1])}`}`));
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

  it('coming back to a running turn draws what it has done so far -- its calls, sub-agents, text and real start -- and a call after is not drawn twice', async () => {
    const started = '2026-11-01T01:30:00.000Z';
    const base = { id: 'c1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [], pendingTurn: { prompt: 'go', startedAt: started, updatedAt: started, outputStarted: true, response: 'so far' } };
    const call = (id: string, parentId?: string) => ({ responseOffset: 3, event: { kind: 'tool-done', label: `Task ${id}`, id, ...(parentId ? { parentId } : {}) } });
    const { bridge, calls, outcome } = await start();
    calls.length = 0;
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'snapshot', session: base, live: { text: 'so far, and more', waitingLabel: 'x', prompt: 'go', activities: [call('a'), call('b'), call('b1', 'b')], pendingBackground: 2 } } });
    await until(() => named(calls, 'activityEvent').length >= 3);
    expect(named(calls, 'response').map((call) => call[1])).toContain('so far, and more');
    expect(named(calls, 'activityEvent').map((call) => (call[1] as { id: string }).id)).toEqual(['a', 'b', 'b1']);
    expect(named(calls, 'joinedWaiting')[0]![1]).toBe(Date.parse(started));
    expect(named(calls, 'setBackgroundWork').length).toBeGreaterThan(0);
    // The next call is numbered after those, and a repeated snapshot draws the same rows again by index, not new ones.
    calls.length = 0;
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'activity', event: { kind: 'tool-start', label: 'Task c', id: 'c' } } });
    await until(() => named(calls, 'activityEvent').length === 1);
    expect(named(calls, 'activityEvent')[0]![2]).toMatchObject({ index: 3 });
    bridge.drop();
    expect(await outcome).toBe('Connection to devbox closed');
  }, 20_000);

  it('an approval answered in another window closes here, drawn as that window\'s decision, and nothing is sent back', async () => {
    const { bridge, calls, outcome } = await start();
    calls.length = 0;
    const base = { id: 'c1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] };
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'snapshot', session: base, live: { text: '', waitingLabel: 'x', prompt: 'go' } } });
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'approval-request', id: 'ask-1', title: 'Run it?', detail: 'rm', preview: [], rule: 'r' } });
    await until(() => named(calls, 'approval').length === 1);
    const signal = named(calls, 'approval')[0]![5] as AbortSignal;
    expect(signal.aborted).toBe(false);
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'request-closed', id: 'ask-1', outcome: 'approved', label: 'Ran rm' } });
    await until(() => signal.aborted);
    await until(() => named(calls, 'joinMark').length === 1);
    expect((named(calls, 'joinMark')[0]![1] as { id: string }).id).toBe('outcome:ask-1');
    expect(bridge.requests.some((request) => (request as { type: string }).type === 'approval-response')).toBe(false);
    bridge.drop();
    expect(await outcome).toBe('Connection to devbox closed');
  }, 20_000);

  it('draws a stop as the local window does: stopping, settled, and a turn another window stopped ends as stopped', async () => {
    const { bridge, calls, outcome } = await start();
    calls.length = 0;
    const base = { id: 'c1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] };
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'snapshot', session: base, live: { text: '', waitingLabel: 'x', prompt: 'go', steerable: true } } });
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'stopping', restoreDraft: true } });
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'stop-done' } });
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'waiting-stop', stopped: true } });
    await until(() => named(calls, 'turnStopped').length === 1);
    expect(named(calls, 'setSteerable')[0]![1]).toBe(true);
    expect(named(calls, 'turnStopping')[0]![1]).toBe(true);
    expect(named(calls, 'stopSettled')).toHaveLength(1);
    bridge.drop();
    expect(await outcome).toBe('Connection to devbox closed');
  }, 20_000);

  it('a message typed while the turn runs is sent under the window\'s own id and shown as what the machine says became of it', async () => {
    const base = { id: 'c1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] };
    const { bridge, calls, outcome } = await start();
    calls.length = 0;
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'snapshot', session: base, live: { text: '', waitingLabel: 'x', prompt: 'go' } } });
    await until(() => named(calls, 'startWaiting').length === 1);
    const submit = named(calls, 'startWaiting')[0]![3] as (text: string, id?: string) => Promise<{ disposition: string; commandOutcome?: string; submission: { id: string } }>;
    const sent = (id: string) => bridge.requests.find((request) => (request as { id?: string }).id === id);

    // Steered into the turn: the row says steered, not the "queued" this window hoped for -- the machine records the steer under the same id.
    const steered = submit('also dictation', 'win-1');
    await until(() => sent('win-1') !== undefined);
    // Under this window's choice (steer unless it chose queue), not whatever the machine there has set.
    expect(sent('win-1')).toMatchObject({ type: 'send', text: 'also dictation', mode: 'steer' });
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'submission', id: 'win-1', disposition: 'steered' } });
    expect(await steered).toMatchObject({ disposition: 'steered', submission: { id: 'win-1' } });

    // Queued behind the turn.
    const waiting = submit('later please', 'win-2');
    await until(() => sent('win-2') !== undefined);
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'submission', id: 'win-2', disposition: 'queued' } });
    expect((await waiting).disposition).toBe('queued');

    // ClikCode's own command, applied at once.
    const command = submit('/model sonnet', 'win-3');
    await until(() => sent('win-3') !== undefined);
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'submission', id: 'win-3', disposition: 'command', commandOutcome: 'applied' } });
    expect(await command).toMatchObject({ disposition: 'command', commandOutcome: 'applied' });

    // Refused: an error, so the words come back to the composer.
    const refused = submit('nope', 'win-4');
    await until(() => sent('win-4') !== undefined);
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'submission', id: 'win-4', disposition: 'error', message: 'The turn is finishing' } });
    await expect(refused).rejects.toThrow('The turn is finishing');

    // One typed as the last turn ended found nothing to steer into: it became the next turn.
    const raced = submit('just in time', 'win-5');
    await until(() => sent('win-5') !== undefined);
    bridge.say({ type: 'turn-start', prompt: 'just in time' });
    expect((await raced).disposition).toBe('queued');

    // A connection that ends with a message unanswered fails it, rather than leaving its row waiting.
    const lost = submit('into the void', 'win-6');
    await until(() => sent('win-6') !== undefined);
    const failed = lost.then(() => 'answered', (error: Error) => error.message);
    bridge.drop();
    expect(await failed).toContain('devbox');
    await outcome;
  }, 30_000);

  it('/send is this window\'s own choice, run here and never sent to the machine; the next mid-turn message carries it', async () => {
    const base = { id: 'c1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] };
    // The window's own chat, which the setting is changed through.
    const { writeState } = await import('../session/state/write.js');
    const now = new Date().toISOString();
    await writeState({
      sessions: [{ id: 'local-1', conversationId: 'local-1', route: 'local', accountId: null, provider: null, model: null, effort: 'high', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active', name: 'Here', messages: [] } as never],
      accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' },
    } as never);
    const { bridge, calls, prompts, outcome } = await start();
    prompts[0]!.answer('/send queue');
    await until(() => prompts.length === 2);
    expect(bridge.requests.some((request) => request.text?.includes('/send'))).toBe(false);
    calls.length = 0;
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'snapshot', session: base, live: { text: '', waitingLabel: 'x', prompt: 'go' } } });
    await until(() => named(calls, 'startWaiting').length === 1);
    const submit = named(calls, 'startWaiting')[0]![3] as (text: string, id?: string) => Promise<unknown>;
    void submit('after this turn', 'win-q').catch(() => undefined);
    await until(() => bridge.requests.some((request) => (request as { id?: string }).id === 'win-q'));
    expect(bridge.requests.find((request) => (request as { id?: string }).id === 'win-q')).toMatchObject({ type: 'send', mode: 'queue' });
    bridge.drop();
    await outcome;
  }, 20_000);

  it('Esc on a message waiting in the turn takes that message back from the worker, and does not stop the turn', async () => {
    const base = { id: 'c1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] };
    const { bridge, calls, outcome } = await start();
    calls.length = 0;
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'snapshot', session: base, live: { text: '', waitingLabel: 'x', prompt: 'go' } } });
    await until(() => named(calls, 'startWaiting').length === 1);
    // startWaiting(label, onCancel, onSubmit, onCommand, onLeave, onTakeBack, onSendWaiting)
    const [, , , , , takeBack, sendNow] = named(calls, 'startWaiting')[0]!.slice(1) as [unknown, unknown, unknown, unknown, unknown, ((id: string) => Promise<string>) | undefined, (() => void) | undefined];
    expect(takeBack, 'without it Esc has nothing to take back and stops the turn').toBeTypeOf('function');
    expect(sendNow).toBeTypeOf('function');
    const taken = takeBack!('win-9');
    await until(() => bridge.requests.some((request) => request.type === 'unqueue'));
    expect(bridge.requests.find((request) => request.type === 'unqueue')).toMatchObject({ type: 'unqueue', id: 'win-9' });
    // The turn was not cancelled by it.
    expect(bridge.requests.some((request) => request.type === 'cancel')).toBe(false);
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'unqueued', id: 'win-9', outcome: 'removed' } });
    expect(await taken).toBe('removed');
    // Enter again, nothing typed: the waiting message is offered to the running turn now.
    sendNow!();
    await until(() => bridge.requests.some((request) => request.type === 'send-queued'));
    // A connection that ends with a take-back unanswered is an error, not a message left hidden.
    const lost = takeBack!('win-10');
    await until(() => bridge.requests.filter((request) => request.type === 'unqueue').length === 2);
    bridge.drop();
    expect(await lost).toBe('error');
    await outcome;
  }, 20_000);

  it('/restart in a chat on another machine is this window\'s: it leaves for the newest build and sends nothing to the machine', async () => {
    const { registerBuildReplacer } = await import('../commands/ai/interactive/build-replace.js');
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const { terminal, prompts, said } = fakeTerminal();
    const bridge = new FakeRemoteBridge();
    registerBuildReplacer(() => undefined);
    const running = runRemoteChat(terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, () => bridge as unknown as ChildProcessWithoutNullStreams, []);
    await until(() => prompts.length === 1);
    // Already the newest: said, and the chat goes on.
    prompts[0]!.answer('/restart');
    await until(() => prompts.length === 2);
    expect(said.some((line) => line.includes('already runs the newest'))).toBe(true);
    // A newer build is there: the window leaves for it.
    registerBuildReplacer(() => Promise.resolve());
    prompts[1]!.answer('/restart');
    expect(await running).toEqual({ exit: true });
    expect(bridge.requests.some((request) => request.text?.includes('/restart'))).toBe(false);
    registerBuildReplacer(undefined);
  });

  it('/restart and /send typed while the turn runs are this window\'s, done here, and never sent to the machine', async () => {
    const { registerBuildReplacer } = await import('../commands/ai/interactive/build-replace.js');
    const base = { id: 'c1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] };
    const { bridge, calls, outcome } = await start();
    calls.length = 0;
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'snapshot', session: base, live: { text: '', waitingLabel: 'x', prompt: 'go' } } });
    await until(() => named(calls, 'startWaiting').length === 1);
    const command = named(calls, 'startWaiting')[0]![4] as (text: string, id?: string) => Promise<{ disposition: string; commandOutcome?: string }>;
    let left = 0;
    registerBuildReplacer(() => { left += 1; return new Promise(() => undefined); });
    expect(await command('/restart', 'r-1')).toMatchObject({ disposition: 'command', commandOutcome: 'applied' });
    expect(left).toBe(1);
    expect(bridge.requests.some((request) => request.text?.includes('/restart'))).toBe(false);
    // Anything else typed as a command is the machine\'s to apply: sent, and answered by its submission.
    const model = command('/model opus', 'r-2');
    await until(() => bridge.requests.some((request) => (request as { id?: string }).id === 'r-2'));
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'submission', id: 'r-2', disposition: 'command', commandOutcome: 'applied' } });
    expect(await model).toMatchObject({ disposition: 'command' });
    registerBuildReplacer(undefined);
    bridge.drop();
    await outcome;
  }, 20_000);

  it('a screenshot named in a message is copied to the machine and the message goes with its path there; refused, nothing is sent and the words come back', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const folder = await mkdtemp(join(tmpdir(), 'cc-shot-'));
    const shot = join(folder, 'Screenshot.png');
    const other = join(folder, 'Other.png');
    await writeFile(shot, Buffer.alloc(8, 1));
    await writeFile(other, Buffer.alloc(8, 2));
    try {
      const { bridge, calls, prompts, outcome } = await start();
      calls.length = 0;
      copying.uploads.length = 0;
      prompts[0]!.answer(`what is wrong here ${shot}`);
      await until(() => bridge.requests.some((request) => request.type === 'send' && request.text?.includes('what is wrong here')));
      const sent = bridge.requests.find((request) => request.type === 'send')!;
      // The machine is told the path it has, never this computer's.
      expect(sent.text).toContain('what is wrong here /tmp/clikcode-image.TEST0001/image.png');
      expect(sent.text).not.toContain(folder);
      expect(copying.uploads).toEqual(['Screenshot.png']);
      await until(() => prompts.length === 2);

      // The copy fails: nothing is sent, it is said, and what was typed is back in the composer.
      copying.fail = 'no route to devbox';
      const before = bridge.requests.filter((request) => request.type === 'send').length;
      prompts[1]!.answer(`and this ${other}`);
      await until(() => named(calls, 'restoreDraft').length === 1);
      expect(named(calls, 'restoreDraft')[0]![1]).toBe(`and this ${other}`);
      expect(bridge.requests.filter((request) => request.type === 'send')).toHaveLength(before);
      await until(() => prompts.length === 3);
      copying.fail = undefined;
      bridge.drop();
      await outcome;
    } finally { copying.fail = undefined; await rm(folder, { recursive: true, force: true }); }
  }, 20_000);

  it('a screenshot in a message typed while the turn runs is copied too, and a refused copy fails that message', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const folder = await mkdtemp(join(tmpdir(), 'cc-shot-'));
    const shot = join(folder, 'Mid.png');
    const other = join(folder, 'Later.png');
    await writeFile(shot, Buffer.alloc(8, 1));
    await writeFile(other, Buffer.alloc(8, 2));
    const base = { id: 'c1', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] };
    try {
      const { bridge, calls, outcome } = await start();
      calls.length = 0;
      bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'snapshot', session: base, live: { text: '', waitingLabel: 'x', prompt: 'go' } } });
      await until(() => named(calls, 'startWaiting').length === 1);
      const submit = named(calls, 'startWaiting')[0]![3] as (text: string, id?: string) => Promise<unknown>;
      const accepted = submit(`also ${shot}`, 'img-1');
      await until(() => bridge.requests.some((request) => (request as { id?: string }).id === 'img-1'));
      expect(bridge.requests.find((request) => (request as { id?: string }).id === 'img-1')!.text).toBe('also /tmp/clikcode-image.TEST0001/image.png');
      bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'submission', id: 'img-1', disposition: 'queued' } });
      await accepted;
      copying.fail = 'no route to devbox';
      await expect(submit(`again ${other}`, 'img-2')).rejects.toThrow('no route to devbox');
      expect(bridge.requests.some((request) => (request as { id?: string }).id === 'img-2')).toBe(false);
      bridge.drop();
      await outcome;
    } finally { copying.fail = undefined; await rm(folder, { recursive: true, force: true }); }
  }, 20_000);

  it('a sub-agent opened in a chat on another machine is read there, and a message to it goes there', async () => {
    const { bridge, assigned, outcome } = await start();
    const read = assigned.subAgentRead as (parentId: string) => Promise<unknown[]>;
    const steer = assigned.subAgentSteer as (ref: { id: string; agentId?: string }, text: string) => Promise<string | undefined>;
    expect(read, 'without it the view reads this computer\'s disk for a transcript that is on the other machine').toBeTypeOf('function');
    expect(await read('a1')).toEqual([{ kind: 'prompt', text: 'Find why the deploy stalls' }, { kind: 'text', text: 'read a1' }]);
    expect(bridge.requests.find((request) => request.type === 'subagent')).toMatchObject({ action: 'read', parentId: 'a1' });
    // Sent: nothing to say. Refused: the machine's reason, for the view to show.
    expect(await steer({ id: 'a1', agentId: 'x9' }, 'also check the retry')).toBeUndefined();
    expect(bridge.requests.filter((request) => request.type === 'subagent').at(-1)).toMatchObject({ action: 'steer', parentId: 'a1', text: 'also check the retry' });
    expect(await steer({ id: 'refused' }, 'hello')).toBe('Not sent: the sub-agent has finished.');
    bridge.drop();
    await outcome;
  }, 20_000);

  it('Left while a turn this window started runs steps away from it at once: the prompt comes back, the turn goes on there', async () => {
    const { bridge, calls, prompts, outcome } = await start();
    // The machine runs the turn: its send is not done until the turn ends, which here is never.
    bridge.onSend = () => undefined;
    calls.length = 0;
    prompts[0]!.answer('start the long job');
    await until(() => bridge.requests.some((request) => request.type === 'send'));
    bridge.say({ type: 'turn-start', prompt: 'start the long job' });
    await until(() => named(calls, 'startWaiting').length === 1);
    const leave = named(calls, 'startWaiting')[0]![5] as () => void;
    leave();
    // Without the wait being let go of, the loop sat at the turn's end and no prompt was ever asked for again.
    await until(() => prompts.length === 2);
    expect(bridge.requests.some((request) => request.type === 'cancel')).toBe(false);
    bridge.drop();
    await outcome;
  }, 20_000);

  it('Left before the machine has started the turn steps away too', async () => {
    const { bridge, calls, prompts, outcome } = await start();
    bridge.onSend = () => undefined;
    calls.length = 0;
    prompts[0]!.answer('start the long job');
    await until(() => named(calls, 'turnStarting').length === 1);
    // The turn is queued behind other work there and has not begun: Left is still Left.
    (named(calls, 'turnStarting')[0]![1] as () => void)();
    await until(() => prompts.length === 2);
    bridge.drop();
    await outcome;
  }, 20_000);

  it('a message the machine steered into a turn this window was not following is a waiting message here, not gone', async () => {
    const { bridge, calls, prompts, outcome } = await start();
    calls.length = 0;
    prompts[0]!.answer('also check the retry');
    await until(() => bridge.requests.some((request) => request.type === 'send'));
    const id = (bridge.requests.find((request) => request.type === 'send') as { id?: string }).id!;
    // The machine's send is "done" at once -- the message went into a running turn -- and the answer of the worker follows.
    await until(() => prompts.length === 2);
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'submission', id, disposition: 'steered' } });
    await until(() => named(calls, 'adoptSubmission').length === 1);
    expect(named(calls, 'adoptSubmission')[0]!.slice(1)).toEqual([id, 'also check the retry', 'steered']);
    // The turn it went into is followed.
    expect(named(calls, 'startWaiting').length).toBeGreaterThan(0);
    bridge.drop();
    await outcome;
  }, 20_000);

  it('a turn another window started on the chat is followed from its start', async () => {
    const { bridge, calls, outcome } = await start();
    calls.length = 0;
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'waiting-start', message: 'thinking', prompt: 'from the other window' } });
    await until(() => named(calls, 'startWaiting').length === 1);
    bridge.drop();
    await outcome;
  }, 20_000);

  it('a command\'s text result is drawn here, a confirmation-only one is not, and a file it wrote is said to be on the machine', async () => {
    const { bridge, calls, said, outcome } = await start();
    calls.length = 0;
    bridge.say({ type: 'output', payload: { panel: 'status', text: 'ClikCode\n  chat      Demo\n  project   ~' } });
    await until(() => named(calls, 'panel').length === 1);
    expect(named(calls, 'panel')[0]!.slice(1)).toEqual(['ClikCode', '  chat      Demo\n  project   ~']);
    // "Conversation renamed" says what the title on the rule already says.
    bridge.say({ type: 'output', payload: { panel: 'session-renamed', text: 'Conversation renamed to X' } });
    bridge.say({ type: 'open-file', path: '/Users/chronos/export.md' });
    await until(() => said.some((line) => line.includes('/Users/chronos/export.md')));
    expect(said.find((line) => line.includes('export.md'))).toContain('On devbox');
    expect(named(calls, 'panel')).toHaveLength(1);
    bridge.drop();
    await outcome;
  }, 20_000);

  it('/copy on another machine is asked for, and lands on this computer\'s clipboard', async () => {
    const { bridge, outcome } = await start();
    expect(bridge.requests.find((request) => request.type === 'open')).toMatchObject({ features: expect.arrayContaining(['copy']) });
    clipboard.copied.length = 0;
    bridge.say({ type: 'copy', text: 'the last answer' });
    await until(() => clipboard.copied.length === 1);
    expect(clipboard.copied).toEqual(['the last answer']);
    bridge.drop();
    await outcome;
  }, 20_000);

  it('a chat closed on the machine (deleted, archived there) brings up the list, not a prompt to a chat that is gone', async () => {
    boardPicker.mockReset().mockResolvedValueOnce(undefined);
    const { bridge, prompts, outcome } = await start();
    bridge.say({ type: 'closed', sessionId: 'c1' });
    await until(() => boardPicker.mock.calls.length === 1);
    await until(() => prompts.length === 2);
    bridge.drop();
    await outcome;
  }, 20_000);

  it('a turn another window starts takes over the idle prompt, keeping its place, and the prompt comes back when the turn ends', async () => {
    const { bridge, calls, prompts, outcome } = await start();
    calls.length = 0;
    // Idle at the prompt: another window starts a turn on the chat. Two things reading the keyboard was what this was.
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'waiting-start', message: 'thinking', prompt: 'from the other window' } });
    await until(() => named(calls, 'startWaiting').length === 1);
    expect(prompts).toHaveLength(1);
    bridge.say({ type: 'worker', sessionId: 'c1', event: { type: 'waiting-stop' } });
    await until(() => prompts.length === 2);
    bridge.drop();
    await outcome;
  }, 20_000);

  it('/new, /fork and /resume switch the chat the machine shows: a reconnect opens that one, not the one first picked', async () => {
    const machine = newMachineRecord({ name: 'devbox', sshTarget: 'devbox', ready: true });
    await updateMachines(() => [machine]);
    const bridges: FakeRemoteBridge[] = [];
    const { terminal, prompts } = fakeTerminal();
    const running = runRemoteChat(terminal, 'local-1', { machineId: machine.id, chatId: 'c1' }, undefined, () => {
      const bridge = new FakeRemoteBridge();
      bridges.push(bridge);
      return bridge as unknown as ChildProcessWithoutNullStreams;
    }, [0]);
    const outcome = running.then(() => 'returned', (error: Error) => error.message);
    await until(() => prompts.length === 1);
    const base = { id: 'c2', route: 'local', accountId: null, provider: 'claude', model: 'm', effort: 'high', name: 'Forked', createdAt: '', updatedAt: '', status: 'active', messages: [] };
    bridges[0]!.say({ type: 'session', session: base });
    bridges[0]!.retire();
    await until(() => bridges.length === 2 && prompts.length === 2);
    expect(bridges[1]!.requests[0]).toMatchObject({ type: 'open', mode: 'resume', sessionId: 'c2' });
    prompts[1]!.answer('/exit');
    expect(await outcome).toBe('returned');
  }, 20_000);

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
