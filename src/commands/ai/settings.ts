/** Durable settings, written globally or for one provider. */

import { emitJson } from '../../cli/structured-output.js';
import type { HarnessDefaultSettings } from '../../session/model.js';
import { localHarnessForCommand, localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { applyDefaultSetting } from '../../session/options.js';
import { assertRealModel } from './sessions.js';

/** Read-only view of the defaults every new chat is built from. */
/** Applies to every provider that doesn't have its own override. */
export async function aiSettingsSetGlobal(key: string, value: string, emit = true): Promise<void> {
  const state = await readState();
  applyDefaultSetting(state.globalSettings, key, value);
  await writeState(state);
  if (emit) emitJson({ globalSettings: state.globalSettings });
}

/** Overrides the global default for one provider only; existing sessions are untouched. */
export async function aiSettingsSetProvider(providerOrHarness: string, key: string, value: string, emit = true): Promise<void> {
  const state = await readState();
  const harness = localHarnessForCommand(providerOrHarness) ?? localHarnessForProvider(providerOrHarness);
  if (!harness) throw new Error(`unknown provider "${providerOrHarness}"`);
  // `model` present (even unset) marks this as a provider entry, where a
  // model default is allowed; a provider with no entry yet refused one.
  const entry: Partial<HarnessDefaultSettings & { model: string }> = { model: undefined, ...state.providerSettings[harness.provider] };
  applyDefaultSetting(entry, key, value, harness);
  if (key.toLowerCase() === 'model' && entry.model) await assertRealModel(harness, undefined, entry.model);
  state.providerSettings[harness.provider] = entry;
  await writeState(state);
  if (emit) emitJson({ provider: harness.provider, settings: entry });
}

/** Removes every override for one provider, falling back to the global defaults. */
export async function aiSettingsClearProvider(providerOrHarness: string, emit = true): Promise<void> {
  const state = await readState();
  const harness = localHarnessForCommand(providerOrHarness) ?? localHarnessForProvider(providerOrHarness);
  if (!harness) throw new Error(`unknown provider "${providerOrHarness}"`);
  delete state.providerSettings[harness.provider];
  await writeState(state);
  if (emit) emitJson({ provider: harness.provider, settings: {} });
}
