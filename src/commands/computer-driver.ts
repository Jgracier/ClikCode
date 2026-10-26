/** `clikcode computer driver ...`: install, update and inspect cua-driver, the desktop-control backend. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { emitResult } from '../cli/structured-output.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { activeReleaseDir, defaultDeps, driverStatus, installDriver, rollbackDriver, type InstallResult } from '../agent/computer/driver-install.js';
import { WAYLAND_DRIVER_VERSION, driverVersionNotice, waylandSession } from '../agent/computer/driver.js';
import { helperExplanation, waylandHelperVerdict } from '../agent/computer/driver-wayland.js';

/** Progress goes to stderr, so `--json` output on stdout stays one document. */
const say = (line: string): void => { process.stderr.write(`${line}\n`); };

function report(result: InstallResult, verb: string): void {
  if (isJsonDefaultMode()) return emitResult({ computer: { driver: result } });
  const line = result.action === 'up-to-date' ? `cua-driver ${result.version} is already installed and current.`
    : result.action === 'newer-installed' ? result.notes[0]!
    : result.action === 'rolled-back' ? `Went back to cua-driver ${result.version}.`
    : `cua-driver ${result.version} ${verb}.${result.dir ? ` (${result.dir})` : ''}`;
  process.stdout.write(`${line}\n`);
  for (const note of result.notes.filter((note) => note !== line)) process.stdout.write(`${note}\n`);
  if (result.previous) process.stdout.write(`The previous release stays on disk; \`clikcode computer driver rollback\` goes back to it.\n`);
}

/** `clikcode computer driver install [--version x.y.z] [--force]` (`update` is the same: install the newest). */
export async function computerDriverInstall(options: { version?: string; force?: boolean } = {}, verb = 'installed'): Promise<void> {
  report(await installDriver(await defaultDeps(say), options), verb);
}

export async function computerDriverRollback(): Promise<void> {
  report(await rollbackDriver(await defaultDeps(say)), 'rolled back');
}

export async function computerDriverStatus(options: { offline?: boolean } = {}): Promise<void> {
  const status = await driverStatus(await defaultDeps(say), { checkLatest: !options.offline });
  const wayland = waylandSession();
  const stale = Boolean(status.version && driverVersionNotice(status.version, wayland));
  if (isJsonDefaultMode()) return emitResult({ computer: { driver: { ...status, ...(wayland ? { waylandNeeds: WAYLAND_DRIVER_VERSION, tooOldForWayland: stale } : {}) } } });
  if (!status.supported) return void process.stdout.write('Cua ships no cua-driver for this operating system or architecture.\n');
  const lines = [
    status.version ? `cua-driver ${status.version} at ${status.binary}` : 'cua-driver is not installed. Install it with: clikcode computer driver install',
    ...(status.releases.length ? [`releases on disk: ${status.releases.join(', ')}${status.current ? ` (active: ${status.current})` : ''}${status.previous ? `, rollback target: ${status.previous}` : ''}`] : []),
    ...(status.latest ? [`latest release: ${status.latest}${status.version ? (status.upToDate ? ' (you have it)' : ' (update with: clikcode computer driver update)') : ''}`] : status.latestError ? [`latest release: unknown (${status.latestError})`] : []),
    ...(stale ? [`This Wayland desktop needs cua-driver ${WAYLAND_DRIVER_VERSION} or newer: clikcode computer driver update`] : []),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

const gnomeShellVersion = (): Promise<string> => new Promise((resolve) => execFile('gnome-shell', ['--version'], { timeout: 10_000 }, (_error, stdout) => resolve(String(stdout ?? ''))));

/** `clikcode computer driver wayland-helper [--yes]`: run Cua's bundled GNOME Shell helper installer, on GNOME 45-49 only. */
export async function computerDriverWaylandHelper(options: { yes?: boolean } = {}): Promise<void> {
  const verdict = waylandHelperVerdict({ platform: process.platform, ...(process.env.XDG_CURRENT_DESKTOP ? { desktop: process.env.XDG_CURRENT_DESKTOP } : {}), ...(process.env.XDG_SESSION_TYPE ? { sessionType: process.env.XDG_SESSION_TYPE } : {}), gnomeShellOutput: await gnomeShellVersion() });
  if (!verdict.ok) throw new Error(verdict.reason);
  const deps = await defaultDeps(say);
  const dir = await activeReleaseDir(deps);
  const script = dir ? join(dir, 'wayland-helper', 'install.sh') : undefined;
  const present = script ? await import('node:fs/promises').then((fs) => fs.stat(script).then(() => true, () => false)) : false;
  if (!script || !present) throw new Error('The installed cua-driver has no bundled wayland-helper/install.sh. Install or update it first: clikcode computer driver install');
  if (!options.yes) {
    process.stdout.write(`GNOME ${verdict.major} is supported by the helper.\n${helperExplanation}\n\nRun it with: clikcode computer driver wayland-helper --yes\n`);
    return;
  }
  const code = await deps.runVisible('bash', [script], deps.env);
  if (code !== 0) throw new Error(`The helper installer exited with ${code}.`);
  if (isJsonDefaultMode()) return emitResult({ computer: { waylandHelper: { installed: true, logOutRequired: true } } });
  process.stdout.write('Installed. Log out of your desktop session and back in once so GNOME loads the helper. Afterwards `gnome-extensions info winrects@cua` should say State: ACTIVE.\n');
}
