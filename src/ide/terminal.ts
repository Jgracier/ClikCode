/** `clikcode ide-terminal <spec>`: one of a vendor's own interactive
 * commands, run in the editor's terminal. (Sign-ins never come here: they
 * run in the panel, gateway/login/vendor-sign-in.ts.) The editor opens a
 * terminal running this and answers the bridge when it exits; the exit code
 * is the answer. */
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { runNativeHarnessCommand } from '../harness/transport/native/command.js';
import { ensureNativeHarness } from '../harness/transport/native/inspect.js';
import { decodeTerminalSpec } from './protocol.js';

export async function runIdeTerminal(encoded: string): Promise<void> {
  const spec = decodeTerminalSpec(encoded);
  const harness = localHarnessForCommand(spec.command);
  if (!harness) throw new Error(`unknown harness ${spec.command}`);
  // The environment the bridge asked for (a vendor profile, a TurboFit
  // endpoint) is this terminal's own, so nothing is layered on top here.
  await ensureNativeHarness(harness);
  await runNativeHarnessCommand(harness, spec.argv, {});
}
