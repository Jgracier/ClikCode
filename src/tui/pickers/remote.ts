/** Adding, updating and removing the machines /machine lists (and the board's
 * Machines) -- what /remote used to be:
 *
 *   added machines     choose one: the chat moves there; Tab: update ClikCode
 *                      there, how it is kept up to date, or remove it
 *   On your tailnet    the user's own machines Tailscale knows (remote/tailscale.ts)
 *   Add by SSH address any machine you can reach
 *
 * Adding a machine asks which user to log in as, then installs ClikCode there
 * from GitHub main (remote/install.ts), a step at a time, each step's line in
 * the chat. Nothing from this machine is copied to the other one. */
import chalk from 'chalk';
import type { HarnessPrompter } from '../../harness/prompter.js';
import { relativeTime } from '../../harness/protocol/format.js';
import { chooseOption } from './choose.js';
import { withSlowWait, type WaitingBand } from '../slow-wait.js';
import { reconnectWindowMachine, type MachineView } from '../../remote/connection.js';
import { forgetMachine, newMachineRecord, readMachines, updateMachine, updateMachines, updatePolicy, type RemoteMachine } from '../../remote/machines.js';
import { installedRecord, localBuildCommit, updateRemoteMachine } from '../../remote/updates.js';
import type { DiscoveredMachine } from '../../remote/tailscale.js';
import { installOnMachine, uninstallFromMachine, type InstallOutcome, type InstallReporter } from '../../remote/install.js';
import { defaultLoginUser } from '../../remote/ssh.js';
import { targetHost, targetUser, validateSshTarget, withUser } from '../../remote/shell.js';
import { wrapWords } from '../render/wrap.js';

/** What adding or managing a machine needs of the window it runs in. */
export interface RemoteHost {
  readonly prompter: HarnessPrompter;
  /** A one-line question; undefined when Esc cancelled it. */
  ask(label: string): Promise<string | undefined>;
  withBusy<T>(label: string, work: () => Promise<T>): Promise<T>;
  /** A line in the chat (each install step). */
  line(text: string): void;
}

/** A RemoteHost over the terminal's prompter alone, for lists that add a
 * machine (/machine, the board's Machines): its questions on
 * the composer's line, its waits on the band, each step a line in the chat. */
export function remoteHostOf(prompter: HarnessPrompter & Partial<WaitingBand>): RemoteHost {
  return {
    prompter,
    ask: (label) => prompter.question(`${label} › `, undefined, { cancellable: true }).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'ERR_PROMPT_CANCELLED') return undefined;
      throw error;
    }),
    withBusy: (label, work) => withSlowWait(prompter.startWaiting && prompter.stopWaiting ? prompter as WaitingBand : undefined, label, work),
    line: (text) => { if (prompter.activity) prompter.activity(text); else process.stderr.write(`${text}\n`); },
  };
}

/** A line in the chat that says all of it: a step's detail or a failure's
 * reason and what to do is never cut to the terminal's width, but wrapped
 * onto the rows under it. `mark` (✓ ! ✗) leads; `tail` is dimmed. */
function say(host: RemoteHost, mark: string, text: string, tail = ''): void {
  const plain = `${text}${tail}`;
  const width = process.stdout.columns ? Math.max(20, process.stdout.columns - 6) : Infinity;
  const rows = width === Infinity ? [plain] : wrapWords(plain, width);
  rows.forEach((row, at) => {
    // Where in the row the dimmed tail begins: the rows are `plain`, cut at spaces.
    const start = rows.slice(0, at).reduce((sum, item) => sum + item.length, 0);
    const offset = plain.indexOf(row, start);
    const dimFrom = Math.max(0, Math.min(row.length, text.length - offset));
    const drawn = `${row.slice(0, dimFrom)}${dimFrom < row.length ? chalk.dim(row.slice(dimFrom)) : ''}`;
    host.line(at === 0 && mark ? `${mark} ${drawn}` : drawn);
  });
}


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

/** The step lines: each finished step, numbered, with what it found. */
function stepLines(host: RemoteHost): InstallReporter {
  let current = 0;
  let total = 0;
  return {
    start: (_step, index, count) => { current = index; total = count; },
    done: (step, detail) => say(host, chalk.green('✓'), `${current}/${total} ${step}`, detail ? ` · ${detail}` : ''),
  };
}

/** Runs the install (or update) and says how it went; on a refused login,
 * asks once more which user to log in as, and remembers it for the machine. An
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
    // Not a failure yet: why it is asking (and which user it refused), then
    // the question, typed again.
    const who = targetUser(target) ? '' : ` (as ${await defaultLoginUser(target)}, ssh's default)`;
    say(host, chalk.yellow('!'), `${outcome.message}${who}`);
    const retried = await askLoginUser(host, machine.name, target);
    if (!retried) return { outcome, machine };
    target = retried;
    machine.sshTarget = target;
    await updateMachine(machine.id, (record) => { record.sshTarget = target; });
  }
}

/** Which user to log in to `name` as: a plain question, typed, nothing
 * suggested or assumed -- Tailscale gives the machine and the name it is
 * reached at, never the account on it, and only the user knows which one is
 * theirs. A name that is not one says why and is asked again. Returns
 * `user@host` for `target`; undefined: Esc, add nothing. */
export async function askLoginUser(host: RemoteHost, name: string, target: string): Promise<string | undefined> {
  for (;;) {
    const typed = await host.ask(`Log in to ${name} as which user?`);
    if (typed === undefined) return undefined;
    if (!typed.trim()) { say(host, chalk.yellow('!'), 'Type a user name, or Esc to add nothing.'); continue; }
    try {
      return withUser(target, typed);
    } catch (error) {
      say(host, chalk.yellow('!'), `${error instanceof Error ? error.message : String(error)} Type another, or Esc to add nothing.`);
    }
  }
}

/** What adding a machine came to: its id once its chats can be listed
 * (it is added, or was already, maybe under another name), and what to say. */
export interface AddedMachine { id?: string; notice?: string }

/** Adds a machine Tailscale found (tailscale.ts), wherever machines are
 * listed (/machine, the board's Machines): asks which user to log in
 * as, then installs ClikCode there from GitHub main, a step at a time. One
 * already added is its record; one whose install did not finish goes on
 * with the user it was given. */
export async function addDiscoveredMachine(host: RemoteHost, found: DiscoveredMachine): Promise<AddedMachine> {
  if (found.os === 'windows') throw new Error(`${found.name} runs Windows: ClikCode Remote does not support it yet.`);
  const existing = (await readMachines()).find((machine) => machine.tailscale?.nodeId === found.nodeId);
  if (existing?.ready) return { id: existing.id };
  let target = existing?.sshTarget ?? validateSshTarget(found.dnsName ?? found.hostName);
  if (!targetUser(target)) {
    const typed = await askLoginUser(host, found.name, target);
    if (!typed) return {};
    target = typed;
  }
  if (existing) {
    existing.sshTarget = target;
    await updateMachine(existing.id, (record) => { record.sshTarget = target; });
    return installNew(host, existing, true);
  }
  return installNew(host, newMachineRecord({
    name: found.name, sshTarget: target, os: found.os,
    tailscale: { nodeId: found.nodeId, ...(found.dnsName ? { dnsName: found.dnsName } : {}) },
  }));
}

/** Adds a machine by its SSH address (user@host, host, or a Host alias from
 * ~/.ssh/config): any machine you can reach, Tailscale or not. */
export async function addByAddress(host: RemoteHost, typed: string): Promise<AddedMachine> {
  const target = validateSshTarget(typed);
  return installNew(host, newMachineRecord({ name: targetHost(target).split('.')[0] || target, sshTarget: target }));
}

async function installNew(host: RemoteHost, machine: RemoteMachine, recorded = false): Promise<AddedMachine> {
  // Recorded first, so the user given for a refused login is remembered
  // even when a later step stops (it is listed as not finished).
  if (!recorded) await updateMachines((machines) => [...machines, machine]);
  const { outcome } = await runInstall(host, machine, false);
  if (!outcome.ok) {
    say(host, chalk.red('✗'), `${outcome.step}: ${outcome.message}`);
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
    return { id: existing.id, notice: `${machine.name} is ${existing.name}, already added: it is up to date now.` };
  }
  await updateMachine(machine.id, (record) => {
    installedRecord(record, info);
    record.lastSeen = new Date().toISOString();
  });
  return { id: machine.id, notice: `${machine.name} is added. Its chats are on the board (← on an empty prompt, ← again for machines); sign in to providers there from its own chats.` };
}

/** An added machine's options (Tab on its row in /machine). */
export function machineActions(machine: RemoteMachine): Array<{ label: string; value: string }> {
  const auto = updatePolicy(machine) === 'auto';
  return [
    machine.ready ? { label: 'Update ClikCode', value: 'update' } : { label: 'Finish installing', value: 'install' },
    { label: auto ? 'Updates: automatic · ask first instead' : 'Updates: ask first · automatic instead', value: 'policy' },
    { label: 'Remove…', value: 'remove' },
  ];
}

/** One of machineActions, done: an update to this build's commit (else GitHub
 * main), finishing an install, switching how it is kept up to date, or removing
 * it (and optionally ClikCode there). */
export async function machineAction(host: RemoteHost, machine: RemoteMachine, action: string): Promise<{ notice?: string }> {
  const auto = updatePolicy(machine) === 'auto';
  if (machine.updateError && action === 'update') say(host, chalk.yellow('!'), `The last update of ${machine.name} failed: ${machine.updateError}`);
  if (action === 'install') {
    const { notice } = await installNew(host, machine, true);
    return notice ? { notice } : {};
  }
  if (action === 'policy') {
    const updates = auto ? 'ask' : 'auto';
    await updateMachine(machine.id, (record) => { record.updates = updates; });
    return { notice: updates === 'ask'
      ? `${machine.name} is updated only when you say so: Tab on it in /machine, or /update in one of its chats.`
      : `${machine.name} is updated to this build by itself when it differs; its chats switch over once they are quiet.` };
  }
  if (action === 'update') {
    const { outcome } = await runInstall(host, machine, true);
    if (!outcome.ok) {
      say(host, chalk.red('✗'), `${outcome.step}: ${outcome.message}`);
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
      say(host, chalk.red('✗'), `Uninstalling on ${machine.name} failed: ${result.message ?? 'no answer'}. It is still added; try again when it is online, or choose "Forget it here".`);
      return {};
    }
  }
  // Removed by the user: it does not add itself back by connecting here (remote/peer.ts).
  await forgetMachine(machine.id, { remember: true });
  return { notice: how === 'forget' ? `${machine.name} is forgotten here; ClikCode is still installed there.` : `${machine.name} is removed, and ClikCode is uninstalled there${how === 'data' ? ', its data too' : ''}.` };
}
