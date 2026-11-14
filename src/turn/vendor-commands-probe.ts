/** Asks a harness's ACP agent what commands it has, before a chat on it has
 * run a turn: the `/` menu lists them as soon as the chat is on the harness.
 * One short metadata session (cleaned up like the model probe's), at most
 * once a week per harness; a turn's own announcement replaces it anyway. */

import { quiet } from '../runtime/lifecycle-log.js';
import { acpAvailableCommands } from '../harness/transport/acp-client.js';
import { acpDiscoverySession, acpProbeArgv, queryAcp } from '../harness/accounts/acp-query.js';
import { nativeProfileEnvironment } from '../harness/transport/profile-environment.js';
import { sleep } from '../runtime/sleep.js';
import { knownVendorCommands, rememberVendorCommands, vendorCommandsCheckedAt } from './vendor-commands.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessAvailableCommand } from '../harness/events/turn-observer.js';

const ASK_AGAIN_MS = 7 * 24 * 3_600_000;
/** Agents announce their commands just after `session/new`, not in its answer. */
const ANNOUNCE_WAIT_MS = 3_000;

const asking = new Set<string>();

export async function probeVendorCommands(
  harness: AiLocalHarnessDefinition | undefined, account: AiHarnessAccount | undefined, now = Date.now(),
): Promise<void> {
  if (!harness?.acp || asking.has(harness.command)) return;
  const checked = vendorCommandsCheckedAt(harness.command);
  if (checked !== undefined && (knownVendorCommands(harness.command).length || now - checked < ASK_AGAIN_MS)) return;
  asking.add(harness.command);
  try {
    let heard: HarnessAvailableCommand[] | undefined;
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    const answered = await queryAcp(harness.acp.binary ?? harness.binary, [...harness.acp.argv, ...await acpProbeArgv(harness, account)], environment,
      async (request) => {
        await acpDiscoverySession(request);
        for (let waited = 0; !heard && waited < ANNOUNCE_WAIT_MS; waited += 100) await sleep(100);
        return true;
      }, 20_000, {
        discovery: harness,
        onNotification: (method, params) => {
          if (method !== 'session/update' || !params?.update) return;
          const commands = acpAvailableCommands(params.update);
          if (commands?.length) heard = commands;
        },
      });
    // An agent that could not be asked (signed out, not installed) is asked another time.
    if (answered) await rememberVendorCommands(harness.command, heard ?? [], { probed: true });
  } catch (error) { quiet('turn/vendor-commands-probe')(error); } finally { asking.delete(harness.command); }
}
