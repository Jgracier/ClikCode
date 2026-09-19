import { acpArgvForHarness } from './acp-client.js';
import type { AiLocalHarnessDefinition } from './types.js';

export type HarnessTurnTransport = 'codex-app-server' | 'acp' | 'structured-cli' | 'text-cli';

/** One transport decision for every harness. Provider definitions remain
 * declarative; orchestration no longer grows another command-name branch each
 * time a harness adopts ACP or another shared protocol. */
export function harnessTurnTransport(harness: AiLocalHarnessDefinition, hasImages = false): HarnessTurnTransport {
  if (harness.command === 'codex') return 'codex-app-server';
  if (!hasImages && acpArgvForHarness(harness.command)) return 'acp';
  return harness.turn?.output === 'text' ? 'text-cli' : 'structured-cli';
}
