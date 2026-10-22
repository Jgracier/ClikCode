/** `/remote`: the machines ClikCode Remote shows on the board, and adding
 * one.
 *
 *   Added           the machines added, each connected / offline / needs update
 *   On your tailnet the user's own machines Tailscale knows (remote/tailscale.ts)
 *   Add by SSH address...
 *
 * Choosing a new machine installs ClikCode there from GitHub main
 * (remote/install.ts), a step at a time, each step's line in the chat; then
 * its chats are on the board. Choosing an added one offers to update it (to
 * this build's commit, the one it is kept at), whether it is updated by
 * itself or only when asked (remote/updates.ts), or to remove it. Nothing
 * from this machine is copied to the other one. */
import chalk from 'chalk';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { relativeTime } from '../../harness/protocol/format.js';
import { chooseOption } from './choose.js';
import { holdWindowMachines, reconnectWindowMachine, type MachineView } from '../../remote/connection.js';
import { forgetMachine, newMachineRecord, readMachines, updateMachine, updateMachines, updatePolicy, type RemoteMachine } from '../../remote/machines.js';
import { installedRecord, localBuildCommit, updateRemoteMachine } from '../../remote/updates.js';
import { discoverMachines, notYetAdded, readTailscaleStatus, type DiscoveredMachine } from '../../remote/tailscale.js';
import { installOnMachine, uninstallFromMachine, type InstallOutcome, type InstallReporter } from '../../remote/install.js';
import { defaultLoginUser } from '../../remote/ssh.js';
import { targetHost, targetUser, validateSshTarget, withUser } from '../../remote/shell.js';
import type { InteractiveSlashOutcome } from '../slash/interactive-keys.js';

/** What /remote needs of the window it runs in. */
export interface RemoteHost {
  readonly prompter: HarnessPrompter;
  /** A one-line question; undefined when Esc cancelled it. */
  ask(label: string): Promise<string | undefined>;
  withBusy<T>(label: string, work: () => Promise<T>): Promise<T>;
  /** A line in the chat (each install step). */
  line(text: string): void;
}

const ADDRESS_VALUE = '__address__';
const ADDED = 'Added';
const TAILNET = 'On your tailnet';
const OTHER = 'Somewhere else';

/** How an added machine is, in a word or two. */
export function machineStateText(machine: RemoteMachine, view: MachineView | undefined, now = Date.now()): string {
  if (!machine.ready) return 'install not finished';
  if (!view || view.state === 'connecting') return 'checking…';
  if (view.state === 'offline') return `offline${machine.lastSeen ? ` · last seen ${relativeTime(machine.lastSeen, now)}` : ''}`;
  if (view.updating) return 'updating ClikCode…';
  if (!view.needsUpdate) return 'connected';
  return chalk.yellow(view.updateError ? 'needs update · the last update failed' : 'needs update');
}

/** Discovered machines not already added (by Tailscale node, by name it is
 * reached at, or by installation id once it has one). */
export { notYetAdded } from '../../remote/tailscale.js';

export async function interactiveRemotePicker(host: RemoteHost): Promise<InteractiveSlashOutcome> {
  const rl = host.prompter;
  const machines = await readMachines();
  // The added machines' state comes from the window's connections to them
  // (made now for any it has none to, kept after the list closes). Only to
  // show their state: nothing is updated by itself while the user is
  // choosing what to do with a machine.
  const connections = await holdWindowMachines();
  let discovered: DiscoveredMachine[] = [];
  let tailscaleError: string | undefined;
  const tailscale = readTailscaleStatus().then(({ status, error }) => {
    tailscaleError = error;
    discovered = status ? discoverMachines(status) : [];
  });
  const settled = connections.views().map((view) => new Promise<void>((resolve) => {
    const check = (): void => { if (view.state !== 'connecting') { stop(); resolve(); } };
    const stop = connections.onChange(check);
    setTimeout(() => { stop(); resolve(); }, 20_000).unref();
    check();
  }));
  const options = (): PickerOption<string>[] => {
    const now = Date.now();
    const views = new Map(connections.views().map((view) => [view.machine.id, view]));
    const rows: PickerOption<string>[] = machines.map((machine) => ({
      label: machine.name,
      detail: `· ${machineStateText(machine, views.get(machine.id), now)} · ${machine.sshTarget}`,
      value: `machine:${machine.id}`,
      group: ADDED,
    }));
    for (const machine of notYetAdded(discovered, machines)) {
      rows.push({
        label: machine.name,
        detail: `· ${machine.os} · ${machine.online ? 'online' : `last seen ${machine.lastSeen ? relativeTime(machine.lastSeen, now) : 'a while ago'}`} · ${machine.os === 'windows' ? 'not supported yet' : 'install ClikCode'}`,
        value: `tailscale:${machine.nodeId}`,
        group: TAILNET,
      });
    }
    rows.push({
      label: 'Add by SSH address…',
      detail: tailscaleError ? `· user@host or a Host alias · (${tailscaleError})` : '· user@host or a Host alias',
      value: ADDRESS_VALUE,
      group: OTHER,
    });
    return rows;
  };
  // Tailscale answers locally in milliseconds: the list opens with its
  // machines in it, at its full height, rather than growing a row at a time.
  await Promise.race([tailscale, new Promise((resolve) => setTimeout(resolve, 1500).unref())]);
  let chosen: string | undefined;
  try {
    chosen = await chooseOption(rl, 'ClikCode Remote', options(), undefined, {
      refreshedOptions: options, refresh: [tailscale, ...settled], rows: Math.max(8, Math.min(14, (process.stdout.rows ?? 24) - 16)),
    });
  } finally {
    // The connections stay: the board and /machine use them next.
    connections.release();
  }
  if (!chosen) return {};
  if (chosen === ADDRESS_VALUE) {
    const typed = await host.ask('SSH address (user@host, host, or a Host alias)');
    if (!typed?.trim()) return {};
    const target = validateSshTarget(typed);
    return addMachine(host, newMachineRecord({ name: targetHost(target).split('.')[0] || target, sshTarget: target }));
  }
  if (chosen.startsWith('tailscale:')) {
    const machine = discovered.find((item) => `tailscale:${item.nodeId}` === chosen);
    if (!machine) return {};
    return addMachine(host, newMachineRecord({
      name: machine.name, sshTarget: validateSshTarget(machine.dnsName ?? machine.hostName), os: machine.os,
      tailscale: { nodeId: machine.nodeId, ...(machine.dnsName ? { dnsName: machine.dnsName } : {}) },
    }));
  }
  const machine = machines.find((item) => `machine:${item.id}` === chosen);
  return machine ? manageMachine(host, machine) : {};
}

/** The step lines: each finished step, numbered, with what it found. */
function stepLines(host: RemoteHost): InstallReporter {
  let current = 0;
  let total = 0;
  return {
    start: (_step, index, count) => { current = index; total = count; },
    done: (step, detail) => host.line(`${chalk.green('✓')} ${current}/${total} ${step}${detail ? chalk.dim(` · ${detail}`) : ''}`),
  };
}

/** Runs the install (or update) and says how it went; on a refused login,
 * asks once which user to log in as, and remembers it for the machine. An
 * update goes to this build's commit when it has one (else GitHub main). */
async function runInstall(host: RemoteHost, machine: RemoteMachine, update: boolean): Promise<{ outcome: InstallOutcome; machine: RemoteMachine }> {
  let target = machine.sshTarget;
  let asked = false;
  const commit = update ? localBuildCommit() : undefined;
  for (;;) {
    host.line(`${update ? 'Updating' : 'Installing'} ClikCode on ${machine.name} (${target}) ${commit ? `to this build's commit ${commit.slice(0, 8)}` : 'from GitHub main'}`);
    const outcome = await host.withBusy(`${update ? 'updating' : 'installing'} ClikCode on ${machine.name}`, () => (update
      ? updateRemoteMachine({ ...machine, sshTarget: target }, stepLines(host), commit ? { commit } : {})
      : installOnMachine(target, stepLines(host))));
    if (outcome.ok || !outcome.auth || asked) return { outcome, machine };
    asked = true;
    // Not a failure yet: why it is asking, then a list to answer with. The
    // composer's prompt is one line, too short to carry the question.
    host.line(`${chalk.yellow('!')} ${outcome.message}`);
    const answer = await chooseLoginUser(host, machine.name, target);
    if (!answer) return { outcome, machine };
    target = withUser(target, answer);
    machine.sshTarget = target;
    await updateMachine(machine.id, (record) => { record.sshTarget = target; });
  }
}

const OTHER_USER = '__other__';

/** Which user to log in as, after the login was refused: root (what servers
 * and Tailscale SSH policies most often allow) or one typed. The user it
 * refused, the one in the target or else ssh's default, is not offered again. */
async function chooseLoginUser(host: RemoteHost, name: string, target: string): Promise<string | undefined> {
  const refused = targetUser(target) ?? await defaultLoginUser(target);
  const options: PickerOption<string>[] = [
    ...(refused === 'root' ? [] : [{ label: 'root', detail: '· installs in /root', value: 'root' }]),
    { label: 'Another user…', detail: '· type its name', value: OTHER_USER },
  ];
  const chosen = await chooseOption(host.prompter, `Log in to ${name} as (not ${refused})`, options);
  if (chosen !== OTHER_USER) return chosen;
  return (await host.ask('User'))?.trim() || undefined;
}

async function addMachine(host: RemoteHost, machine: RemoteMachine, recorded = false): Promise<InteractiveSlashOutcome> {
  // Recorded first, so the user given for a refused login is remembered
  // even when a later step stops (it is listed as not finished).
  if (!recorded) await updateMachines((machines) => [...machines, machine]);
  const { outcome } = await runInstall(host, machine, false);
  if (!outcome.ok) {
    host.line(`${chalk.red('✗')} ${outcome.step}: ${outcome.message}`);
    if (outcome.windows) await forgetMachine(machine.id);
    return {};
  }
  const { info } = outcome;
  // The same ClikCode installation already added under another name or
  // address is the same machine: one record of it.
  const existing = info.installationId ? (await readMachines()).find((other) => other.id !== machine.id && other.installationId === info.installationId) : undefined;
  if (existing) {
    await forgetMachine(machine.id);
    await updateMachine(existing.id, (record) => installedRecord(record, info));
    reconnectWindowMachine(existing.id);
    return { notice: `${machine.name} is ${existing.name}, already added: it is up to date now.` };
  }
  await updateMachine(machine.id, (record) => {
    installedRecord(record, info);
    record.lastSeen = new Date().toISOString();
  });
  return { notice: `${machine.name} is added. Its chats are on the board (← on an empty prompt). Sign in to providers there from its own chats.` };
}

async function manageMachine(host: RemoteHost, machine: RemoteMachine): Promise<InteractiveSlashOutcome> {
  const commit = localBuildCommit();
  const auto = updatePolicy(machine) === 'auto';
  if (machine.updateError) host.line(`${chalk.yellow('!')} The last update of ${machine.name} failed: ${machine.updateError}`);
  const action = await chooseOption(host.prompter, machine.name, [
    machine.ready
      ? { label: 'Update ClikCode', detail: commit ? `· to this build's commit ${commit.slice(0, 8)}` : '· to GitHub main', value: 'update' }
      : { label: 'Finish installing', detail: '· from GitHub main', value: 'install' },
    {
      label: `Updates: ${auto ? 'automatic' : 'ask first'}`,
      detail: auto ? "· it is brought to this build's commit by itself; choose to ask first" : '· only when you update it; choose to update it by itself',
      value: 'policy',
    },
    { label: 'Remove', detail: '· forget it here; optionally uninstall ClikCode there', value: 'remove' },
  ]);
  if (action === 'install') return addMachine(host, machine, true);
  if (action === 'policy') {
    const updates = auto ? 'ask' : 'auto';
    await updateMachine(machine.id, (record) => { record.updates = updates; });
    return { notice: updates === 'ask'
      ? `${machine.name} is updated only when you say so: from here, or /update in one of its chats.`
      : `${machine.name} is updated to this build by itself when it differs; its chats switch over once they are quiet.` };
  }
  if (action === 'update') {
    const { outcome } = await runInstall(host, machine, true);
    if (!outcome.ok) {
      host.line(`${chalk.red('✗')} ${outcome.step}: ${outcome.message}`);
      return {};
    }
    const { info } = outcome;
    // The window's connection there goes to the new build.
    reconnectWindowMachine(machine.id);
    return { notice: `ClikCode on ${machine.name} is updated${info.commit ? ` to ${info.commit.slice(0, 8)}` : ''}; its chats switch over once they are quiet.` };
  }
  if (action !== 'remove') return {};
  const how = await chooseOption(host.prompter, `Remove ${machine.name}`, [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Forget it here', detail: '· ClikCode stays installed there', value: 'forget' },
    { label: 'Forget it and uninstall ClikCode there', detail: '· removes ~/.local/share/clikcode and ~/.local/bin/clikcode; its chats and accounts stay', value: 'uninstall' },
    { label: 'Forget it, uninstall, and delete its ClikCode data', detail: `· also ~/.clikcode there: every chat and account on ${machine.name}`, value: 'data' },
  ]);
  if (!how || how === 'cancel') return {};
  if (how === 'data') {
    const sure = await chooseOption(host.prompter, `Delete every ClikCode chat and account on ${machine.name}?`, [
      { label: 'Cancel', value: false }, { label: `Delete ~/.clikcode on ${machine.name}`, value: true },
    ]);
    if (!sure) return {};
  }
  if (how === 'uninstall' || how === 'data') {
    const result = await host.withBusy(`uninstalling ClikCode on ${machine.name}`, () => uninstallFromMachine(machine.sshTarget, how === 'data'));
    if (!result.ok) {
      host.line(`${chalk.red('✗')} Uninstalling on ${machine.name} failed: ${result.message ?? 'no answer'}. It is still added; try again when it is online, or choose "Forget it here".`);
      return {};
    }
  }
  await forgetMachine(machine.id);
  return { notice: how === 'forget' ? `${machine.name} is forgotten here; ClikCode is still installed there.` : `${machine.name} is removed, and ClikCode is uninstalled there${how === 'data' ? ', its data too' : ''}.` };
}
