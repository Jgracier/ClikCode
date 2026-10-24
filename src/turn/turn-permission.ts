/** The permission mode a turn runs with, which is not always the one the chat has chosen.
 *
 * A harness can refuse a mode on this machine (Claude Code refuses bypass as root). The chat keeps
 * the mode the user chose -- it is the chat's setting, and a chat moved to a machine that allows it
 * is back to what was chosen -- and the turn runs with the nearest mode this harness will take
 * here. Nothing is saved: the downgrade is a fact about this machine and this run. */
import type { AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../harness/definition.js';
import { harnessSupportsPermissionMode } from '../runtime/lazy-bridge.js';

/** `chosen` as this harness takes it here (`ask` when the chat has chosen none). */
export function turnPermissionMode(harness: AiLocalHarnessDefinition, chosen: AiHarnessPermissionMode | undefined): AiHarnessPermissionMode {
  const mode = chosen ?? 'ask';
  if (mode === 'bypass' && harness.bypassRefusedAsRoot && !harnessSupportsPermissionMode(harness, 'bypass')) {
    return harnessSupportsPermissionMode(harness, 'auto') ? 'auto' : 'ask';
  }
  return mode;
}
