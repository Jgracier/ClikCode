/** `clikcode acp`: add an Agent Client Protocol harness the catalog does not ship. */

import type { AiCustomAcpHarnessInput } from '../harness/definition.js';
import { emitResult } from '../cli/structured-output.js';
import { addCustomAcpHarness, readCustomAcpConfig, removeCustomAcpHarness } from '../harness/custom-acp.js';

export async function acpList(): Promise<void> {
  const harnesses = await readCustomAcpConfig();
  emitResult({ harnesses });
}

export async function acpAdd(command: string, binary: string, argv: string[], options: { name?: string; provider?: string }): Promise<void> {
  const definition: AiCustomAcpHarnessInput = {
    command, binary, argv,
    ...(options.name ? { displayName: options.name } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
  };
  const added = await addCustomAcpHarness(definition);
  emitResult({
    added: { command: added.command, binary: added.binary, argv: [...(added.acp?.argv ?? [])], displayName: added.displayName, provider: added.provider },
  });
}

export async function acpRemove(command: string): Promise<void> {
  const removed = await removeCustomAcpHarness(command);
  if (!removed) throw new Error(`no custom ACP harness named "${command}"`);
  emitResult({ removed: command.trim().replace(/^\//, '').toLowerCase() });
}
