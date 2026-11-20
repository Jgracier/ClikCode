/** Asks a harness's ACP agent what commands it has, before a chat on it has
 * run a turn: the `/` menu lists them as soon as the chat is on the harness.
 * One short metadata session (cleaned up like the model probe's), at most
 * once a week per harness; a turn's own announcement replaces it anyway.
 * Only for an account with a sign-in on disk (the background gate): a chat
 * with no account is not asked under the user's own home, an account with
 * no credential is marked as needing a sign-in, and an agent that failed to
 * answer is held off (background-outcome.ts). */

import { quiet } from '../runtime/lifecycle-log.js';
import { acpAvailableCommands } from '../harness/transport/acp-client.js';
import { acpDiscoverySession, acpProbeArgv, queryAcp } from '../harness/accounts/acp-query.js';
import { nativeProfileEnvironment } from '../harness/transport/profile-environment.js';
import { mayRunInBackground } from '../harness/accounts/vendor-probe.js';
import { heldOff, markAccountNeedsSignIn, recordBackgroundOutcome } from '../harness/accounts/background-outcome.js';
import { sleep } from '../runtime/sleep.js';
import { knownVendorCommands, rememberVendorCommands, vendorCommandsCheckedAt } from './vendor-commands.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessAvailableCommand } from '../harness/events/turn-observer.js';

const ASK_AGAIN_MS = 7 * 24 * 3_600_000;
/** Agents announce their commands just after `session/new`, not in its answer. */
const ANNOUNCE_WAIT_MS = 3_000;

const asking = new Set<string>();

/** True when it learnt commands the menu did not have. */
export async function probeVendorCommands(
  harness: AiLocalHarnessDefinition | undefined, account: AiHarnessAccount | undefined, now = Date.now(),
): Promise<boolean> {
  if (!harness?.acp || !account || account.status !== 'ready' || asking.has(harness.command)) return false;
  const checked = vendorCommandsCheckedAt(harness.command);
  if (checked !== undefined && (knownVendorCommands(harness.command).length || now - checked < ASK_AGAIN_MS)) return false;
  asking.add(harness.command);
  try {
    let heard: HarnessAvailableCommand[] | undefined;
    const environment = nativeProfileEnvironment(account.nativeProfile);
    if (!await mayRunInBackground(harness, environment)) {
      await markAccountNeedsSignIn(account);
      return false;
    }
    const held = `commands:${harness.command}:${account.nativeProfile?.path ?? account.id}`;
    if (await heldOff(held, now)) return false;
    const answered = await queryAcp(harness.acp.binary ?? harness.binary, [...harness.acp.argv, ...await acpProbeArgv(harness, account)], environment,
      async (request) => {
        await acpDiscoverySession(request);
        for (let waited = 0; !heard && waited < ANNOUNCE_WAIT_MS; waited += 100) await sleep(100);
        return true;
      }, 20_000, {
        gate: harness,
        discovery: harness,
        onNotification: (method, params) => {
          if (method !== 'session/update' || !params?.update) return;
          const commands = acpAvailableCommands(params.update);
          if (commands?.length) heard = commands;
        },
      });
    // An agent that could not be asked is asked another time, after a while.
    await recordBackgroundOutcome(held, answered ? 'ok' : 'failed', now);
    if (answered) await rememberVendorCommands(harness.command, heard ?? [], { probed: true });
    return Boolean(heard?.length);
  } catch (error) { quiet('turn/vendor-commands-probe')(error); return false; } finally { asking.delete(harness.command); }
}
