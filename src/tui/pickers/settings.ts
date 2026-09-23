/** The settings menu, and the scope (global or per-provider) a chosen
 * setting is written at. */

import { applyToChat } from './setting-scope.js';
import type Conf from 'conf';
import { vendorFacingOptions } from '../../harness/options.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import { harnessSupportsEffort, localHarnessCapabilityManifest, localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { aiSettingsSetGlobal, aiSettingsSetProvider } from '../../commands/ai/settings.js';
import { aiSessionCommand } from '../slash/handlers.js';
import { chooseOption } from './choose.js';
import { interactiveEffortPicker } from './effort.js';
import { interactiveEnginePicker } from './engine.js';
import { interactiveModelPicker } from './model.js';
import { interactiveHarnessOptionPicker } from './options.js';
import { interactivePermissionPicker } from './permissions.js';

async function interactiveFailoverPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const current = session.accountFailover ?? 'on-quota-exhausted';
  const selected = await chooseOption(rl, 'Quota failover', [
    { label: 'Auto-switch accounts', detail: `· switch to another ready account of the same provider when quota runs out${current === 'on-quota-exhausted' ? ' · current' : ''}`, value: 'auto' },
    { label: 'Never', detail: `· stop and ask instead of switching${current === 'never' ? ' · current' : ''}`, value: 'never' },
  ]);
  if (selected) await applyToChat(id, 'failover', selected);
}

export async function interactiveSettingsPicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const selected = await chooseOption(rl, 'Settings', [
    { label: 'Provider & account', detail: 'choose a harness, login, or add an account', value: 'provider' },
    ...(harness?.modelArgvPrefix ? [{ label: 'Model', detail: 'provider default or model ID', value: 'model' }] : []),
    ...(harness && harnessSupportsEffort(harness) ? [{ label: 'Reasoning effort', detail: 'provider-supported levels', value: 'effort' }] : []),
    ...(harness?.permissionModes?.length ? [{ label: 'Permissions', detail: 'provider-supported approval behavior', value: 'permissions' }] : []),
    ...(harness && vendorFacingOptions(localHarnessCapabilityManifest(harness).options).length
      ? [{ label: `${harness.displayName} options`, detail: 'modes, tools, safety, and context', value: 'options' }] : []),
    { label: 'Quota failover', detail: 'switch accounts automatically, or not', value: 'failover' },
    { label: 'Show current setup', value: 'status' },
  ] as const);
  if (selected === 'provider') return interactiveEnginePicker(config, rl, id);
  else if (selected === 'model') await interactiveModelPicker(rl, id);
  else if (selected === 'effort') await interactiveEffortPicker(rl, id);
  else if (selected === 'permissions') await interactivePermissionPicker(rl, id);
  else if (selected === 'options') await interactiveHarnessOptionPicker(rl, id);
  else if (selected === 'failover') await interactiveFailoverPicker(rl, id);
  else if (selected === 'status') await aiSessionCommand(id, '/status');
  return undefined;
}
