/** The settings menu. A setting with a few values is switched right here, the
 * current one marked; one with more opens its own list. Global and provider
 * defaults are `/settings global|provider ...`. */

import { applyToChat } from './setting-scope.js';
import type Conf from 'conf';
import { vendorFacingOptions } from '../../harness/options.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import { harnessSupportsEffort, harnessSupportsPermissionMode, localHarnessCapabilityManifest, localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { effortChoicesFor } from '../../harness/accounts/effort-choices.js';
import { VALID_PERMISSION_MODES } from '../../session/options.js';
import { readState } from '../../session/state/read.js';
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

/** A setting with at most this many values is changed in the menu itself;
 * one with more opens its own list. Four still fits on a row beside its
 * label; five no longer reads as "a choice", it reads as a list. */
const INLINE_MAX_CHOICES = 4;

const title = (value: string): string => value[0]!.toUpperCase() + value.slice(1);

export async function interactiveSettingsPicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const account = session?.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;

  // Few values: shown and switched right here. The same rule for every row,
  // so which settings are inline follows from how many values each has on
  // THIS harness -- grok's three effort levels flip in place, Claude's five
  // open a list.
  const efforts = harness && session && harnessSupportsEffort(harness)
    ? (await effortChoicesFor(harness, account, session.model)).values : [];
  const permissions = harness && session?.route !== 'gateway'
    ? VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode)) : [];
  const inline = (values: readonly string[], current: string | undefined, apply: (value: string) => Promise<void>) => (
    values.length >= 2 && values.length <= INLINE_MAX_CHOICES
      ? { inline: { choices: values.map((value) => ({ label: title(value), value })), current: current ?? values[0]!, apply } }
      : {}
  );

  const selected = await chooseOption(rl, 'Settings', [
    { label: 'Provider & account', detail: 'choose a harness, login, or add an account', value: 'provider' },
    ...(harness?.modelArgvPrefix ? [{ label: 'Model', detail: session?.model ?? 'provider default or model ID', value: 'model' }] : []),
    ...(efforts.length ? [{
      label: 'Reasoning effort', detail: session?.effort || 'provider-supported levels', value: 'effort',
      ...inline(efforts, session?.effort, (value) => applyToChat(id, 'effort', value)),
    }] : []),
    ...(permissions.length ? [{
      label: 'Permissions', detail: 'provider-supported approval behavior', value: 'permissions',
      ...inline(permissions, session?.permissionMode ?? 'ask', (value) => applyToChat(id, 'permissions', value)),
    }] : []),
    ...(harness && vendorFacingOptions(localHarnessCapabilityManifest(harness).options).length
      ? [{ label: `${harness.displayName} options`, detail: 'modes, tools, safety, and context', value: 'options' }] : []),
    {
      label: 'Quota failover', detail: 'switch accounts automatically, or not', value: 'failover',
      inline: {
        choices: [{ label: 'Auto-switch', value: 'auto' }, { label: 'Never', value: 'never' }],
        current: (session?.accountFailover ?? 'on-quota-exhausted') === 'never' ? 'never' : 'auto',
        apply: (value: string) => applyToChat(id, 'failover', value),
      },
    },
    { label: 'Show current setup', value: 'status' },
  ]);
  if (selected === 'provider') return interactiveEnginePicker(config, rl, id);
  else if (selected === 'model') await interactiveModelPicker(rl, id);
  else if (selected === 'effort') await interactiveEffortPicker(rl, id);
  else if (selected === 'permissions') await interactivePermissionPicker(rl, id);
  else if (selected === 'options') await interactiveHarnessOptionPicker(rl, id);
  else if (selected === 'failover') await interactiveFailoverPicker(rl, id);
  else if (selected === 'status') await aiSessionCommand(id, '/status');
  return undefined;
}
