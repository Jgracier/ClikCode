/** `/update` (and `clikcode update`): this machine's ClikCode, updated the
 * way it was installed. The machine is the one that owns the chat the
 * command was typed in: a chat on another machine sends its slash lines over
 * that machine's bridge, so this runs THERE.
 *
 * How it was installed is read from the running entry, never guessed:
 *
 *   managed   ClikCode Remote's install: the clone ~/.local/share/clikcode/src
 *             exists and the entry resolves under ~/.local/share/clikcode/release
 *             (whose node_modules, when it has them, are that clone's). The clone
 *             is reset to main or a chosen commit, built and installed -- the
 *             same scripts Remote runs over SSH (install.ts runManagedUpdate).
 *   npm       the entry is inside node_modules/clikcode: `npm install -g
 *             clikcode@latest`. Published versions only; no commits.
 *   checkout  anything else -- a developer's own checkout, or a release
 *             install-local made from one. It is the developer's: nothing is
 *             touched, and the reply says what to run there.
 *
 * Running chats keep their build until they are quiet, then switch
 * (worker/worker-idle.ts). Nothing here blocks the event loop: every step is
 * a child process. */
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { CLIKCODE_COMMIT, CLIKCODE_VERSION } from '../version.js';
import { localMachineName } from './board-rows.js';
import { localRunner, runManagedUpdate, stepper, UPDATE_STEPS, type InstallReporter, type ScriptRunner } from './install.js';
import { failureText } from '../harness/protocol/stderr-line.js';

export type InstallKind =
  | { kind: 'managed' }
  | { kind: 'npm'; packageRoot: string }
  | { kind: 'checkout'; repo?: string };

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const real = (path: string): Promise<string> => realpath(path).catch(() => path);
const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);

/** How the ClikCode whose entry is `entry` was installed. */
export async function detectInstall(entry: string, home = homedir()): Promise<InstallKind> {
  const share = join(home, '.local', 'share', 'clikcode');
  const release = await real(join(share, 'release'));
  const clone = join(share, 'src');
  const running = await real(entry);
  const packageRoot = dirname(dirname(running));
  if (inside(running, release)) {
    const modules = join(release, 'node_modules');
    const linked = await exists(modules) ? await real(modules) : undefined;
    if (await exists(join(clone, '.git')) && (!linked || inside(linked, await real(clone)))) return { kind: 'managed' };
    // install-local from a checkout elsewhere: its node_modules say which.
    const repo = linked ? dirname(linked) : undefined;
    return { kind: 'checkout', ...(repo && await exists(join(repo, '.git')) ? { repo } : {}) };
  }
  if (basename(packageRoot) === 'clikcode' && basename(dirname(packageRoot)) === 'node_modules') return { kind: 'npm', packageRoot };
  return { kind: 'checkout', ...(await exists(join(packageRoot, '.git')) ? { repo: packageRoot } : {}) };
}

export interface SelfUpdateOptions {
  /** A commit to update to (a ClikCode Remote install only); main by default. */
  commit?: string;
  /** Each step as it finishes, and what it found. */
  line(text: string): void;
  /** The entry the install is read from: this process's by default. */
  entry?: string;
  home?: string;
  /** The build asking: compared to say "already up to date". */
  running?: { commit?: string; version: string };
  /** Runs each step's script here (tests give their own). */
  run?: ScriptRunner;
  hostName?: string;
}

export interface SelfUpdateResult {
  kind: InstallKind['kind'];
  /** What to say: what changed, that nothing needed to, or what to run. */
  text: string;
  updated: boolean;
}

const short = (commit: string | undefined): string => (commit ? commit.slice(0, 8) : 'unknown');
const SWITCH = 'chats switch over once they are quiet';

/** A commit as typed: hex, 7 to 40 characters. */
export function parseCommitArgument(args: string): string | undefined {
  const typed = args.trim();
  if (!typed) return undefined;
  if (!/^[0-9a-f]{7,40}$/i.test(typed)) throw new Error(`/update takes a commit (7 to 40 hex characters), not "${typed}".`);
  return typed.toLowerCase();
}

/** Step lines: `✓ 1/3 Getting ClikCode from GitHub · updated at abc12345`. */
function stepReporter(line: (text: string) => void): InstallReporter {
  let current = 0;
  let total = 0;
  return {
    start: (_step, index, count) => { current = index; total = count; },
    done: (step, detail) => line(`✓ ${current}/${total} ${step}${detail ? ` · ${detail}` : ''}`),
  };
}

/** Updates this machine's ClikCode; throws naming the step that failed. */
export async function updateThisMachine(options: SelfUpdateOptions): Promise<SelfUpdateResult> {
  const where = options.hostName ?? localMachineName();
  const run = options.run ?? localRunner;
  const running = options.running ?? { version: CLIKCODE_VERSION, ...(CLIKCODE_COMMIT ? { commit: CLIKCODE_COMMIT } : {}) };
  const install = await detectInstall(options.entry ?? process.argv[1] ?? '', options.home);

  if (install.kind === 'checkout') {
    return {
      kind: 'checkout', updated: false,
      text: install.repo
        ? `This ClikCode on ${where} is built from a developer checkout (${install.repo}); /update does not touch a checkout. To update it, run \`git pull && pnpm run install-local\` in ${install.repo}.`
        : `This ClikCode on ${where} was not installed by ClikCode Remote or npm, and is not a checkout /update could name; it is left alone. Update it the way it was installed.`,
    };
  }

  if (install.kind === 'npm') {
    if (options.commit) throw new Error('This ClikCode is the npm package, which installs published versions, not commits. Run /update without a commit for the latest version.');
    const view = await run('npm view clikcode version', { timeoutMs: 120_000 });
    const latest = view.stdout.trim().split('\n').pop()?.trim();
    if (view.code !== 0 || !latest) throw new Error(`Checking npm: \`npm view clikcode version\` failed: ${failureText(view.stderr) || `exit ${view.code}`}.`);
    options.line(`✓ 1/2 Checking npm · clikcode ${latest} is the latest`);
    if (latest === running.version) return { kind: 'npm', updated: false, text: `ClikCode ${running.version} on ${where} is already up to date.` };
    const installed = await run('npm install -g clikcode@latest', { timeoutMs: 20 * 60_000 });
    if (installed.code !== 0) throw new Error(`Installing clikcode@latest: \`npm install -g clikcode@latest\` failed: ${failureText(installed.stderr) || `exit ${installed.code}`}.`);
    options.line(`✓ 2/2 Installing clikcode@latest · ${install.packageRoot}`);
    return { kind: 'npm', updated: true, text: `ClikCode ${running.version} → ${latest} on ${where}; ${SWITCH}.` };
  }

  const progress = stepper(stepReporter(options.line), UPDATE_STEPS.length);
  const outcome = await runManagedUpdate(run, where, progress, { ...(options.commit ? { commit: options.commit } : {}), running: running.commit ?? '' });
  if (!outcome.ok) throw new Error(`${outcome.step}: ${outcome.message}`);
  if (outcome.upToDate) return { kind: 'managed', updated: false, text: `ClikCode ${short(outcome.to)} on ${where} is already up to date.` };
  const from = outcome.from ?? running.commit;
  // Already at the target, but not running it (an earlier build that failed): built again.
  if (from === outcome.to) return { kind: 'managed', updated: true, text: `ClikCode ${short(outcome.to)} on ${where} is built and installed again; ${SWITCH}.` };
  return { kind: 'managed', updated: true, text: `ClikCode ${short(from)} → ${short(outcome.to)} on ${where}; ${SWITCH}.` };
}
