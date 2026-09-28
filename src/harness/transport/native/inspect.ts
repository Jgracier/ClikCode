/** Is the vendor CLI installed, at what version, and install it if not --
 * cached, because a picker asks this about every harness at once. */

import { spawnPortable as spawn, terminatePortable } from '../spawn.js';
import { binaryFingerprint, harnessBinaryIdentity, rememberVersion, rememberedVersion, resetVersionMemo, saveVersionMemo } from './version-memo.js';
import { resolveBinaryPath } from './binary.js';
import { ensureHarnessInstalled, type HarnessInstallReporter } from './install.js';
import { NativeHarnessSpec, binaryOnPath } from './binary.js';

interface NativeHarnessInspection {
  installed: boolean;
  version?: string;
  error?: string;
}

/** Keyed on the binary's identity, not on a clock.
 *
 * This was 60 seconds: long enough that a harness installed or updated in
 * another terminal kept reporting its old state (or its old version) for a
 * minute, and short enough that an unchanged machine re-inspected on every
 * other /provider open. The answer is a fact about a file -- whether it is on
 * PATH, and what it says its version is -- and the file's identity is a PATH
 * walk and a stat away, so that is what decides. `undefined` identity is the
 * "not installed" answer, and it is re-checked the same way: the moment the
 * binary appears, the identity stops matching. */
const inspectionCache = new Map<string, { identity: string | undefined; result: NativeHarnessInspection }>();

const pickerInspectionCache = new Map<string, { identity: string | undefined; result: NativeHarnessInspection }>();

/** Picker-safe inspection: PATH lookup returns quickly. Do not start version
 * probes here: opening /provider can cover ~20 harnesses, and a burst of that
 * many background subprocesses still competes with terminal rendering even
 * though the picker no longer awaits them. */
export async function inspectNativeHarnessForPicker(spec: NativeHarnessSpec): Promise<NativeHarnessInspection> {
  if (spec.surface === 'editor-extension') return { installed: false, error: 'editor-extension-only' };
  const identity = await harnessBinaryIdentity(spec.binary);
  const cached = inspectionCache.get(spec.command);
  if (cached && cached.identity === identity) return cached.result;
  const pickerCached = pickerInspectionCache.get(spec.command);
  if (pickerCached && pickerCached.identity === identity) return pickerCached.result;
  const result: NativeHarnessInspection = { installed: identity !== undefined };
  // A PATH-only answer must not masquerade as a full inspection (it has no
  // version), so an installed result stays in the picker's own cache. "Not
  // installed" is the same answer for both, so it can serve both.
  pickerInspectionCache.set(spec.command, { identity, result });
  if (!result.installed) inspectionCache.set(spec.command, { identity, result });
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
  // The binary just changed on disk, so its fingerprint has too -- but an
  // install that lands on the same mtime (a reinstall of the same build)
  // would still match. Forgetting is cheaper than reasoning about that.
  resetVersionMemo();
}

/** Inspect availability without installing, logging in, or entering a vendor TUI. */
export async function inspectNativeHarness(spec: NativeHarnessSpec, timeoutMs = 5_000): Promise<NativeHarnessInspection> {
  if (spec.surface === 'editor-extension') return { installed: false, error: 'editor-extension-only' };
  // What the binary is, before deciding whether it needs running. A version
  // string is a fact about a file: same path, mtime and size means the same
  // answer, however long ago it was learned.
  const fingerprint = await binaryFingerprint(await resolveBinaryPath(spec.binary));
  const identity = fingerprint ? `${fingerprint.path}:${fingerprint.mtimeMs}:${fingerprint.size}` : undefined;
  const cached = inspectionCache.get(spec.command);
  if (cached && cached.identity === identity) return cached.result;
  const remembered = await rememberedVersion(spec.command, fingerprint);
  if (remembered) {
    const result: NativeHarnessInspection = {
      installed: true,
      ...(remembered.version ? { version: remembered.version } : {}),
      ...(remembered.error ? { error: remembered.error } : {}),
    };
    inspectionCache.set(spec.command, { identity, result });
    pickerInspectionCache.set(spec.command, { identity, result });
    return result;
  }
  const result = await inspectNativeHarnessUncached(spec, timeoutMs, fingerprint);
  // A timed-out probe says nothing durable about the binary, so it is not
  // cached at all -- the next ask probes again instead of repeating a guess.
  if (result.error !== 'version probe timed out') {
    inspectionCache.set(spec.command, { identity, result });
    pickerInspectionCache.set(spec.command, { identity, result });
  }
  // Only a completed probe is written down. A timeout says nothing durable
  // about the binary, and remembering it would make one slow run permanent.
  if (fingerprint && result.installed && result.error !== 'version probe timed out') {
    await rememberVersion(spec.command, fingerprint, {
      ...(result.version ? { version: result.version } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    await saveVersionMemo().catch(() => undefined);
  }
  return result;
}

async function inspectNativeHarnessUncached(
  spec: NativeHarnessSpec, timeoutMs: number,
  fingerprint?: { path: string; mtimeMs: number; size: number },
): Promise<NativeHarnessInspection> {
  if (!(fingerprint ?? await binaryOnPath(spec.binary))) return { installed: false };
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
    // `close`: exit can fire before the pipes drain (see captureNativeHarnessOutput).
    child.once('close', (code, signal) => {
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

/** Install the harness if it is missing (install.ts), and forget what was
 * cached about it when that happened. True when it was installed just now. */
export async function ensureNativeHarness(
  spec: Parameters<typeof ensureHarnessInstalled>[0], options: { reporter?: HarnessInstallReporter } = {},
): Promise<boolean> {
  const installed = await ensureHarnessInstalled(spec, options);
  if (installed) clearNativeHarnessInspectionCache(spec.command);
  return installed;
}
