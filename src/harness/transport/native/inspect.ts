/** Is the vendor CLI installed, at what version, and install it if not --
 * cached, because a picker asks this about every harness at once. */

import { spawnPortable as spawn, terminatePortable } from '../spawn.js';
import { installFailureTail, runCaptured, startSpinner } from '../../install-progress.js';
import { installInstructions } from '../../install-hints.js';
import { NativeHarnessSpec, binaryOnPath } from './binary.js';

interface NativeHarnessInspection {
  installed: boolean;
  version?: string;
  error?: string;
}

// Installation status barely ever changes mid-session -- a user isn't
// installing/uninstalling a CLI between one /provider open and the next --
// but every call here spawns a real subprocess per harness with its own
// timeout, and every /provider open queries all ~20 of them at once. With
// no cache, that meant however long the single slowest one took (up to its
// timeout) on *every single open* -- the concrete "a slash option takes a
// few seconds to render" report, since /provider is one of the most common
// commands. 60s is long enough to make repeated opens near-instant without
// meaningfully delaying noticing a harness someone actually just installed.
const inspectionCache = new Map<string, { at: number; result: NativeHarnessInspection }>();

const pickerInspectionCache = new Map<string, { at: number; result: NativeHarnessInspection }>();

const INSPECTION_CACHE_TTL_MS = 60_000;

/** Picker-safe inspection: PATH lookup returns quickly. Do not start version
 * probes here: opening /provider can cover ~20 harnesses, and a burst of that
 * many background subprocesses still competes with terminal rendering even
 * though the picker no longer awaits them. */
export async function inspectNativeHarnessForPicker(spec: NativeHarnessSpec): Promise<NativeHarnessInspection> {
  if (spec.surface === 'editor-extension') return { installed: false, error: 'editor-extension-only' };
  const cached = inspectionCache.get(spec.command);
  if (cached && Date.now() - cached.at < INSPECTION_CACHE_TTL_MS) return cached.result;
  const pickerCached = pickerInspectionCache.get(spec.command);
  if (pickerCached && Date.now() - pickerCached.at < INSPECTION_CACHE_TTL_MS) return pickerCached.result;
  const result: NativeHarnessInspection = { installed: await binaryOnPath(spec.binary) };
  // A PATH-only answer must not masquerade as a full inspection (it has no
  // version), so an installed result stays in the picker's own cache. "Not
  // installed" is the same answer for both, so it can serve both.
  pickerInspectionCache.set(spec.command, { at: Date.now(), result });
  if (!result.installed) inspectionCache.set(spec.command, { at: Date.now(), result });
  return result;
}

/** Forget cached availability, e.g. right after installing a harness. */
function clearNativeHarnessInspectionCache(command?: string): void {
  if (command === undefined) {
    inspectionCache.clear();
    pickerInspectionCache.clear();
    return;
  }
  inspectionCache.delete(command);
  pickerInspectionCache.delete(command);
}

/** Inspect availability without installing, logging in, or entering a vendor TUI. */
export async function inspectNativeHarness(spec: NativeHarnessSpec, timeoutMs = 5_000): Promise<NativeHarnessInspection> {
  if (spec.surface === 'editor-extension') return { installed: false, error: 'editor-extension-only' };
  const cached = inspectionCache.get(spec.command);
  if (cached && Date.now() - cached.at < INSPECTION_CACHE_TTL_MS) return cached.result;
  const result = await inspectNativeHarnessUncached(spec, timeoutMs);
  inspectionCache.set(spec.command, { at: Date.now(), result });
  pickerInspectionCache.set(spec.command, { at: Date.now(), result });
  return result;
}

async function inspectNativeHarnessUncached(spec: NativeHarnessSpec, timeoutMs: number): Promise<NativeHarnessInspection> {
  if (!await binaryOnPath(spec.binary)) return { installed: false };
  return new Promise((resolve) => {
    const child = spawn(spec.binary, [...(spec.versionArgv ?? ['--version'])], {
      stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    let text = '';
    let settled = false;
    const finish = (result: NativeHarnessInspection): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const collect = (chunk: Buffer | string): void => {
      if (text.length < 4096) text += String(chunk);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.once('error', (error) => finish({ installed: true, error: error.message }));
    child.once('exit', (code, signal) => {
      const version = text.trim().split(/\r?\n/).find(Boolean)?.trim();
      if (code === 0) finish({ installed: true, ...(version ? { version } : {}) });
      else finish({ installed: true, ...(version ? { version } : {}), error: signal ? `version probe stopped (${signal})` : `version probe exited ${code ?? 1}` });
    });
    const timer = setTimeout(() => {
      terminatePortable(child);
      finish({ installed: true, error: 'version probe timed out' });
    }, timeoutMs);
    timer.unref();
  });
}

/** Install only a vendor-declared npm package; never infer package names from user input. */
export async function ensureNativeHarness(spec: NativeHarnessSpec): Promise<void> {
  if (spec.surface === 'editor-extension') {
    throw new Error(`${spec.displayName} is an editor extension, not a standalone terminal harness; ClikCode cannot broker it as a native TUI.`);
  }
  if (await binaryOnPath(spec.binary)) return;
  if (!spec.npmPackage) throw new Error(installInstructions(spec.displayName, spec.command, spec.binary));
  // Captured, not inherited: npm's progress bars, deprecation warnings and
  // audit footer used to land in the middle of the UI, several screens of it
  // on a phone, for a decision the user has already made.
  const spinner = startSpinner(`Installing ${spec.displayName}…`);
  let result;
  try { result = await runCaptured('npm', ['install', '--global', spec.npmPackage]); }
  catch (error) { spinner.stop(); throw error; }
  if (result.code !== 0) {
    spinner.stop();
    const tail = installFailureTail(result.output);
    throw new Error(`Could not install ${spec.displayName} (npm exited ${result.code ?? 'abnormally'}).${tail ? `\n${tail}` : ''}`);
  }
  spinner.stop(`Installed ${spec.displayName}.`);
  clearNativeHarnessInspectionCache(spec.command);
  if (!await binaryOnPath(spec.binary)) throw new Error(`${spec.displayName} installed but its binary is not on PATH; open a new terminal and retry.`);
}
