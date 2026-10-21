/** `/remote`: the machines ClikCode Remote shows on the board, and adding
 * one.
 *
 *   Added           the machines added, each connected / offline / needs update
 *   On your tailnet the user's own machines Tailscale knows (remote/tailscale.ts)
 *   Add by SSH address...
 *
 * Choosing a new machine installs ClikCode there from GitHub main
 * (remote/install.ts), a step at a time, each step's line in the chat; then
 * its chats are on the board. Choosing an added one offers to update or
 * remove it. Nothing from this machine is copied to the other one. */
import chalk from 'chalk';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { relativeTime } from '../../harness/protocol/format.js';
import { chooseOption } from './choose.js';
import { RemoteMachines, type MachineView } from '../../remote/connection.js';
import { forgetMachine, newMachineRecord, readMachines, updateMachine, updateMachines, type RemoteMachine } from '../../remote/machines.js';
import { discoverMachines, readTailscaleStatus, type DiscoveredMachine } from '../../remote/tailscale.js';
import { installOnMachine, uninstallFromMachine, type InstallOutcome, type InstallReporter } from '../../remote/install.js';
import { defaultLoginUser } from '../../remote/ssh.js';
import { targetHost, validateSshTarget, withUser } from '../../remote/shell.js';
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
  return view.needsUpdate ? chalk.yellow('needs update') : 'connected';
}

/** Discovered machines not already added (by Tailscale node, by name it is
 * reached at, or by installation id once it has one). */
export function notYetAdded(discovered: readonly DiscoveredMachine[], machines: readonly RemoteMachine[]): DiscoveredMachine[] {
  const hosts = new Set(machines.map((machine) => targetHost(machine.sshTarget).toLowerCase()));
  const nodes = new Set(machines.flatMap((machine) => (machine.tailscale ? [machine.tailscale.nodeId] : [])));
  return discovered.filter((machine) => !nodes.has(machine.nodeId)
    && !(machine.dnsName && hosts.has(machine.dnsName.toLowerCase()))
    && !hosts.has(machine.name.toLowerCase()));
}

export async function interactiveRemotePicker(host: RemoteHost): Promise<InteractiveSlashOutcome> {
  const rl = host.prompter;
  const machines = await readMachines();
  // The added machines' state comes from connecting to them, for as long as
  // this list is open.
  const connections = await new RemoteMachines().open();
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
        detail: `· ${machine.os} · ${machine.online ? 'online' : `last seen ${machine.lastSeen ? relativeTime(machine.lastSeen, now) : 'a while ago'}`} · install ClikCode`,
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
  let chosen: string | undefined;
  try {
    chosen = await chooseOption(rl, 'ClikCode Remote', options(), undefined, {
      refreshedOptions: options, refresh: [tailscale, ...settled], rows: Math.max(8, Math.min(14, (process.stdout.rows ?? 24) - 16)),
    });
  } finally {
    void connections.close();
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
 * asks once which user to log in as, and remembers it for the machine. */
async function runInstall(host: RemoteHost, machine: RemoteMachine, update: boolean): Promise<{ outcome: InstallOutcome; machine: RemoteMachine }> {
  let target = machine.sshTarget;
  let asked = false;
  for (;;) {
    host.line(`${update ? 'Updating' : 'Installing'} ClikCode on ${machine.name} (${target}) from GitHub main`);
    const outcome = await host.withBusy(`${update ? 'updating' : 'installing'} ClikCode on ${machine.name}`, () => installOnMachine(target, stepLines(host), { update }));
    if (outcome.ok || !outcome.auth || asked) return { outcome, machine };
    asked = true;
    host.line(`${chalk.red('✗')} ${outcome.message}`);
    const fallback = await defaultLoginUser(target);
    const answer = await host.ask(`Log in to ${targetHost(target)} as which user? (Enter for ${fallback})`);
    if (answer === undefined) return { outcome, machine };
    target = withUser(target, answer.trim() || fallback);
    machine.sshTarget = target;
    await updateMachine(machine.id, (record) => { record.sshTarget = target; });
  }
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
    await updateMachine(existing.id, (record) => { record.installed = { version: info.version, ...(info.commit ? { commit: info.commit } : {}), at: new Date().toISOString() }; record.needsUpdate = false; record.ready = true; });
    return { notice: `${machine.name} is ${existing.name}, already added: it is up to date now.` };
  }
  await updateMachine(machine.id, (record) => {
    record.ready = true;
    record.installed = { version: info.version, ...(info.commit ? { commit: info.commit } : {}), at: new Date().toISOString() };
    if (info.installationId) record.installationId = info.installationId;
    record.lastSeen = new Date().toISOString();
    record.needsUpdate = false;
  });
  return { notice: `${machine.name} is added. Its chats are on the board (← on an empty prompt). Sign in to providers there from its own chats.` };
}

async function manageMachine(host: RemoteHost, machine: RemoteMachine): Promise<InteractiveSlashOutcome> {
  const action = await chooseOption(host.prompter, machine.name, [
    machine.ready
      ? { label: 'Update ClikCode', detail: '· to GitHub main', value: 'update' }
      : { label: 'Finish installing', detail: '· from GitHub main', value: 'install' },
    { label: 'Remove', detail: '· forget it here; optionally uninstall ClikCode there', value: 'remove' },
  ]);
  if (action === 'install') return addMachine(host, machine, true);
  if (action === 'update') {
    const { outcome } = await runInstall(host, machine, true);
    if (!outcome.ok) {
      host.line(`${chalk.red('✗')} ${outcome.step}: ${outcome.message}`);
      return {};
    }
    const { info } = outcome;
    await updateMachine(machine.id, (record) => {
      record.ready = true;
      record.installed = { version: info.version, ...(info.commit ? { commit: info.commit } : {}), at: new Date().toISOString() };
      if (info.installationId) record.installationId = info.installationId;
      record.needsUpdate = false;
    });
    return { notice: `ClikCode on ${machine.name} is updated${info.commit ? ` to ${info.commit.slice(0, 8)}` : ''}.` };
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
