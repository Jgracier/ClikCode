/** Keeping the other machines' ClikCode current.
 *
 * A machine ClikCode Remote installed is brought to THIS build's commit --
 * not to whatever main is now -- so the two ends of a connection run the
 * same code. When a connection's `host-ready` says another commit
 * (connection.ts needsUpdate) and the machine's policy is 'auto' (the
 * default), the update runs over SSH in the background: the managed clone
 * fetched at that sha, built and installed (install.ts runManagedUpdate).
 * The machine's chats switch to the new build only once they are quiet
 * (worker/worker-idle.ts), never mid-turn.
 *
 * Once per machine per commit per process: a failure is recorded on the
 * machine (`updateError`) and shown, and not retried in a loop. A build with
 * no commit of its own (a packed npm build) has nothing to match: nothing
 * is updated by itself. Policy 'ask' never updates by itself; the user
 * updates from /remote, the editor's machine list, or /update in one of
 * that machine's chats. */
import { CLIKCODE_COMMIT } from '../version.js';
import { installOnMachine, type InstallOutcome, type InstallReporter, type RemoteInfo } from './install.js';
import { readMachines, updateMachine, updatePolicy, type RemoteMachine } from './machines.js';

/** The commit other machines are brought to: this build's.
 * CLIKCODE_REMOTE_LOCAL_COMMIT stands in for it in tests, whose fake
 * repository cannot hold this checkout's commit. */
export function localBuildCommit(): string | undefined {
  return process.env.CLIKCODE_REMOTE_LOCAL_COMMIT?.trim() || CLIKCODE_COMMIT;
}

/** What a machine record says of the ClikCode just installed there. */
/** `/update` typed into a chat on another machine, with no commit: to the editor's build, the
 * commit automatic updates keep that machine at -- not main, which they would then undo. */
export function pinnedUpdateLine(line: string, editorCommit: string | undefined): string {
  return editorCommit && /^\/update\s*$/i.test(line.trim()) ? `/update ${editorCommit}` : line;
}

export function installedRecord(record: RemoteMachine, info: RemoteInfo): void {
  record.ready = true;
  record.installed = { version: info.version, ...(info.commit ? { commit: info.commit } : {}), at: new Date().toISOString() };
  if (info.installationId) record.installationId = info.installationId;
  record.needsUpdate = false;
  delete record.updateError;
}

const noSteps: InstallReporter = { start: () => undefined, done: () => undefined };

/** Updates ClikCode on `machine` over SSH to `commit` (main when absent),
 * and records how it went: the new install, or why it failed. */
export async function updateRemoteMachine(machine: RemoteMachine, reporter: InstallReporter = noSteps, options: { commit?: string } = {}): Promise<InstallOutcome> {
  const outcome = await installOnMachine(machine.sshTarget, reporter, { update: true, ...(options.commit ? { commit: options.commit } : {}) });
  await updateMachine(machine.id, (record) => {
    if (outcome.ok) installedRecord(record, outcome.info);
    else record.updateError = `${outcome.step}: ${outcome.message}`;
  }).catch(() => undefined);
  return outcome;
}

export type AutoUpdateDecision =
  | { update: true; commit: string }
  | { update: false; reason: 'current' | 'ask' | 'no-commit' | 'attempted' };

/** Whether to update a machine by itself now, and to which commit. */
export function autoUpdateDecision(
  machine: Pick<RemoteMachine, 'id' | 'updates'>, needsUpdate: boolean, localCommit: string | undefined, attempted: ReadonlySet<string>,
): AutoUpdateDecision {
  if (!needsUpdate) return { update: false, reason: 'current' };
  if (updatePolicy(machine) === 'ask') return { update: false, reason: 'ask' };
  if (!localCommit) return { update: false, reason: 'no-commit' };
  if (attempted.has(attemptKey(machine.id, localCommit))) return { update: false, reason: 'attempted' };
  return { update: true, commit: localCommit };
}

const attemptKey = (machineId: string, commit: string): string => `${machineId}\0${commit}`;

type Runner = (machine: RemoteMachine, commit: string) => Promise<InstallOutcome>;

/** The process's automatic updates: at most one running per machine, and
 * one attempt per machine per commit. */
export class AutoUpdates {
  private readonly attempted = new Set<string>();
  private readonly running = new Map<string, Promise<InstallOutcome>>();

  constructor(private readonly run: Runner = (machine, commit) => updateRemoteMachine(machine, noSteps, { commit })) {}

  /** A connection found `machine` outdated. Resolves once decided: with
   * the update (`done`, its outcome) when one starts or is already running
   * for it, undefined when none is due. The policy is read from the saved
   * record, which /remote may have changed since. */
  async consider(machine: RemoteMachine, localCommit: string | undefined = localBuildCommit()): Promise<{ done: Promise<InstallOutcome> } | undefined> {
    const already = this.running.get(machine.id);
    if (already) return { done: already };
    const saved = (await readMachines()).find((item) => item.id === machine.id) ?? machine;
    const decision = autoUpdateDecision(saved, true, localCommit, this.attempted);
    // Another connection may have started it while the record was read.
    const raced = this.running.get(machine.id);
    if (raced) return { done: raced };
    if (!decision.update) return undefined;
    this.attempted.add(attemptKey(machine.id, decision.commit));
    const done = this.run(saved, decision.commit).finally(() => this.running.delete(machine.id));
    this.running.set(machine.id, done);
    return { done };
  }

  /** The update running for a machine now, if any. */
  runningFor(machineId: string): Promise<InstallOutcome> | undefined {
    return this.running.get(machineId);
  }
}

export const autoUpdates = new AutoUpdates();
