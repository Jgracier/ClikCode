/** Asking "apply to this chat, this provider, or globally?" and doing it.
 *
 * Its own module because the effort and permission pickers both need it while
 * settings.ts pulls both of those pickers in -- so defining it in settings.ts
 * made the three depend on each other in a loop. Same shape as
 * preferredAccountId: a helper every sibling needs, stranded in whichever
 * sibling happened to define it first.
 */

import type { HarnessPrompter } from '../../harness/prompter.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { aiSettingsSetGlobal, aiSettingsSetProvider } from '../../commands/ai/settings.js';
import { aiSessionCommand } from '../slash/handlers.js';
import { chooseOption } from './choose.js';

export async function applySettingScope(
  rl: HarnessPrompter, id: string, key: 'effort' | 'permissions' | 'failover' | 'model', value: string,
): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const scope = await chooseOption(rl, 'Apply to', [
    { label: 'This chat only', value: 'session' as const },
    { label: 'Global default', detail: 'every provider, unless overridden', value: 'global' as const },
    ...(harness ? [{ label: `${harness.displayName} default`, detail: 'this provider only', value: 'provider' as const }] : []),
  ]);
  if (!scope) return;
  if (scope === 'session') {
    if (key === 'failover') await aiSessionCommand(id, `/accounts failover ${value}`);
    else await aiSessionCommand(id, `/${key} ${value}`);
  } else if (scope === 'global') {
    await aiSettingsSetGlobal(key, value);
  } else if (harness) {
    await aiSettingsSetProvider(harness.command, key, value);
  }
}
