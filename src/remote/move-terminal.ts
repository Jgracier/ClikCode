/** /machine in the terminal: the machine is one of the chat's settings, and
 * choosing another moves the chat there (session/move.ts) -- from a chat on
 * this machine (the interactive loop) or on another one (terminal-chat.ts).
 * A chat nothing was said in has nothing to move: it is a new chat there.
 *
 * The machines listed are this one, the ones added, and the
 * user's own Tailscale knows of and not added yet (tailscale.ts); one that
 * does not answer is listed as offline and moves nothing. Choosing one from
 * the tailnet adds it first: which user to log in as, then
 * the install. */
import Conf from 'conf';
import type { HarnessPrompter, PickerOption } from '../harness/prompter.js';
import type { ChatMovedTo } from '../session/model.js';
import { moveChat, movedChatMachine, type MoveEnd, type MoveRequest } from '../session/move-chat.js';
import { readState } from '../session/state/read.js';
import { IDE_PROTOCOL } from '../ide/protocol-version.js';
import { chooseOption } from '../tui/pickers/choose.js';
import { localMachineName } from './board-rows.js';
import { holdWindowMachines, type LinkChannel, type MachinesHold } from './connection.js';
import { readMachines, type RemoteMachine } from './machines.js';
import { discoverMachines, notYetAdded, readTailscaleStatus, type DiscoveredMachine } from './tailscale.js';
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
    revision: IDE_PROTOCOL.revision,
    call: async <T>(request: MoveRequest): Promise<T> => {
      config ??= new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
      const { answerMoveRequest } = await import('../session/move.js');
      return await answerMoveRequest(config, request) as T;
    },
  };
}

/** A machine's ClikCode, over a chat channel to it: the one a chat there
 * holds (`TerminalBridge`), or one on the board's connection (`LinkChannel`). */
export function remoteMoveEnd(bridge: Pick<TerminalBridge, 'revision' | 'request'>, machine: Pick<RemoteMachine, 'name'>): MoveEnd {
  return {
    name: machine.name,
    get revision() { return bridge.revision; },
    call: async <T>(request: MoveRequest): Promise<T> => {
      if (bridge.revision < MOVE_REVISION) throw new Error(`ClikCode on ${machine.name} is too old to move chats: update it (/update in one of its chats, or Tab on it in /machine).`);
      return bridge.request<T>(request);
    },
  };
}

/** The machines to choose from. The list opens at once: a machine still
 * connecting says so, and its row is redrawn as it answers (or after
 * STATE_WAIT_MS, as not answering). Picking one still connecting waits for it. */
function machineList(
  current: string, machines: readonly RemoteMachine[], links: MachinesHold | undefined, tailnet: Tailnet,
  actionsOf: (machine: RemoteMachine) => Array<{ label: string; value: string }>,
): {
  rows: () => Array<PickerOption<string> & { offline?: string }>; refresh: Promise<unknown>[];
} {
  const started = Date.now();
  const stateOf = (id: string): string | undefined => {
    const view = links?.views().find((item) => item.machine.id === id);
    if (!view || view.state === 'connected') return view?.updating ? 'updating ClikCode…' : view?.needsUpdate ? 'needs update (tab)' : undefined;
    if (view.state === 'offline') return 'offline';
    return Date.now() - started < STATE_WAIT_MS ? 'connecting' : 'not answering';
  };
  const rows = (): Array<PickerOption<string> & { offline?: string }> => [
    { label: localMachineName(), detail: current === 'local' ? '· this chat is here' : '· this machine', value: 'local' },
    ...machines.map((machine) => {
      // Not finished installing: choosing it finishes, then the chat goes there.
      const state = machine.ready ? stateOf(machine.id) : 'install not finished';
      const offline = state === 'offline' || state === 'not answering' ? state : undefined;
      return {
        label: machine.name,
        detail: `· ${[current === machine.id ? 'this chat is here' : undefined, state].filter(Boolean).join(' · ') || 'connected'}`,
        value: machine.id, actions: actionsOf(machine), ...(offline ? { offline } : {}),
      };
    }),
    ...tailnet.found.map((machine) => {
      const offline = machine.os === 'windows' ? 'Windows, not supported yet' : machine.online ? undefined : 'offline';
      return {
        label: machine.name, detail: `· ${machine.os} · ${machine.os === 'windows' ? 'not supported yet' : offline ?? 'add: install ClikCode'}`,
        value: discoveredValue(machine), group: TAILNET, ...(offline ? { offline } : {}),
      };
    }),
    { label: 'Add by SSH address…', detail: '· user@host or a Host alias from ~/.ssh/config', value: ADDRESS, group: ELSEWHERE },
  ];
  // A redraw each time a machine answers, and one when the wait is over.
  const refresh = links ? [
    ...machines.map((machine) => new Promise<void>((resolve) => {
      const check = (): void => { if (links.views().find((view) => view.machine.id === machine.id)?.state !== 'connecting') resolve(); };
      links.onChange(check);
      check();
    })),
    new Promise<void>((resolve) => { setTimeout(resolve, STATE_WAIT_MS).unref?.(); }),
  ] : [];
  return { rows, refresh: [...refresh, tailnet.landed] };
}

const TAILNET = 'On your tailnet';
const ELSEWHERE = 'Somewhere else';
const ADDRESS = '__address__';
const discoveredValue = (machine: DiscoveredMachine): string => `tailscale:${machine.nodeId}`;

/** The user's machines Tailscale knows that are not added and ready (`added`):
 * one whose install did not finish is offered again, and adding it goes on
 * with it. `found` fills in when Tailscale answers; with no Tailscale here it
 * stays empty. */
export interface Tailnet { found: DiscoveredMachine[]; landed: Promise<void> }

export function readTailnet(added: readonly RemoteMachine[]): Tailnet {
  const tailnet: Tailnet = { found: [], landed: Promise.resolve() };
  tailnet.landed = readTailscaleStatus().then(({ status }) => {
    tailnet.found = status ? notYetAdded(discoverMachines(status), added) : [];
  }, () => undefined);
  return tailnet;
}

/** Which machine to move to; undefined when it stays (Esc, its own machine, an
 * offline one). The list is also where machines are kept: Tab on an added one
 * updates ClikCode there, switches how it is kept up to date, or removes it, and
 * the list opens again as it is now; a machine on the tailnet, one whose install
 * did not finish, or one added by SSH address is installed first. */
async function pickMachine(prompter: HarnessPrompter, current: string, links: MachinesHold | undefined): Promise<{ id: string; machine?: RemoteMachine } | undefined> {
  const { addByAddress, addDiscoveredMachine, machineAction, machineActions, remoteHostOf } = await import('../tui/pickers/remote.js');
  const host = remoteHostOf(prompter);
  for (;;) {
    const machines = await readMachines();
    const tailnet = readTailnet(machines);
    const list = machineList(current, machines, links, tailnet, machineActions);
    // Tailscale answers locally in milliseconds: its machines are in the list
    // as it opens, rather than a row appearing under the cursor.
    await Promise.race([tailnet.landed, new Promise((resolve) => { setTimeout(resolve, 1500).unref?.(); })]);
    let acted: { machine: RemoteMachine; action: string } | undefined;
    const picked = await chooseOption(prompter, 'Move this chat to', list.rows(), async (value, action) => {
      const machine = machines.find((item) => item.id === value);
      if (machine) acted = { machine, action };
    }, { startAt: current, refreshedOptions: list.rows, refresh: list.refresh });
    if (acted) {
      const { notice } = await machineAction(host, acted.machine, acted.action);
      if (notice) host.line(notice);
      continue;
    }
    if (!picked || picked === current) return undefined;
    const row = list.rows().find((item) => item.value === picked);
    if (row?.offline) throw new Error(`${row.label} is ${row.offline}: the chat stays here.`);
    if (picked === 'local') return { id: 'local' };
    const added = async (adding: Promise<{ id?: string; notice?: string }>): Promise<{ id: string; machine: RemoteMachine } | undefined> => {
      const done = await adding;
      if (!done.id) return undefined;
      const machine = (await readMachines()).find((item) => item.id === done.id && item.ready);
      if (!machine) return undefined;
      if (done.notice) host.line(done.notice);
      return { id: machine.id, machine };
    };
    if (picked === ADDRESS) {
      const typed = await host.ask('SSH address (user@host, host, or a Host alias)');
      if (!typed?.trim()) continue;
      return added(addByAddress(host, typed));
    }
    const found = tailnet.found.find((item) => discoveredValue(item) === picked);
    if (found) return added(addDiscoveredMachine(host, found));
    const machine = machines.find((item) => item.id === picked);
    if (!machine) throw new Error('That machine is no longer added.');
    if (!machine.ready) return added(machineAction(host, machine, 'install').then(() => ({ id: machine.id })));
    return { id: picked, machine };
  }
}

/** /machine. `here` is where the chat is, `source` its machine's end and
 * `hasContent` whether there is anything to move. Choosing a machine moves
 * the chat: nothing is asked and nothing said -- the chat opens there, and its
 * info line names the machine. The move goes over the window's connection to
 * that machine, the one the list shows it by. Resolves where it is next (undefined: it stayed). */
export async function moveTerminalChat(
  prompter: HarnessPrompter, here: Here, sessionId: string, hasContent: boolean, source: MoveEnd,
  startBridge?: RemoteBridgeStarter,
): Promise<Here | undefined> {
  const current = 'local' in here ? 'local' : here.remote.machineId;
  const links = (await readMachines()).some((machine) => machine.ready) ? await holdWindowMachines().catch(() => undefined) : undefined;
  let bridge: TerminalBridge | undefined;
  let channel: LinkChannel | undefined;
  try {
    const choice = await pickMachine(prompter, current, links);
    if (!choice) return undefined;
    if (!hasContent) {
      // Nothing to move: a new chat there.
      if (choice.machine) return { remote: { machineId: choice.machine.id } };
      const { newConversation } = await import('../commands/ai/conversations.js');
      return { local: await newConversation(sessionId) };
    }
    if (!choice.machine) return { local: (await moveChat(source, localMoveEnd(), sessionId)).sessionId };
    channel = await links?.channel(choice.machine.id).catch(() => undefined);
    if (!channel) {
      bridge = new TerminalBridge(choice.machine.sshTarget, startBridge);
      await bridge.connected();
    }
    const outcome = await moveChat(source, remoteMoveEnd(channel ?? bridge!, choice.machine), sessionId);
    return { remote: { machineId: choice.machine.id, chatId: outcome.sessionId } };
  } finally {
    channel?.close();
    bridge?.close();
    links?.release();
  }
}

/** The machine a moved chat went to, as this machine knows it: itself, an
 * added machine (by installation id, else by name), or none it can reach. */
export async function movedChatPlace(movedTo: ChatMovedTo): Promise<Here | undefined> {
  const state = await readState({ transcripts: [] });
  const machine = movedChatMachine(movedTo, await readMachines(), { name: localMachineName(), installationId: state.installationId });
  if (!machine) return undefined;
  return machine === 'local' ? { local: movedTo.sessionId } : { remote: { machineId: machine, chatId: movedTo.sessionId } };
}

/** How the terminal learns whether an added machine answers now. */
export type MachineReach = (machineId: string) => Promise<boolean>;

/** Over the window's connection to it (the board's): it answers once a chat
 * channel opens on it -- one still connecting is waited for. */
const windowReach: MachineReach = async (machineId) => {
  const links = await holdWindowMachines().catch(() => undefined);
  try {
    const channel = await links?.channel(machineId).catch(() => undefined);
    channel?.close();
    return Boolean(channel);
  } finally { links?.release(); }
};

/** Where a moved chat is live now. */
export interface LiveChat {
  here: Here;
  /** Said only when nothing could be reached and the copy opened goes on (`reclaim`). */
  notice?: string;
}

/** A chat is live in exactly one place, and every way of opening it opens
 * that one: a copy that moved (`movedTo`) is never shown -- the chat where it
 * went is, and nothing moves. On another machine: that machine's chat (when it
 * answers). On this one (it moved here under another id): that id, followed
 * on if it moved again. Only when the machine is not added here or does not
 * answer does the copy opened go on (`reclaim`, which says where it is then),
 * with one line saying so. */
export async function liveChat(movedTo: ChatMovedTo, reclaim: () => Promise<Here>, reach: MachineReach = windowReach): Promise<LiveChat> {
  const seen = new Set<string>();
  let next: ChatMovedTo = movedTo;
  let why = 'is not added here';
  for (;;) {
    const place = await movedChatPlace(next);
    if (!place) break;
    if ('remote' in place) {
      if (await reach(place.remote.machineId).catch(() => false)) return { here: place };
      why = 'does not answer';
      break;
    }
    if (seen.has(place.local)) break;
    seen.add(place.local);
    const session = (await readState({ transcripts: [] })).sessions.find((item) => item.id === place.local);
    if (!session) { why = 'no longer has it'; break; }
    if (!session.movedTo) return { here: place };
    next = session.movedTo;
  }
  return { here: await reclaim(), notice: `This chat moved to ${next.machine}, which ${why}: it goes on here.` };
}

/** The chat a terminal opens for this machine's chat `id`: undefined when that
 * is live (it opens), else the live one (liveChat) -- the copy here going on
 * only when that cannot be reached. */
export async function openedChat(id: string, reach: MachineReach = windowReach): Promise<LiveChat | undefined> {
  const opened = (await readState({ transcripts: [] })).sessions.find((item) => item.id === id);
  if (!opened?.movedTo) return undefined;
  return liveChat(opened.movedTo, async () => {
    const { reclaimMovedChat } = await import('../session/move.js');
    return { local: await reclaimMovedChat(id) };
  }, reach);
}
