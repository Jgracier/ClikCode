/** /machine in the terminal: the machine is one of the chat's settings, and
 * choosing another moves the chat there (session/move.ts) -- from a chat on
 * this machine (the interactive loop) or on another one (terminal-chat.ts).
 * A chat nothing was said in has nothing to move: it is a new chat there.
 *
 * The machines listed are this one and the ones added in /remote; one that
 * does not answer is listed as offline and moves nothing. */
import Conf from 'conf';
import type { HarnessPrompter, PickerOption } from '../harness/prompter.js';
import type { ChatMovedTo } from '../session/model.js';
import { moveChat, movedChatMachine, type MoveEnd, type MoveRequest } from '../session/move-chat.js';
import { readState } from '../session/state/read.js';
import { chooseOption } from '../tui/pickers/choose.js';
import { localMachineName } from './board-rows.js';
import { RemoteMachines } from './connection.js';
import { readMachines, type RemoteMachine } from './machines.js';
import { TerminalBridge, type RemoteBridgeStarter, type RemoteChatSelection } from './terminal-chat.js';

/** The bridge revision that answers export-chat, import-chat and mark-moved. */
const MOVE_REVISION = 4;
/** How long the list waits to learn which machines answer. */
const STATE_WAIT_MS = 4_000;

/** Where the chat is now, as the move sees it. */
export type Here = { local: string } | { remote: RemoteChatSelection };

/** This machine's ClikCode, asked in this process. */
export function localMoveEnd(): MoveEnd {
  let config: Conf | undefined;
  return {
    name: localMachineName(),
    call: async <T>(request: MoveRequest): Promise<T> => {
      config ??= new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
      const { answerMoveRequest } = await import('../session/move.js');
      return await answerMoveRequest(config, request) as T;
    },
  };
}

/** A machine's ClikCode, over the chat channel `bridge` holds to it. */
export function remoteMoveEnd(bridge: TerminalBridge, machine: Pick<RemoteMachine, 'name'>): MoveEnd {
  return {
    name: machine.name,
    call: async <T>(request: MoveRequest): Promise<T> => {
      if (bridge.revision < MOVE_REVISION) throw new Error(`ClikCode on ${machine.name} is too old to move chats: update it (/update in one of its chats, or /remote).`);
      return bridge.request<T>(request);
    },
  };
}

/** The machines to choose from, with whether each answers now. */
async function machineRows(current: string): Promise<Array<PickerOption<string> & { offline?: string }>> {
  const machines = (await readMachines()).filter((machine) => machine.ready);
  const states = new Map<string, string | undefined>();
  if (machines.length) {
    const links = await new RemoteMachines({ autoUpdate: false }).open();
    const settled = (): boolean => links.views().every((view) => view.state !== 'connecting');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STATE_WAIT_MS);
      timer.unref?.();
      const check = (): void => { if (settled()) { clearTimeout(timer); resolve(); } };
      links.onChange(check);
      check();
    });
    for (const view of links.views()) states.set(view.machine.id, view.state === 'connected' ? undefined : view.state === 'offline' ? 'offline' : 'not answering');
    void links.close();
  }
  return [
    { label: localMachineName(), detail: current === 'local' ? '· this chat is here' : '· this machine', value: 'local' },
    ...machines.map((machine) => {
      const offline = states.get(machine.id);
      return {
        label: machine.name,
        detail: `· ${[current === machine.id ? 'this chat is here' : undefined, offline].filter(Boolean).join(' · ') || 'connected'}`,
        value: machine.id, ...(offline ? { offline } : {}),
      };
    }),
  ];
}

/** Which machine to move to; undefined when it stays (Esc, its own machine, an offline one). */
async function pickMachine(prompter: HarnessPrompter, current: string): Promise<{ id: string; machine?: RemoteMachine } | undefined> {
  const rows = await machineRows(current);
  const picked = await chooseOption(prompter, 'Move this chat to', rows);
  if (!picked || picked === current) return undefined;
  const row = rows.find((item) => item.value === picked);
  if (row?.offline) throw new Error(`${row.label} is ${row.offline}: the chat stays here.`);
  if (picked === 'local') return { id: 'local' };
  const machine = (await readMachines()).find((item) => item.id === picked && item.ready);
  if (!machine) throw new Error('That machine is no longer added.');
  return { id: picked, machine };
}

/** Yes only when the user says so: the move would change something. */
async function confirm(prompter: HarnessPrompter, text: string): Promise<boolean> {
  return await chooseOption(prompter, text, [{ label: 'Move', value: true }, { label: 'Cancel', value: false }]) === true;
}

/** After a move: what the chat says where it is now. */
function movedNotice(target: string, folder: string): string {
  return `Moved to ${target} · ${folder}`;
}

/** /machine. `here` is where the chat is, `source` its machine's end and
 * `hasContent` whether there is anything to move. Resolves where it is next
 * (undefined: it stayed). */
export async function moveTerminalChat(
  prompter: HarnessPrompter, here: Here, sessionId: string, hasContent: boolean, source: MoveEnd,
  startBridge?: RemoteBridgeStarter,
): Promise<Here | undefined> {
  const current = 'local' in here ? 'local' : here.remote.machineId;
  const choice = await pickMachine(prompter, current);
  if (!choice) return undefined;
  if (!hasContent) {
    // Nothing to move: a new chat there.
    if (choice.machine) return { remote: { machineId: choice.machine.id } };
    const { newConversation } = await import('../commands/ai/conversations.js');
    return { local: await newConversation(sessionId) };
  }
  if (!choice.machine) {
    const outcome = await moveChat(source, localMoveEnd(), sessionId, (text) => confirm(prompter, text));
    if (!outcome.moved) return undefined;
    prompter.activity?.(movedNotice(localMachineName(), outcome.folder));
    return { local: outcome.sessionId };
  }
  const bridge = new TerminalBridge(choice.machine.sshTarget, startBridge);
  try {
    await bridge.connected();
    const outcome = await moveChat(source, remoteMoveEnd(bridge, choice.machine), sessionId, (text) => confirm(prompter, text));
    if (!outcome.moved) return undefined;
    return { remote: { machineId: choice.machine.id, chatId: outcome.sessionId, notice: movedNotice(choice.machine.name, outcome.folder) } };
  } finally { bridge.close(); }
}

/** The machine a moved chat went to, as this machine knows it: itself, an
 * added machine (by installation id, else by name), or none it can reach. */
export async function movedChatPlace(movedTo: ChatMovedTo): Promise<Here | undefined> {
  const state = await readState({ transcripts: [] });
  const machine = movedChatMachine(movedTo, await readMachines(), { name: localMachineName(), installationId: state.installationId });
  if (!machine) return undefined;
  return machine === 'local' ? { local: movedTo.sessionId } : { remote: { machineId: machine, chatId: movedTo.sessionId } };
}

/** A chat that moved, opened here: offered where it went. Undefined to stay
 * (it is read-only here). */
export async function offerMovedChat(prompter: HarnessPrompter, movedTo: ChatMovedTo): Promise<Here | undefined> {
  const place = await movedChatPlace(movedTo);
  if (!place) {
    prompter.activity?.(`This chat moved to ${movedTo.machine}, which is not added here: add it in /remote to go on there.`);
    return undefined;
  }
  const go = await chooseOption(prompter, `This chat moved to ${movedTo.machine}.`, [
    { label: `Open it on ${movedTo.machine}`, value: true }, { label: 'Stay here (read-only)', value: false },
  ]);
  return go ? place : undefined;
}
