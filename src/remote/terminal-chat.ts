/** The terminal as a client of a chat owned by another machine. The same
 * multiplexed bridge that VS Code uses carries its session and worker events;
 * only the screen and keyboard stay on this machine. */
import { quiet } from '../runtime/lifecycle-log.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HarnessSession } from '../session/model.js';
import type { IdeEvent, IdeFeature, IdeHostEvent, IdeHostRequest, IdeRequest, IdeSlashCommand, IdeUiResult } from '../ide/protocol.js';
import { SessionDeltaReceiver } from '../ide/session-delta.js';
import { ChatKeeper, readChatCache } from './chat-cache.js';
import { decodeWireLine } from '../ide/wire-gzip.js';
import { applyLiveEvent, drawJoinedTurn, newLiveTurnState, recordDecision } from '../worker/joined-turn.js';
import type { HarnessQuestionResult } from '../harness/events/question.js';
import { isTranscriptActivity, type WorkerEvent } from '../worker/protocol.js';
import { backgroundWorkOf } from '../harness/protocol/background-agents.js';
import type { PaletteEntry } from '../tui/command-palette.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';
import { interactiveSessionPicker } from '../tui/pickers/session.js';
import { BOARD_LINE, BOARD_OWNS } from '../commands/ai/interactive/board.js';
import { remoteTerminalScript } from './install.js';
import { startBridge } from './peer.js';
import { readMachines, updatePolicy, type RemoteMachine } from './machines.js';
import { remoteRowValue } from './board-rows.js';
import { autoUpdates, localBuildCommit, pinnedUpdateLine } from './updates.js';
import { needsUpdate, reachWindowMachine, reconnectWindowMachine, tapWindowMachine, type LinkTap, type LinkTapHandlers } from './connection.js';
import { sshArgv } from './ssh.js';
import { failureText } from '../harness/protocol/stderr-line.js';
import type { LiveTurnInputResult } from '../turn/live-input.js';
import type { SignInScreen } from '../gateway/login/vendor-sign-in.js';
import { parseSlashInput, resolveSlashCommand, TERMINAL_ONLY_COMMANDS } from '../tui/slash/registry.js';
import { chatHasContent } from '../session/move-chat.js';
import { liveChat, moveTerminalChat, remoteMoveEnd, type Here } from './move-terminal.js';

/** The bridge revision that answers `reclaim-moved`. */
const RECLAIM_REVISION = 6;

/** A chat on another machine to show: `chatId`, or a new one there when absent. */
export interface RemoteChatSelection { machineId: string; chatId?: string }

type RemoteOpen = Omit<Extract<IdeRequest, { type: 'open' }>, 'requestId'>;
/** A request answered by a `result`, without its id (the bridge gives it one). */
type Answered<T = IdeRequest> = T extends { requestId: string } ? Omit<T, 'requestId'> : never;

/** Resuming a chat on another machine names no folder: this terminal's cwd
 * is a folder of this machine, and the chat keeps its own saved workspace
 * on the machine that owns it (ide/bridge.ts open). */
export function remoteResume(chatId: string): RemoteOpen {
  return { type: 'open', mode: 'resume', sessionId: chatId, features: REMOTE_FEATURES };
}

/** What this terminal handles beyond the base protocol: the conversation
 * whole on opening, and only what changed after (ide/session-delta.ts). */
const REMOTE_FEATURES: readonly IdeFeature[] = ['session-delta'];

/** Starts the machine's bridge (`ide-bridge --stdio` over ssh); a test's own. */
export type RemoteBridgeStarter = (target: string) => ChildProcessWithoutNullStreams;
const sshBridge: RemoteBridgeStarter = (target) => startBridge(target);

/** A request the machine never answers is a hang: kept because a link ssh has
 * not noticed is dead looks exactly like this. */
const REQUEST_TIMEOUT_MS = 60_000;
/** How much of the bridge's stderr is held for the reason it closed: the end, where the cause is. */
const STDERR_KEEP = 16_000;

/** One chat channel into a machine's ClikCode (its multiplexed bridge, over ssh): a chat on the window's connection to that machine
 * (`link`: no new ssh, no new process there -- the host is already running), or, where there is no window connection to use (a
 * test, a caller that names its own `start`), over an ssh of its own. */
export class TerminalBridge {
  private child: ChildProcessWithoutNullStreams | undefined;
  private tap: LinkTap | undefined;
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
  /** The connection closed without this window asking: why, in the bridge's own words. */
  dropped: Error | undefined;
  /** The chat there answered `ready` at least once: what closes after is a drop, not a refusal to start. */
  wasReady = false;
  onEvent: (event: IdeEvent) => void = () => undefined;
  /** The conversation as the bridge last sent it: its events made whole again. */
  private readonly delta = new SessionDeltaReceiver();
  onClose: (error: Error) => void = () => undefined;

  constructor(
    private readonly target: string, start: RemoteBridgeStarter = sshBridge, private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
    link?: (chat: string, handlers: LinkTapHandlers) => LinkTap | undefined,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer from ${target}`)), 30_000);
      /** The chat's own events, wherever they came by. */
      const chatEvent = (sent: IdeEvent): void => {
        const event = this.delta.expand(sent);
        if (event.type === 'ready') { this.wasReady = true; clearTimeout(timer); resolve(); }
        if (event.type === 'result') {
          const waiter = this.pending.get(event.requestId);
          if (waiter) {
            this.pending.delete(event.requestId);
            event.ok ? waiter.resolve(event.data) : waiter.reject(new Error(event.error ?? 'Remote request failed'));
          }
        }
        this.onEvent(event);
      };
      /** The way to the chat is gone. */
      const ended = (failure: Error): void => {
        this.stopped = true;
        clearTimeout(timer);
        reject(failure);
        for (const waiter of this.pending.values()) waiter.reject(failure);
        this.pending.clear();
        if (!this.closing) { this.dropped = failure; this.onClose(failure); }
      };
      this.tap = link?.(this.chat, {
        event: chatEvent,
        ended: (failure, retiring) => { if (retiring) this.retiring = true; ended(failure); },
      });
      if (link) {
        // On the window's connection or not at all: one that dropped since it was asked is a connection that ended (the chat is opened
        // again once it is back), not a reason to start an ssh of its own at a machine that may be down.
        if (!this.tap) { ended(new Error(`The connection to ${target} is not up`)); return; }
        this.outdated = this.tap.outdated;
        this.revision = this.tap.revision;
        return;
      }
      const child = start(target);
      this.child = child;
      child.stderr.on('data', (chunk: Buffer) => { this.error = `${this.error}${chunk.toString('utf8')}`.slice(-STDERR_KEEP); });
      child.stdin.on('error', () => undefined);
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        let message: IdeHostEvent;
        try { message = JSON.parse(decodeWireLine(line)) as IdeHostEvent; } catch { return; }
        if (message.type === 'host-ready') {
          this.outdated = needsUpdate(message);
          this.revision = message.revision ?? 1;
          this.send({ type: 'chat-attach', chat: this.chat });
          return;
        }
        if (message.type === 'host-retiring') { this.retiring = true; return; }
        if (message.type !== 'chat' || message.chat !== this.chat) return;
        chatEvent(message.event);
      });
      child.once('close', () => ended(new Error(failureText(this.error) || `Connection to ${target} closed`)));
      child.once('error', (error) => { this.error = error.message; });
    });
  }

  async connected(): Promise<void> { return this.ready; }
  /** The chat kept from last time as held: the next `open` of it says so. */
  preload(sessionId: string, messages: NonNullable<HarnessSession['messages']>, gen?: string): void { this.delta.preload(sessionId, messages, gen); }
  /** The conversation as held now, to keep for next time. */
  held(): ReturnType<SessionDeltaReceiver['current']> { return this.delta.current(); }
  /** `open` of `sessionId`, saying what is already held of it. */
  async resume(sessionId: string): Promise<{ sessionId?: string } | undefined> {
    const held = this.delta.claim(sessionId);
    const opened = await this.request<{ sessionId?: string; gen?: string } | undefined>({ ...remoteResume(sessionId), ...(held ? { held } : {}) });
    this.delta.generation(sessionId, opened?.gen);
    return opened;
  }
  private send(message: IdeHostRequest): void {
    if (this.stopped) throw new Error('Remote connection closed');
    if (this.tap) {
      if (message.type === 'chat') this.tap.post(message.request);
      return;
    }
    if (!this.child || this.child.stdin.destroyed) throw new Error('Remote connection closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  post(request: IdeRequest): void { this.send({ type: 'chat', chat: this.chat, request }); }
  request<T = unknown>(request: Answered): Promise<T> {
    const requestId = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${this.target} did not answer "${request.type}" within ${this.requestTimeoutMs / 1000}s`));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
    this.post({ ...request, requestId } as IdeRequest);
    return result as Promise<T>;
  }
  close(): void {
    if (this.stopped) return;
    this.closing = true;
    this.post({ type: 'close' });
    if (this.tap) {
      // The connection stays for the next chat: only this chat leaves it.
      this.tap.detach();
      this.stopped = true;
      return;
    }
    const child = this.child!;
    child.stdin.end();
    setTimeout(() => { if (!this.stopped) child.kill(); }, 3_000).unref();
  }
}

/** A sign-in's own question or choice, answered on its screen: what is typed
 * under the link, or the picker. Cancelled when the sign-in is (Esc). */
async function answerInSignIn(bridge: TerminalBridge, screen: SignInScreen, event: Extract<IdeEvent, { type: 'ui-request' }>): Promise<void> {
  const request = event.request;
  const cancelled = new Promise<undefined>((resolve) => {
    if (screen.signal.aborted) resolve(undefined);
    else screen.signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  let result: IdeUiResult;
  if (request.kind === 'input') {
    const text = await Promise.race([screen.ask(request.prompt, Boolean(request.secret)), cancelled]);
    result = text === undefined ? { cancelled: true } : { text };
  } else {
    const index = await Promise.race([screen.choose(request.title, request.items.map((item) => item.label)), cancelled]);
    result = index === undefined ? { cancelled: true } : { index };
  }
  bridge.post({ type: 'ui-response', id: event.id, result });
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

/** How long the first prompt waits for the machine's slash menu. */
const COMMANDS_WAIT_MS = 3_000;

/** The commands this terminal runs itself in a chat on another machine. */
const TERMINAL_HANDLED = ['machine', 'select', 'redraw', 'exit'];

/** A chat on another machine's slash menu: that machine's commands for the
 * chat (its bridge's `slash-commands`, what VS Code lists), as the terminal's
 * palette shows the local chat's -- and the ones this terminal runs itself
 * (/machine, and the terminal's own: /select, /redraw, /exit), should that
 * machine not list them. /resume is Left's (the board),
 * as in a chat here. */
export function remotePalette(commands: readonly IdeSlashCommand[]): PaletteEntry[] {
  const rows: PaletteEntry[] = commands
    .filter((item) => !BOARD_OWNS.has(item.command.replace(/^\//, '').toLowerCase()))
    .map((item) => {
      const values = item.argValues ? [...item.argValues] : undefined;
      return {
        label: item.command, value: item.command, detail: item.description,
        ...(item.argHint ? { argHint: item.argHint } : {}), ...(item.group ? { group: item.group } : {}),
        ...(item.aliases?.length ? { aliases: item.aliases } : {}), ...(values?.length ? { argValues: () => values } : {}),
      };
    });
  for (const name of TERMINAL_HANDLED) {
    const entry = resolveSlashCommand(name);
    if (!entry || rows.some((row) => row.value === `/${name}`)) continue;
    rows.push({ label: `/${name}`, value: `/${name}`, detail: entry.description, group: entry.group, ...(entry.argHint ? { argHint: entry.argHint } : {}) });
  }
  return rows;
}

/** What a chat on a machine with another ClikCode build says on opening:
 * that it is being brought to this build, or how to update it. */
export function outdatedNotice(machine: Pick<RemoteMachine, 'name' | 'updates' | 'updateError'>, updating: boolean, localCommit = localBuildCommit()): string {
  const differs = `${machine.name} runs another ClikCode build than this one`;
  if (updating) return `${differs}: updating it to this one's${localCommit ? ` (${localCommit.slice(0, 8)})` : ''} in the background; its chats switch over once they are quiet.`;
  const how = 'Type /update to update it, or Tab on it in /machine.';
  if (machine.updateError && updatePolicy(machine) === 'auto') return `${differs}, and updating it failed (${machine.updateError}). ${how}`;
  return `${differs}. ${how}`;
}

/** Returns the local chat to resume, or opens another selected remote chat.
 *
 * A bridge there that leaves for a newer ClikCode build (it does so only while
 * the chat is quiet, ide/bridge-retire.ts) is connected to again at once and
 * the same chat resumed, with nothing said: what was being typed stays in the
 * composer (prompt-input.ts keeps an interrupted prompt's draft). Any other
 * close of a connection that had been working is a drop, as in VS Code: said
 * with its cause, then connected to again and the same chat resumed, the line
 * that was in flight back in the composer. The window's connection to the
 * machine retries on its own schedule (connection.ts) and the chat waits for it
 * (REACH_MS); only an ssh of its own (`start` named) has pauses of its own,
 * REJOIN_PAUSES_MS. A chat that cannot be opened at all is RemoteUnavailable. */
/** How a chat on another machine was left: a local chat to show (its id),
 * nothing (back to the one it was opened from), or the window closing (/exit). */
export type RemoteChatEnd = string | { exit: true } | undefined;

/** The pauses before each reconnect after a drop (the board's, connection.ts, is the same shape). */
export const REJOIN_PAUSES_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/** How long opening a chat waits for the window's connection to its machine. */
const REACH_MS = 20_000;

/** A chat on another machine could not be opened: it never showed. Said with its reason, and the list it was picked from comes back
 * (loop.ts) -- not another chat in its place. */
export class RemoteUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'RemoteUnavailable'; }
}

export async function runRemoteChat(
  terminal: TerminalHarnessPrompter, localId: string, first: RemoteChatSelection, firstDraft?: string,
  startBridge?: RemoteBridgeStarter,
  pauses: readonly number[] = REJOIN_PAUSES_MS,
  reachMs = REACH_MS,
): Promise<RemoteChatEnd> {
  let choice: RemoteChatSelection | undefined = first;
  let draft = firstDraft;
  /** Connecting again after the bridge there retired: the opening notices were said already. */
  let rejoining = false;
  /** Reconnects since the last time the chat was working. */
  let drops = 0;
  while (choice) {
    const machine = (await readMachines()).find((item) => item.id === choice!.machineId && item.ready);
    if (!machine) throw new Error('That remote machine is no longer added. Add it again with /machine.');
    terminal.remoteMachineName = machine.name;
    // The window's connection to the machine is the one that knows whether it can be reached, and it retries on its own schedule: a
    // chat asks it, and says so if that takes a moment, instead of starting an ssh of its own at a machine that may be down.
    if (!startBridge) {
      const saying = setTimeout(() => terminal.activity(`Connecting to ${machine.name}…`), 700);
      const reached = await reachWindowMachine(machine.id, reachMs).finally(() => clearTimeout(saying));
      if (!reached.ok) { terminal.remoteMachineName = undefined; throw new RemoteUnavailable(`${machine.name} cannot be reached: ${reached.reason}`); }
    }
    // On the window's connection to the machine when it has one (no ssh, no process started there); else over an ssh of its own.
    const bridge = new TerminalBridge(machine.sshTarget, startBridge, undefined, startBridge ? undefined : (chat, handlers) => tapWindowMachine(machine.id, chat, handlers));
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
    /** A message drawn the moment Enter sent it, as a chat here draws one
     * (turnStarting), whose turn has not started there yet. */
    let early: string | undefined;
    /** It never became a turn (stopped first, refused, a steer, a lost
     * connection): off the screen again; what goes back to the composer
     * came with the bridge's restore-draft. */
    /** Notices that came while a message drawn early had not begun: shown once
     * its wait ends (or the turn begins), not drawn into a wait that is then taken
     * down -- which wiped why the message failed. */
    let held: string[] = [];
    const flushHeld = (): void => { const notes = held; held = []; for (const note of notes) terminal.activity(note); };
    const dropEarly = (): void => {
      if (early === undefined) return;
      early = undefined;
      terminal.submitted(undefined);
      if (!running && terminal.turn) terminal.stopWaiting();
      flushHeld();
    };
    /** The running turn as far as it has got (applyLiveEvent). */
    const liveTurn = newLiveTurnState();
    /** Approvals and questions this window has open, closed by `request-closed`. */
    const openPrompts = new Map<string, AbortController>();
    const completions = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
    const promptController = new AbortController();
    const signIns = new Map<string, SignInScreen>();
    /** Sign-ins with a question of the vendor's own open on their screen: the card's key row waits for it. */
    const vendorAsking = new Set<string>();
    /** Its slash menu, filled in place as the machine answers (remotePalette). */
    const commands: PaletteEntry[] = [];
    /** What the menu was last read for: a session that changes it is read again. */
    let commandsFor: string | undefined;
    const refreshCommands = (): Promise<void> => bridge.request<IdeSlashCommand[]>({ type: 'query', query: 'slash-commands' }).then(
      (list) => { commands.splice(0, commands.length, ...remotePalette(Array.isArray(list) ? list : [])); },
      // fail-open-ok: the machine did not list its commands now; the menu keeps what it had (or /machine alone).
      () => { if (!commands.length) commands.push(...remotePalette([])); },
    );
    /** The conversation as held, kept for the next open of this chat (chat-cache.ts). */
    const keeper = new ChatKeeper(() => machine.id, () => bridge.held());
    const sessionChanged = (next: HarnessSession): void => {
      const key = [next.id, next.route, next.nativeHarness, next.provider, next.model, next.accountId, next.effort, next.permissionMode, next.gatewayAgentId].join('|');
      if (commandsFor !== undefined && key !== commandsFor) void refreshCommands();
      commandsFor = key;
    };
    /** Messages typed while the turn runs, sent and not yet answered: the worker says what became of each (`submission`) -- steered
     * into the turn, queued behind it, or a command of ClikCode's own -- and the row says that, not what was hoped. A row that
     * claimed "queued" for a message that was steered showed it twice: the host recorded the steer, this window kept its own row. */
    const submissions = new Map<string, { text: string; resolve: (answer: Extract<WorkerEvent, { type: 'submission' }>) => void; reject: (error: Error) => void }>();
    const queued = async (text: string, windowId?: string): Promise<LiveTurnInputResult> => {
      // The id the window gave the message, so its row and the machine's record of it are one thing.
      const id = windowId ?? randomUUID();
      const submission = { id, text, submittedAt: new Date().toISOString() };
      const answered = new Promise<Extract<WorkerEvent, { type: 'submission' }>>((resolve, reject) => { submissions.set(id, { text, resolve, reject }); });
      try {
        bridge.post({ type: 'send', text, id });
        const answer = await answered;
        if (answer.disposition === 'error') throw new Error(answer.message ?? 'message not sent');
        return { disposition: answer.disposition, submission, ...(answer.commandOutcome ? { commandOutcome: answer.commandOutcome } : {}) };
      } finally { submissions.delete(id); }
    };
    /** `label`: what the worker says the turn is doing. A turn that is the vendor's own background work
     * (live.vendorWork) is not the model thinking, and said so: this window joining it must not draw it as
     * "thinking" with a clock that runs for as long as the vendor holds the work. */
    const beginWaiting = (prompt?: string, label = 'thinking'): void => {
      if (waitingInput) return;
      waitingInput = true;
      turnEnd = new Promise<void>((resolve) => { finishTurn = resolve; });
      if (prompt !== undefined) terminal.submitted(prompt);
      terminal.startWaiting(label, (restoreDraft) => bridge.post({ type: 'cancel', restoreDraft }),
        queued, queued, () => { leftTurn = true; waitingInput = false; finishTurn?.(); terminal.stopWaiting(); });
    };
    bridge.onEvent = (event) => {
      switch (event.type) {
        // While a message drawn early waits for its turn, the chat is drawn as a turn's (run-turn.ts renders so too).
        case 'session': session = event.session; account = event.account; sessionChanged(session); keeper.soon(); terminal.render(session, account, { running: running || early !== undefined }); return;
        case 'turn-start':
          // A message typed as the last turn ended finds no turn to steer into: it became this one. Nothing will answer it as a steer.
          for (const [id, pending] of submissions) {
            if (pending.text === event.prompt) pending.resolve({ type: 'submission', id, disposition: 'queued' });
          }
          applyLiveEvent(liveTurn, { type: 'waiting-start', message: '', ...(event.prompt !== undefined ? { prompt: event.prompt } : {}) });
          // The message drawn on Enter: this turn carries it on (startWaiting takes over turnStarting's).
          early = undefined;
          running = true;
          beginWaiting(event.prompt);
          flushHeld();
          return;
        case 'worker': {
          const worker = event.event;
          // The turn as far as it has got, kept from the worker's events as the local follower keeps it (worker/joined-turn.ts).
          applyLiveEvent(liveTurn, worker);
          if (worker.type === 'snapshot') {
            session = worker.session; account = worker.account;
            sessionChanged(session);
            running = Boolean(worker.live);
            if (worker.stopped) terminal.turnStopped();
            terminal.render(session, account, worker.live ? { running: true, prompt: worker.live.prompt } : { running: early !== undefined });
            if (worker.live) {
              beginWaiting(worker.live.prompt, worker.live.vendorWork ? worker.live.waitingLabel : undefined);
              // Joining or coming back to a turn that is running: its real start, so the timer does not begin again, and everything
              // it has done so far -- its tool calls and sub-agents, plan, thoughts, usage -- not just the words.
              const startedAt = Date.parse(worker.session.pendingTurn?.startedAt ?? '');
              terminal.joinedWaiting(Number.isNaN(startedAt) ? undefined : startedAt);
              drawJoinedTurn(terminal, liveTurn);
              terminal.setBackgroundWork?.(worker.background ?? backgroundWorkOf(worker.live));
              terminal.setSteerable(Boolean(worker.live.steerable));
            }
          }
          else if (worker.type === 'delta') terminal.response(worker.text, worker.mode);
          else if (worker.type === 'activity') {
            // Numbered as the state (updated first) recorded it, so a snapshot that lists it again is not a second row.
            const index = liveTurn.running && isTranscriptActivity(worker.event) ? liveTurn.activities.length - 1 : -1;
            const recorded = liveTurn.activities[index];
            terminal.activityEvent(worker.event, recorded ? { index, responseOffset: recorded.responseOffset } : undefined);
          }
          else if (worker.type === 'background') terminal.setBackgroundWork?.(backgroundWorkOf({ background: worker.work, pendingBackground: worker.pending }));
          else if (worker.type === 'note') terminal.activity(worker.message, worker.seq === undefined ? undefined : `notice:${worker.seq}`);
          else if (worker.type === 'phase') terminal.phase(worker.message);
          else if (worker.type === 'plan') terminal.setPlan(worker.entries);
          else if (worker.type === 'usage') terminal.setTurnUsage(worker.usage);
          else if (worker.type === 'restore-draft') terminal.restoreDraft(worker.text);
          else if (worker.type === 'waiting-stop') { if (worker.stopped) terminal.turnStopped(); running = false; waitingInput = false; terminal.stopWaiting(); finishTurn?.(); }
          else if (worker.type === 'turn-error') lastError = new Error(worker.message);
          else if (worker.type === 'approval-request') {
            const closing = new AbortController();
            openPrompts.set(worker.id, closing);
            void terminal.approval(worker.title, worker.detail, worker.preview, worker.rule, closing.signal, worker.callId).then((approved) => {
              openPrompts.delete(worker.id);
              // Decided here: the row is drawn by this window, not again from a snapshot.
              if (!closing.signal.aborted) { terminal.markDrawn?.(`outcome:${worker.id}`); bridge.post({ type: 'approval-response', id: worker.id, approved }); }
            });
          } else if (worker.type === 'question-request') {
            const closing = new AbortController();
            openPrompts.set(worker.id, closing);
            void terminal.askQuestions(worker.request, closing.signal).catch((): HarnessQuestionResult => ({ kind: 'cancelled' })).then((result) => {
              openPrompts.delete(worker.id);
              if (!closing.signal.aborted) { terminal.markDrawn?.(`outcome:${worker.id}`); bridge.post({ type: 'question-response', id: worker.id, result }); }
            });
          } else if (worker.type === 'request-closed') {
            // Answered in another window, withdrawn by the vendor, or the turn ended. Still open here means this window did not answer
            // it: it draws the decision as the one that did, where the worker placed it.
            if (openPrompts.has(worker.id)) {
              const decided = recordDecision(liveTurn, worker);
              if (decided) terminal.joinMark(decided);
            }
            openPrompts.get(worker.id)?.abort();
            openPrompts.delete(worker.id);
          }
          else if (worker.type === 'submission') submissions.get(worker.id)?.resolve(worker);
          else if (worker.type === 'steerable') terminal.setSteerable(worker.value);
          else if (worker.type === 'stopping') terminal.turnStopping(worker.restoreDraft === true);
          else if (worker.type === 'stop-done') terminal.stopSettled();
          return;
        }
        case 'ui-request': {
          // A question or a choice of an open sign-in's (Claude's "Paste code here if
          // prompted", a login menu): asked on that sign-in's screen, under its link. Asked
          // as a prompt of its own it ended the wait the link is drawn in, and only the
          // question was left on screen.
          const open = [...signIns].at(-1);
          if (open) {
            const [id, screen] = open;
            if (event.request.kind === 'input') vendorAsking.add(id);
            void answerInSignIn(bridge, screen, event).finally(() => vendorAsking.delete(id));
            return;
          }
          if (!running && terminal.turn) terminal.stopWaiting(false);
          void answerUi(bridge, terminal, event).catch((error: unknown) => {
            terminal.activity(error instanceof Error ? error.message : String(error));
            bridge.post({ type: 'ui-response', id: event.id, result: { cancelled: true } });
          });
          return;
        }
        case 'sign-in': void runSignIn(machine.sshTarget, event.spec, terminal).then(
          () => bridge.post({ type: 'sign-in-result', id: event.id }),
          (error: unknown) => bridge.post({ type: 'sign-in-result', id: event.id, error: error instanceof Error ? error.message : String(error) }),
        ); return;
        case 'sign-in-link': {
          let screen = signIns.get(event.id);
          if (event.done) { screen?.stop(); signIns.delete(event.id); vendorAsking.delete(event.id); return; }
          if (!screen) {
            screen = terminal.signInScreen(event.name);
            signIns.set(event.id, screen);
            screen.signal.addEventListener('abort', () => bridge.post({ type: 'sign-in-cancel', id: event.id }), { once: true });
          }
          if (event.url) screen.show({ url: event.url, ...(event.code ? { code: event.code } : {}) });
          // The key row beside the link, unless the vendor's own question has the field now.
          if (event.ask && !vendorAsking.has(event.id)) void screen.ask(event.ask.prompt, Boolean(event.ask.secret), false, true).then((text) => bridge.post({ type: 'sign-in-answer', id: event.id, text }));
          return;
        }
        case 'usage': terminal.usage(event.label, event.reset); return;
        case 'notice':
          if (early !== undefined && !running) { held.push(event.message); return; }
          terminal.activity(event.message);
          return;
        case 'panel': terminal.panel(event.title, event.body); return;
        case 'restore-draft': terminal.restoreDraft(event.text); return;
        case 'send-complete': if (completions.has(event.id)) dropEarly(); completions.get(event.id)?.resolve(); completions.delete(event.id); return;
        // Its last lines (an /update's steps) are drawn before the wait ends.
        // Before a message drawn early starts (a local model loading there): the same wait, relabelled.
        case 'busy':
          if (early !== undefined) { if (event.label) terminal.updateWaitingLabel(event.label); return; }
          if (event.label) terminal.startWaiting(event.label); else if (!running) { terminal.flushPaint(); terminal.stopWaiting(); }
          return;
        case 'closed': terminal.activity('This conversation closed on the remote machine.'); return;
      }
    };
    bridge.onClose = (error) => {
      dropEarly();
      promptController.abort();
      finishTurn?.();
      for (const completion of completions.values()) completion.reject(error);
      completions.clear();
      for (const pending of submissions.values()) pending.reject(error);
      submissions.clear();
    };
    try {
      await bridge.connected();
      const selection: RemoteChatSelection = choice;
      // Intent only: the chat is in one of the remote's own folders (session/attach.ts).
      const kept = selection.chatId ? await readChatCache(machine.id, selection.chatId) : undefined;
      if (kept && selection.chatId) bridge.preload(selection.chatId, kept.messages, kept.gen);
      // Nothing is painted until the open is in: the history, then the turn that is running (its calls, sub-agents, timer) arrive a
      // moment apart, and each paint of one moved the rows already there -- the jump on entering a chat. Held, it paints once, whole.
      terminal.holdPaints();
      let opened: { sessionId?: string } | undefined;
      try {
        opened = await (selection.chatId ? bridge.resume(selection.chatId) : bridge.request<{ sessionId?: string } | undefined>({ type: 'open', mode: 'new', features: REMOTE_FEATURES }));
      } finally { terminal.releasePaints(); }
      // A new chat there is that chat from here on: a rejoin resumes it.
      if (!selection.chatId && opened?.sessionId) choice = { ...selection, chatId: opened.sessionId };
      // After the open, whose chat clears the rows before it. Updated from here only by the
      // machine's own policy (remote/updates.ts): a production machine set to ask is
      // updated when the user says so.
      if (bridge.outdated && !rejoining) {
        const started = await autoUpdates.consider(machine).catch(quiet('remote/terminal-chat'));
        terminal.activity(outdatedNotice(machine, Boolean(started)));
        void started?.done.then((outcome) => {
          // The window's connection there (the board's) goes to the new build.
          if (outcome.ok) reconnectWindowMachine(machine.id);
          terminal.activity(outcome.ok
            ? `ClikCode on ${machine.name} is updated${outcome.info.commit ? ` to ${outcome.info.commit.slice(0, 8)}` : ''}; its chats switch over once they are quiet.`
            // What to do first: the reason (a path, a command's output) can be longer than the row.
            : `ClikCode on ${machine.name} could not be updated -- type /update to try again: ${outcome.message}`);
        }, () => undefined);
      }
      // A chat that moved on from there: the live one, where it went (move-terminal.ts liveChat).
      if (!rejoining && session?.movedTo) {
        const copy = session;
        const live = await liveChat(copy.movedTo!, async () => {
          if (bridge.revision < RECLAIM_REVISION) throw new Error(`This chat moved to ${copy.movedTo!.machine}, which does not answer, and ClikCode on ${machine.name} is too old to go on with it: update it (Tab on it in /machine).`);
          await bridge.request({ type: 'reclaim-moved', sessionId: copy.id });
          return { remote: { machineId: machine.id, chatId: copy.id } };
        });
        if (live.notice) terminal.activity(live.notice);
        if ('local' in live.here) return live.here.local;
        if (live.here.remote.machineId !== machine.id || live.here.remote.chatId !== copy.id) { choice = live.here.remote; continue; }
      }
      // Its slash menu, before the first prompt: typing `/` shows it at once.
      // A machine slow to list it does not hold the prompt back for long.
      await Promise.race([refreshCommands(), new Promise<void>((resolve) => { setTimeout(resolve, COMMANDS_WAIT_MS).unref?.(); })]);
      if (draft) terminal.restoreDraft(draft);
      draft = undefined;
      rejoining = false;
      drops = 0;
      let setupSession: string | undefined;
      const prepareBoardDraft = async (): Promise<void> => {
        if (setupSession && setupSession === session?.id && !chatHasContent(session)) return;
        const opened = await bridge.request<{ sessionId?: string } | undefined>({ type: 'open', mode: 'new', ...(session?.workspace ? { workspace: session.workspace } : {}), features: REMOTE_FEATURES });
        setupSession = opened?.sessionId ?? session?.id;
        if (setupSession) choice = { machineId: machine.id, chatId: setupSession };
        await refreshCommands();
      };
      for (;;) {
        if (waitingInput) await turnEnd;
        let line = leftTurn ? BOARD_LINE : (await terminal.question('› ', commands, { rightArrowPalette: true, leftArrowCommand: BOARD_LINE, signal: promptController.signal })).trim();
        leftTurn = false;
        if (line === BOARD_LINE) {
          // The list is this machine's, wherever the chat is: it holds every machine's chats.
          const picked: Awaited<ReturnType<typeof interactiveSessionPicker>> = await interactiveSessionPicker(terminal, localId, commands, choice?.chatId ? { initial: remoteRowValue(machine.id, choice.chatId) } : undefined);
          if (!picked) continue;
          if ('remote' in picked) { choice = picked.remote; draft = picked.draft; break; }
          if ('id' in picked) return picked.id;
          if ('compose' in picked) { await prepareBoardDraft(); terminal.restoreDraft(picked.compose); continue; }
          if ('command' in picked) { await prepareBoardDraft(); line = picked.command; }
          else { if ('new' in picked) await prepareBoardDraft(); continue; }
        }
        if (!line) continue;
        // The terminal's own commands are this terminal's, wherever the chat is:
        // they are not sent to the other machine (whose answer was "/exit is for
        // the terminal"). /exit closes this window; /redraw draws the chat again;
        // /select hands this terminal's mouse back.
        const own = resolveSlashCommand(parseSlashInput(line)?.head ?? '')?.name;
        if (own && TERMINAL_ONLY_COMMANDS.has(own)) {
          if (own === 'exit') return { exit: true };
          if (own === 'redraw' && session) { terminal.render(session, account); continue; }
          const { aiSessionCommand } = await import('../tui/slash/handlers.js');
          await aiSessionCommand(localId, line).catch((error: unknown) => terminal.activity(error instanceof Error ? error.message : String(error)));
          continue;
        }
        // /machine: this chat moves to another machine (move-terminal.ts), from the one it is on.
        if (parseSlashInput(line)?.head === 'machine') {
          const next: Here | undefined = await moveTerminalChat(terminal, { remote: choice }, session?.id ?? choice.chatId ?? '', Boolean(session && chatHasContent(session)),
            remoteMoveEnd(bridge, machine), startBridge).catch((error: unknown) => { terminal.activity(error instanceof Error ? error.message : String(error)); return undefined; });
          if (!next) continue;
          if ('local' in next) return next.local;
          choice = next.remote;
          break;
        }
        const id = randomUUID();
        if (!/^[/!]/.test(line)) setupSession = undefined;
        const complete = new Promise<void>((resolve, reject) => completions.set(id, { resolve, reject }));
        sending = line;
        // A message (not a command) is drawn now, with the turn's wait, as a
        // chat here draws one: the machine's answer is a round trip away.
        if (!/^[/!]/.test(line)) { early = line; terminal.submitted(line); terminal.turnStarting(); }
        try { bridge.post({ type: 'send', text: pinnedUpdateLine(line, localBuildCommit()), id }); } catch (error) { dropEarly(); throw error; }
        await complete;
        sending = undefined;
        // /update ran there: the window's connection there (the board's) goes to the build it installed.
        if (parseSlashInput(line)?.head === 'update') reconnectWindowMachine(machine.id);
        if (lastError) { terminal.activity(lastError.message); lastError = undefined; }
        // A command may have changed what is offered (an account, a provider, a custom command, an /update).
        if (line.startsWith('/')) await refreshCommands();
      }
    } catch (error) {
      const cause = bridge.dropped;
      const lost = !bridge.retiring && cause !== undefined && (bridge.wasReady || rejoining);
      // Never showed: the list it was picked from comes back with why, not another chat.
      if (!bridge.retiring && !lost) throw bridge.wasReady || rejoining ? error : new RemoteUnavailable(`${machine.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      if (lost) {
        if (startBridge) {
          // An ssh of its own (no window connection to retry for it): its own pauses.
          if (drops >= pauses.length) throw cause;
          terminal.activity(chalk.yellow(`Connection to ${machine.name} lost: ${cause.message}\nReconnecting${drops ? ` (try ${drops + 1} of ${pauses.length + 1})` : ''}.`));
          await new Promise<void>((resolve) => { setTimeout(resolve, pauses[drops]).unref?.(); });
          drops += 1;
        } else {
          // The window's connection retries on its own schedule; the next pass waits for it (reach) and gives up if it stays down.
          terminal.activity(chalk.yellow(`Connection to ${machine.name} lost: ${cause.message}\nReconnecting.`));
        }
      }
      rejoining = true;
      // A newer build there: the window's connection to it goes to that build too.
      reconnectWindowMachine(machine.id);
      // Whatever was sent as it left may never have run: back in the composer,
      // for Enter on the new connection.
      if (sending !== undefined) draft = sending;
      continue;
    } finally { keeper.now(); promptController.abort(); for (const screen of signIns.values()) screen.stop(); bridge.close(); terminal.remoteMachineName = undefined; }
  }
  return undefined;
}
