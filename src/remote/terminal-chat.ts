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
import { readMachines, updatePolicy, type RemoteMachine } from './machines.js';
import { autoUpdates, localBuildCommit, pinnedUpdateLine } from './updates.js';
import { needsUpdate } from './connection.js';
import { spawnSsh, sshArgv } from './ssh.js';
import type { LiveTurnInputResult } from '../turn/live-input.js';
import type { SignInScreen } from '../gateway/login/vendor-sign-in.js';
import { parseSlashInput } from '../tui/slash/registry.js';
import { chatHasContent } from '../session/move-chat.js';
import { moveTerminalChat, offerMovedChat, remoteMoveEnd } from './move-terminal.js';

/** A chat on another machine to show: `chatId`, or a new one there when
 * absent; `notice` is said once it is open (a move's "Moved to …"). */
export interface RemoteChatSelection { machineId: string; chatId?: string; notice?: string }

type RemoteOpen = Omit<Extract<IdeRequest, { type: 'open' }>, 'requestId'>;
/** A request answered by a `result`, without its id (the bridge gives it one). */
type Answered<T = IdeRequest> = T extends { requestId: string } ? Omit<T, 'requestId'> : never;

/** Resuming a chat on another machine names no folder: this terminal's cwd
 * is a folder of this machine, and the chat keeps its own saved workspace
 * on the machine that owns it (ide/bridge.ts open). */
export function remoteResume(chatId: string): RemoteOpen {
  return { type: 'open', mode: 'resume', sessionId: chatId };
}

/** Starts the machine's bridge (`ide-bridge --stdio` over ssh); a test's own. */
export type RemoteBridgeStarter = (target: string) => ChildProcessWithoutNullStreams;
const sshBridge: RemoteBridgeStarter = (target) => spawnSsh(target, bridgeScript());

/** One chat channel into a machine's ClikCode (its multiplexed bridge, over ssh). */
export class TerminalBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly chat = randomUUID();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private ready: Promise<void>;
  private stopped = false;
  private closing = false;
  private error = '';
  /** Its ClikCode is another build than this one (connection.ts needsUpdate). */
  outdated = false;
  /** Which additive requests it answers (protocol-version.ts); 1 when it did not say. */
  revision = 1;
  /** It said it is leaving for a newer build installed there (ide/bridge-retire.ts):
   * the close that follows is a reconnect, not a lost connection. */
  retiring = false;
  onEvent: (event: IdeEvent) => void = () => undefined;
  onClose: (error: Error) => void = () => undefined;

  constructor(target: string, start: RemoteBridgeStarter = sshBridge) {
    this.child = start(target);
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
          this.revision = message.revision ?? 1;
          this.send({ type: 'chat-attach', chat: this.chat });
          return;
        }
        if (message.type === 'host-retiring') { this.retiring = true; return; }
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
  request<T = unknown>(request: Answered): Promise<T> {
    const requestId = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    this.post({ ...request, requestId } as IdeRequest);
    return result as Promise<T>;
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

/** What a chat on a machine with another ClikCode build says on opening:
 * that it is being brought to this build, or how to update it. */
export function outdatedNotice(machine: Pick<RemoteMachine, 'name' | 'updates' | 'updateError'>, updating: boolean, localCommit = localBuildCommit()): string {
  const differs = `${machine.name} runs another ClikCode build than this one`;
  if (updating) return `${differs}: updating it to this one's${localCommit ? ` (${localCommit.slice(0, 8)})` : ''} in the background; its chats switch over once they are quiet.`;
  const how = 'Type /update to update it, or choose it in /remote.';
  if (machine.updateError && updatePolicy(machine) === 'auto') return `${differs}, and updating it failed (${machine.updateError}). ${how}`;
  return `${differs}. ${how}`;
}

/** Returns the local chat to resume, or opens another selected remote chat.
 *
 * A bridge there that leaves for a newer ClikCode build (it does so only while
 * the chat is quiet, ide/bridge-retire.ts) is connected to again at once and
 * the same chat resumed, with nothing said: what was being typed stays in the
 * composer (prompt-input.ts keeps an interrupted prompt's draft). Any other
 * close is a lost connection, said as before. */
export async function runRemoteChat(
  terminal: TerminalHarnessPrompter, localId: string, first: RemoteChatSelection, firstDraft?: string,
  startBridge: RemoteBridgeStarter = sshBridge,
): Promise<string | undefined> {
  let choice: RemoteChatSelection | undefined = first;
  let draft = firstDraft;
  /** Connecting again after the bridge there retired: the opening notices were said already. */
  let rejoining = false;
  while (choice) {
    const machine = (await readMachines()).find((item) => item.id === choice!.machineId && item.ready);
    if (!machine) throw new Error('That remote machine is no longer added. Open /remote to add it again.');
    terminal.remoteMachineName = machine.name;
    const bridge = new TerminalBridge(machine.sshTarget, startBridge);
    let session: HarnessSession | undefined;
    let account: string | undefined;
    let running = false;
    let waitingInput = false;
    let leftTurn = false;
    let finishTurn: (() => void) | undefined;
    let turnEnd: Promise<void> | undefined;
    let lastError: Error | undefined;
    /** A line sent and not yet answered. */
    let sending: string | undefined;
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
        // Its last lines (an /update's steps) are drawn before the wait ends.
        case 'busy': if (event.label) terminal.startWaiting(event.label); else if (!running) { terminal.flushPaint(); terminal.stopWaiting(); } return;
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
      const selection: RemoteChatSelection = choice;
      // Intent only: the chat is in one of the remote's own folders (session/attach.ts).
      const opened = await bridge.request<{ sessionId?: string } | undefined>(selection.chatId ? remoteResume(selection.chatId) : { type: 'open', mode: 'new' });
      // A new chat there is that chat from here on: a rejoin resumes it.
      if (!selection.chatId && opened?.sessionId) choice = { ...selection, chatId: opened.sessionId };
      // After the open, whose chat clears the rows before it. Updated from here only by the
      // machine's own policy (remote/updates.ts): a production machine set to ask is
      // updated when the user says so.
      if (bridge.outdated && !rejoining) {
        const started = await autoUpdates.consider(machine).catch(() => undefined);
        terminal.activity(outdatedNotice(machine, Boolean(started)));
        void started?.done.then((outcome) => terminal.activity(outcome.ok
          ? `ClikCode on ${machine.name} is updated${outcome.info.commit ? ` to ${outcome.info.commit.slice(0, 8)}` : ''}; its chats switch over once they are quiet.`
          : `Updating ClikCode on ${machine.name} failed: ${outcome.message} Type /update to update it.`), () => undefined);
      }
      if (!rejoining && selection.notice) terminal.activity(selection.notice);
      choice = { ...choice, notice: undefined };
      // A chat that moved on from there: offered where it went (it is read-only there).
      if (!rejoining && session?.movedTo) {
        const next = await offerMovedChat(terminal, session.movedTo);
        if (next && 'local' in next) return next.local;
        if (next) { choice = next.remote; continue; }
      }
      if (draft) terminal.restoreDraft(draft);
      draft = undefined;
      rejoining = false;
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
        // /machine: this chat moves to another machine (move-terminal.ts), from the one it is on.
        if (parseSlashInput(line)?.head === 'machine') {
          const next = await moveTerminalChat(terminal, { remote: choice }, session?.id ?? choice.chatId ?? '', Boolean(session && chatHasContent(session)),
            remoteMoveEnd(bridge, machine), startBridge).catch((error: unknown) => { terminal.activity(error instanceof Error ? error.message : String(error)); return undefined; });
          if (!next) continue;
          if ('local' in next) return next.local;
          choice = next.remote;
          break;
        }
        const id = randomUUID();
        const complete = new Promise<void>((resolve, reject) => completions.set(id, { resolve, reject }));
        sending = line;
        bridge.post({ type: 'send', text: pinnedUpdateLine(line, localBuildCommit()), id });
        await complete;
        sending = undefined;
        if (lastError) { terminal.activity(lastError.message); lastError = undefined; }
      }
    } catch (error) {
      if (!bridge.retiring) throw error;
      rejoining = true;
      // Sent as it left: a bridge leaving takes nothing more, so the line was
      // never run. Back in the composer, for Enter on the new build.
      if (sending !== undefined) draft = sending;
      continue;
    } finally { promptController.abort(); for (const screen of signIns.values()) screen.stop(); bridge.close(); terminal.remoteMachineName = undefined; }
  }
  return undefined;
}
