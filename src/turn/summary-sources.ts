/** Where a conversation's summaries are read from (session/conversation-summary.ts):
 * ClikCode's own agent memory, and a vendor thread's transcript, found in the
 * profile of the account that holds it. */
import type { AiHarnessAccount } from '../harness/definition.js';
import type { SummarySources } from '../session/conversation-summary.js';
import { locateNativeSessionFile } from '../session/discovery/registry.js';
import { stateDirectory } from '../session/store/paths.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { turnEnvironment } from './turn-environment.js';

export function summarySources(accounts: readonly AiHarnessAccount[]): SummarySources {
  return {
    stateDir: stateDirectory(),
    threadFile: async (thread) => {
      const harness = localHarnessForCommand(thread.harness);
      if (!harness) return undefined;
      const account = thread.accountId ? accounts.find((item) => item.id === thread.accountId) : undefined;
      return (await locateNativeSessionFile(harness, thread.id, thread.workspace ?? '', turnEnvironment(harness, account)))?.path;
    },
  };
}
