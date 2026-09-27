/** `clikcode ide-terminal <spec>`: what the IDE bridge could not do without a
 * terminal, run in the editor's. A vendor's sign-in (the one a turn or a
 * picker asked for), or one of the vendor's own interactive commands. The
 * editor opens a terminal running this and answers the bridge when it exits;
 * the exit code is the answer. */
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { runNativeHarnessCommand } from '../harness/transport/native/command.js';
import { ensureNativeHarness } from '../harness/transport/native/inspect.js';
import { decodeTerminalSpec } from './protocol.js';

export async function runIdeTerminal(encoded: string): Promise<void> {
  const spec = decodeTerminalSpec(encoded);
  const harness = localHarnessForCommand(spec.command);
  if (!harness) throw new Error(`unknown harness ${spec.command}`);
  // The environment the bridge asked for (a vendor profile, a TurboFit
  // endpoint) is this terminal's own, so nothing is layered on top here.
  if (spec.mode === 'login') {
    await loginNativeHarness({ ...harness, loginArgv: spec.argv }, {});
    return;
  }
  await ensureNativeHarness(harness);
  await runNativeHarnessCommand(harness, spec.argv, {});
}
