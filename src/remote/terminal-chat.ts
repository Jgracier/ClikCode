/** The terminal as a client of a chat owned by another machine. The same
 * multiplexed bridge that VS Code uses carries its session and worker events;
 * only the screen and keyboard stay on this machine. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HarnessSession } from '../session/model.js';
import type { IdeEvent, IdeHostEvent, IdeHostRequest, IdeRequest, IdeUiResult } from '../ide/protocol.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';
import { interactiveSessionPicker } from '../tui/pickers/session.js';
import { BOARD_COMMANDS, BOARD_LINE } from '../commands/ai/interactive/board.js';
import { bridgeScript, remoteTerminalScript } from './install.js';
import { readMachines } from './machines.js';
import { needsUpdate } from './connection.js';
import { spawnSsh, sshArgv } from './ssh.js';
import type { LiveTurnInputResult } from '../turn/live-input.js';
import type { SignInScreen } from '../gateway/login/vendor-sign-in.js';

export interface RemoteChatSelection { machineId: string; chatId: string }

type RemoteOpen = Omit<Extract<IdeRequest, { type: 'open' }>, 'requestId'>;

/** Resuming a chat on another machine names no folder: this terminal's cwd
 * is a folder of this machine, and the chat keeps its own saved workspace
 * on the machine that owns it (ide/bridge.ts open). */
export function remoteResume(chatId: string): RemoteOpen {
  return { type: 'open', mode: 'resume', sessionId: chatId };
}

class TerminalBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly chat = randomUUID();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private ready: Promise<void>;
  private stopped = false;
  private closing = false;
  private error = '';
  /** Its ClikCode is another build than this one (connection.ts needsUpdate). */
  outdated = false;
  onEvent: (event: IdeEvent) => void = () => undefined;
  onClose: (error: Error) => void = () => undefined;

  constructor(target: string) {
    this.child = spawnSsh(target, bridgeScript());
    this.child.stderr.on('data', (chunk: Buffer) => { this.error = `${this.error}${chunk.toString('utf8')}`.slice(-2000); });
    this.child.stdin.on('error', () => undefined);
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer from ${target}`)), 30_000);
      const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        let message: IdeHostEvent;
        try { message = JSON.parse(line) as IdeHostEvent; } catch { return; }
        if (message.type === 'host-ready') {
          this.outdated = needsUpdate(message);
          this.send({ type: 'chat-attach', chat: this.chat });
          return;
        }
        if (message.type !== 'chat' || message.chat !== this.chat) return;
        const event = message.event;
        if (event.type === 'ready') { clearTimeout(timer); resolve(); }
        if (event.type === 'result') {
          const waiter = this.pending.get(event.requestId);
          if (waiter) {
            this.pending.delete(event.requestId);
            event.ok ? waiter.resolve(event.data) : waiter.reject(new Error(event.error ?? 'Remote request failed'));
          }
        }
        this.onEvent(event);
      });
      this.child.once('close', () => {
        this.stopped = true;
        clearTimeout(timer);
        const failure = new Error(this.error.trim().split('\n').pop() || `Connection to ${target} closed`);
        reject(failure);
        for (const waiter of this.pending.values()) waiter.reject(failure);
        this.pending.clear();
        if (!this.closing) this.onClose(failure);
      });
      this.child.once('error', (error) => { this.error = error.message; });
    });
  }

  async connected(): Promise<void> { return this.ready; }
  private send(message: IdeHostRequest): void {
    if (this.stopped || this.child.stdin.destroyed) throw new Error('Remote connection closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  post(request: IdeRequest): void { this.send({ type: 'chat', chat: this.chat, request }); }
  request(request: RemoteOpen): Promise<unknown> {
    const requestId = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    this.post({ ...request, requestId } as IdeRequest);
    return result;
  }
  close(): void {
    if (this.stopped) return;
    this.closing = true;
    this.post({ type: 'close' });
    this.child.stdin.end();
    setTimeout(() => { if (!this.stopped) this.child.kill(); }, 3_000).unref();
  }
}

async function answerUi(bridge: TerminalBridge, terminal: TerminalHarnessPrompter, event: Extract<IdeEvent, { type: 'ui-request' }>): Promise<void> {
  const request = event.request;
  let result: IdeUiResult;
  if (request.kind === 'input') {
    try {
      result = { text: await terminal.question(`${request.prompt} › `, [], { cancellable: true, secret: request.secret }) };
    } catch { result = { cancelled: true }; }
  } else {
    const choices = request.items.flatMap((item, index) => [
      { label: item.label, detail: item.detail, group: item.group, value: { index } as IdeUiResult },
      ...(item.inline?.choices.map((choice) => ({ label: `  ${choice.label}`, detail: choice.value === item.inline?.current ? '· current' : undefined,
        value: { index, value: choice.value } as IdeUiResult })) ?? []),
      ...(item.actions?.map((action) => ({ label: `  ${action.label}`, value: { index, action: action.value } as IdeUiResult })) ?? []),
      ...(item.deleteAction ? [{ label: `  ${item.deleteAction.label}`, value: { index, action: item.deleteAction.value } as IdeUiResult }] : []),
    ]);
    result = await terminal.select(request.title, choices) ?? { cancelled: true };
  }
  bridge.post({ type: 'ui-response', id: event.id, result });
}

async function runSignIn(target: string, spec: string, terminal: TerminalHarnessPrompter): Promise<void> {
  await terminal.suspend();
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ssh', sshArgv(target, remoteTerminalScript(spec), ['-tt']), { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Remote sign-in exited ${code ?? '?'}`)));
    });
  } finally { terminal.resume(); }
}

/** Returns the local chat to resume, or opens another selected remote chat. */
export async function runRemoteChat(
  terminal: TerminalHarnessPrompter, localId: string, first: RemoteChatSelection, firstDraft?: string,
): Promise<string | undefined> {
  let choice: RemoteChatSelection | undefined = first;
  let draft = firstDraft;
  while (choice) {
    const machine = (await readMachines()).find((item) => item.id === choice!.machineId && item.ready);
    if (!machine) throw new Error('That remote machine is no longer added. Open /remote to add it again.');
    terminal.remoteMachineName = machine.name;
    const bridge = new TerminalBridge(machine.sshTarget);
    let session: HarnessSession | undefined;
    let account: string | undefined;
    let running = false;
    let waitingInput = false;
    let leftTurn = false;
    let finishTurn: (() => void) | undefined;
    let turnEnd: Promise<void> | undefined;
    let lastError: Error | undefined;
    const completions = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
    const promptController = new AbortController();
    const signIns = new Map<string, SignInScreen>();
    const queued = (text: string): Promise<LiveTurnInputResult> => {
      const id = randomUUID();
      bridge.post({ type: 'send', text, id });
      return Promise.resolve({ disposition: 'queued', submission: { id, text, submittedAt: new Date().toISOString() } });
    };
    const beginWaiting = (prompt?: string): void => {
      if (waitingInput) return;
      waitingInput = true;
      turnEnd = new Promise<void>((resolve) => { finishTurn = resolve; });
      if (prompt !== undefined) terminal.submitted(prompt);
      terminal.startWaiting('thinking', (restoreDraft) => bridge.post({ type: 'cancel', restoreDraft }),
        queued, queued, () => { leftTurn = true; waitingInput = false; finishTurn?.(); terminal.stopWaiting(); });
    };
    bridge.onEvent = (event) => {
      switch (event.type) {
        case 'session': session = event.session; account = event.account; terminal.render(session, account, { running }); return;
        case 'turn-start':
          running = true;
          beginWaiting(event.prompt);
          return;
        case 'worker': {
          const worker = event.event;
          if (worker.type === 'snapshot') {
            session = worker.session; account = worker.account;
            running = Boolean(worker.live);
            terminal.render(session, account, worker.live ? { running: true, prompt: worker.live.prompt } : { running: false });
            if (worker.live) beginWaiting(worker.live.prompt);
          }
          else if (worker.type === 'delta') terminal.response(worker.text, worker.mode);
          else if (worker.type === 'activity') terminal.activityEvent(worker.event);
          else if (worker.type === 'note') terminal.activity(worker.message, worker.seq === undefined ? undefined : `notice:${worker.seq}`);
          else if (worker.type === 'phase') terminal.phase(worker.message);
          else if (worker.type === 'plan') terminal.setPlan(worker.entries);
          else if (worker.type === 'usage') terminal.setTurnUsage(worker.usage);
          else if (worker.type === 'restore-draft') terminal.restoreDraft(worker.text);
          else if (worker.type === 'waiting-stop') { running = false; waitingInput = false; terminal.stopWaiting(); finishTurn?.(); }
          else if (worker.type === 'turn-error') lastError = new Error(worker.message);
          else if (worker.type === 'approval-request') void terminal.approval(worker.title, worker.detail, worker.preview, worker.rule, undefined, worker.callId).then((approved) => bridge.post({ type: 'approval-response', id: worker.id, approved }));
          else if (worker.type === 'question-request') void terminal.askQuestions(worker.request).then((result) => bridge.post({ type: 'question-response', id: worker.id, result }));
          return;
        }
        case 'ui-request':
          if (!running && terminal.turn) terminal.stopWaiting(false);
          void answerUi(bridge, terminal, event).catch((error: unknown) => {
            terminal.activity(error instanceof Error ? error.message : String(error));
            bridge.post({ type: 'ui-response', id: event.id, result: { cancelled: true } });
          });
          return;
        case 'sign-in': void runSignIn(machine.sshTarget, event.spec, terminal).then(
          () => bridge.post({ type: 'sign-in-result', id: event.id }),
          (error: unknown) => bridge.post({ type: 'sign-in-result', id: event.id, error: error instanceof Error ? error.message : String(error) }),
        ); return;
        case 'sign-in-link': {
          let screen = signIns.get(event.id);
          if (event.done) { screen?.stop(); signIns.delete(event.id); return; }
          if (!screen) {
            screen = terminal.signInScreen(event.name);
            signIns.set(event.id, screen);
            screen.signal.addEventListener('abort', () => bridge.post({ type: 'sign-in-cancel', id: event.id }), { once: true });
          }
          if (event.url) screen.show({ url: event.url, ...(event.code ? { code: event.code } : {}) });
          if (event.ask) void screen.ask(event.ask.prompt, Boolean(event.ask.secret), false, true).then((text) => bridge.post({ type: 'sign-in-answer', id: event.id, text }));
          return;
        }
        case 'usage': terminal.usage(event.label, event.reset); return;
        case 'notice': terminal.activity(event.message); return;
        case 'panel': terminal.panel(event.title, event.body); return;
        case 'restore-draft': terminal.restoreDraft(event.text); return;
        case 'send-complete': completions.get(event.id)?.resolve(); completions.delete(event.id); return;
        case 'busy': if (event.label) terminal.startWaiting(event.label); else if (!running) terminal.stopWaiting(); return;
        case 'closed': terminal.activity('This conversation closed on the remote machine.'); return;
      }
    };
    bridge.onClose = (error) => {
      promptController.abort();
      finishTurn?.();
      for (const completion of completions.values()) completion.reject(error);
      completions.clear();
    };
    try {
      await bridge.connected();
      // Intent only: the chat is in one of the remote's own folders (session/attach.ts).
      await bridge.request(remoteResume(choice.chatId));
      // After the open, whose chat clears the rows before it. Never updated from here: a
      // production machine is updated when the user says so.
      if (bridge.outdated) terminal.activity(`${machine.name} runs another ClikCode build than this one. Update it from /remote.`);
      if (draft) terminal.restoreDraft(draft);
      draft = undefined;
      for (;;) {
        if (waitingInput) await turnEnd;
        const line = leftTurn ? BOARD_LINE : (await terminal.question('› ', [], { leftArrowCommand: BOARD_LINE, signal: promptController.signal })).trim();
        leftTurn = false;
        if (line === BOARD_LINE) {
          const picked = await interactiveSessionPicker(terminal, localId, BOARD_COMMANDS);
          if (!picked) continue;
          if ('remote' in picked) { choice = picked.remote; draft = picked.draft; break; }
          if ('id' in picked) return picked.id;
          if ('compose' in picked) { terminal.restoreDraft(picked.compose); continue; }
          if ('command' in picked) { terminal.restoreDraft(picked.command); continue; }
          continue;
        }
        if (!line) continue;
        const id = randomUUID();
        const complete = new Promise<void>((resolve, reject) => completions.set(id, { resolve, reject }));
        bridge.post({ type: 'send', text: line, id });
        await complete;
        if (lastError) { terminal.activity(lastError.message); lastError = undefined; }
      }
    } finally { promptController.abort(); for (const screen of signIns.values()) screen.stop(); bridge.close(); terminal.remoteMachineName = undefined; }
  }
  return undefined;
}
