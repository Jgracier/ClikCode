/** Whether the desktop keyring (the Secret Service's default collection) is
 * locked. A vendor that keeps its sign-in there (`keyringAuth`) and finds it
 * locked waits for an unlock prompt it cannot show: Factory Droid hung at ACP
 * `initialize` until ClikCode's 300 s stall limit, and `droid doctor` named
 * the cause ("credential storage read did not complete") (2026-11-24).
 *
 * Read over D-Bus without unlocking: the Locked property only. Linux only;
 * false when it cannot be read (no busctl, no Secret Service, other OS). */

import { KEYRING_DEADLINE_MS, runVendorCommand } from './vendor-probe.js';

const LOCKED_ARGV = ['--user', 'call', 'org.freedesktop.secrets', '/org/freedesktop/secrets/aliases/default',
  'org.freedesktop.DBus.Properties', 'Get', 'ss', 'org.freedesktop.Secret.Collection', 'Locked'];

/** busctl prints a variant boolean as `v b true`. */
export function lockedReading(stdout: string): boolean {
  return /\bb\s+true\b/.test(stdout);
}

export async function systemKeyringLocked(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const outcome = await runVendorCommand({
    gate: { inert: 'keyring lock state', keyring: true }, binary: 'busctl', argv: LOCKED_ARGV, environment: {}, deadlineMs: KEYRING_DEADLINE_MS,
  });
  return outcome.status === 'ok' && lockedReading(outcome.value.stdout);
}

/** The stall error for a keyringAuth vendor, naming the locked keyring. */
export function lockedKeyringMessage(name: string): string {
  return `${name} did not start: the system keyring is locked, and ${name} keeps its sign-in there. `
    + 'Unlock it (sign in to the desktop session, or open Passwords and Keys and unlock "Login"), then retry.';
}
