/** Settings: everything about how this chat runs, on one screen.
 *
 * One row per thing -- provider, account, model, effort, permissions,
 * failover -- then the harness's own options, its tools, and the defaults new
 * chats start from. A row with a few values is chosen right in the row
 * (←/→ or its number); one with more opens its own list and comes back here.
 * ← in a list goes back one screen, Esc leaves Settings.
 *
 * Tab on a row makes its value the default: for this harness, or for every
 * harness. That was only reachable before by typing
 * `/settings provider <id> <key> <value>`. */

import type Conf from 'conf';
import { vendorFacingOptions } from '../../harness/options.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { harnessSupportsEffort, harnessSupportsPermissionMode, localHarnessCapabilityManifest, localHarnessForCommand, modelDisplayId } from '../../runtime/lazy-bridge.js';
import { effortChoicesFor } from '../../harness/accounts/effort-choices.js';
import { nativeModelLabel } from '../../harness/accounts/model-catalog.js';
import { VALID_PERMISSION_MODES } from '../../session/options.js';
import { readState } from '../../session/state/read.js';
import { resolveDefaultSettings } from '../../session/state/settings.js';
import { aiSettingsSetGlobal, aiSettingsSetProvider } from '../../commands/ai/settings.js';
import { lastPickerExit } from '../option-picker.js';
import { chooseOption } from './choose.js';
import { interactiveAccountPicker } from './account.js';
import { interactiveEffortPicker } from './effort.js';
import { interactiveEnginePicker } from './engine.js';
import { interactiveModelPicker } from './model.js';
import { interactiveHarnessOptionPicker } from './options.js';
import { interactivePermissionPicker } from './permissions.js';
import { applyToChat, settingLabel } from './setting-scope.js';
import { harnessManagers, interactiveToolsPicker } from './tools.js';

/** A setting with at most this many values is chosen in its row; one with
 * more opens its own list. Four still reads as a choice beside its label. */
const INLINE_MAX_CHOICES = 4;

type DefaultKey = 'model' | 'effort' | 'permissions' | 'failover';

/** Tab on a row: keep this value for new chats. */
function defaultActions(harness: AiLocalHarnessDefinition | undefined, key: DefaultKey): PickerOption<string>['actions'] {
  return [
    ...(harness ? [{ label: `Make default for ${harness.displayName}`, value: `provider:${key}` }] : []),
    ...(key === 'model' ? [] : [{ label: 'Make default for every harness', value: `global:${key}` }]),
  ];
}

export async function interactiveSettingsPicker(config: Conf, rl: HarnessPrompter, startId: string): Promise<string | undefined> {
  let id = startId;
  for (;;) {
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id);
    if (!session) return id;
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    const efforts = harness && harnessSupportsEffort(harness) ? (await effortChoicesFor(harness, account, session.model)).values : [];
    const permissions = harness && session.route !== 'gateway'
      ? VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode)) : [];
    const failover = (session.accountFailover ?? 'on-quota-exhausted') === 'never' ? 'never' : 'auto';
    const inline = (choices: readonly { label: string; value: string }[], current: string, apply: (value: string) => Promise<void>) => (
      choices.length >= 2 && choices.length <= INLINE_MAX_CHOICES ? { inline: { choices, current, apply } } : {}
    );
    const optionCount = harness ? vendorFacingOptions(localHarnessCapabilityManifest(harness).options).length : 0;
    const setOptions = Object.keys(session.harnessOptions ?? {}).length;
    const values: Record<DefaultKey, string | undefined> = {
      model: session.model ?? undefined, effort: session.effort || undefined, permissions: session.permissionMode ?? 'ask', failover,
    };

    const rows: PickerOption<string>[] = [
      { label: 'Provider', detail: harness?.displayName ?? (session.route === 'gateway' ? 'ClikDeploy Gateway' : 'none chosen'), value: 'provider' },
      ...(harness ? [{ label: 'Account', detail: account?.label ?? 'none', value: 'account' }] : []),
      ...(harness?.modelArgvPrefix ? [{
        label: 'Model', detail: session.model ? nativeModelLabel(harness.command, session.model) ?? session.model : 'harness default', value: 'model',
        actions: defaultActions(harness, 'model'),
      }] : []),
      ...(efforts.length ? [{
        label: 'Effort', detail: settingLabel(session.effort ?? ''), value: 'effort', actions: defaultActions(harness, 'effort'),
        // Default is a real choice: no level sent, the harness decides.
        ...inline([{ label: 'Default', value: 'default' }, ...efforts.map((value) => ({ label: settingLabel(value), value }))],
          session.effort || 'default', (value) => applyToChat(id, 'effort', value)),
      }] : []),
      ...(permissions.length ? [{
        label: 'Permissions', detail: settingLabel(session.permissionMode ?? 'ask'), value: 'permissions', actions: defaultActions(harness, 'permissions'),
        ...inline(permissions.map((value) => ({ label: settingLabel(value), value })), session.permissionMode ?? 'ask', (value) => applyToChat(id, 'permissions', value)),
      }] : []),
      ...(harness ? [{
        label: 'Failover', detail: failover === 'auto' ? 'switch accounts when one runs out' : 'stop when an account runs out', value: 'failover',
        actions: defaultActions(harness, 'failover'),
        ...inline([{ label: 'Auto', value: 'auto' }, { label: 'Never', value: 'never' }], failover, (value) => applyToChat(id, 'failover', value)),
      }] : []),
      ...(harness && optionCount ? [{ label: `${harness.displayName} options`, detail: setOptions ? `${setOptions} set` : `${optionCount} available`, value: 'options' }] : []),
      ...(harness ? [{ label: 'Tools & integrations', detail: harnessManagers(harness).map(([, manager]) => manager.label).join(', ') || 'MCP servers', value: 'tools' }] : []),
      { label: 'Defaults for new chats', detail: harness ? `every harness, and ${harness.displayName}` : 'every harness', value: 'defaults' },
    ];

    const selected = await chooseOption(rl, 'Settings', rows, async (_row, action) => {
      const [scope, key] = action.split(':') as ['provider' | 'global', DefaultKey];
      const value = values[key];
      if (!value) return;
      if (scope === 'global') await aiSettingsSetGlobal(key, value, false);
      else if (harness) await aiSettingsSetProvider(harness.command, key, value, false);
      rl.panel?.('Default saved', `${settingLabel(key)} ${scope === 'global' ? 'for every harness' : `for ${harness?.displayName}`}: ${value}`);
    });
    if (selected === undefined) return id;
    if (selected === 'provider') id = await interactiveEnginePicker(config, rl, id) ?? id;
    else if (selected === 'account') id = await interactiveAccountPicker(rl, id) ?? id;
    else if (selected === 'model') await interactiveModelPicker(rl, id);
    else if (selected === 'effort') await interactiveEffortPicker(rl, id);
    else if (selected === 'permissions') await interactivePermissionPicker(rl, id);
    else if (selected === 'options') await interactiveHarnessOptionPicker(rl, id);
    else if (selected === 'tools' && harness) await interactiveToolsPicker(rl, id, harness);
    else if (selected === 'defaults') await interactiveDefaultsPicker(rl, harness);
    // Esc in a sub-list leaves Settings; ← or a choice comes back here.
    if (lastPickerExit === 'escape') return id;
  }
}

/** The values new chats start from: for every harness, and for this one.
 * (A new chat also carries the last chat's settings; these are what a
 * harness starts with when a chat moves to it, or is new to it.) */
async function interactiveDefaultsPicker(rl: HarnessPrompter, harness: AiLocalHarnessDefinition | undefined): Promise<void> {
  for (;;) {
    const state = await readState();
    const global = state.globalSettings;
    const own = harness ? resolveDefaultSettings(state, harness.provider) : undefined;
    const overrides = harness ? state.providerSettings[harness.provider] ?? {} : {};
    const failoverWord = (value: string | undefined): string => value === 'never' ? 'never' : 'auto';
    const permissionChoices = VALID_PERMISSION_MODES.map((value) => ({ label: settingLabel(value), value }));
    const failoverChoices = [{ label: 'Auto', value: 'auto' }, { label: 'Never', value: 'never' }];
    const rows: PickerOption<string>[] = [
      {
        label: 'Every harness · permissions', detail: settingLabel(global.permissionMode), value: 'g-permissions',
        inline: { choices: permissionChoices, current: global.permissionMode, apply: (value) => aiSettingsSetGlobal('permissions', value, false) },
      },
      {
        label: 'Every harness · failover', detail: failoverWord(global.accountFailover), value: 'g-failover',
        inline: { choices: failoverChoices, current: failoverWord(global.accountFailover), apply: (value) => aiSettingsSetGlobal('failover', value, false) },
      },
      ...(harness && own ? [
        { label: `${harness.displayName} · model`, detail: overrides.model ? modelDisplayId(harness, overrides.model) : 'harness default', value: 'p-model' },
        {
          label: `${harness.displayName} · permissions`, detail: settingLabel(own.permissionMode), value: 'p-permissions',
          inline: {
            choices: permissionChoices.filter((choice) => harnessSupportsPermissionMode(harness, choice.value as never)),
            current: own.permissionMode, apply: (value: string) => aiSettingsSetProvider(harness.command, 'permissions', value, false),
          },
        },
        {
          label: `${harness.displayName} · failover`, detail: failoverWord(own.accountFailover), value: 'p-failover',
          inline: { choices: failoverChoices, current: failoverWord(own.accountFailover), apply: (value: string) => aiSettingsSetProvider(harness.command, 'failover', value, false) },
        },
        { label: `Clear ${harness.displayName} defaults`, detail: 'use the every-harness values', value: 'p-clear' },
      ] : []),
    ];
    const selected = await chooseOption(rl, 'Defaults for new chats', rows);
    if (selected === undefined) return;
    if (selected === 'p-model' && harness) {
      const { nativeModelCatalogForPicker } = await import('../../harness/accounts/model-catalog.js');
      const { modelRow } = await import('./model.js');
      const catalog = await nativeModelCatalogForPicker(harness);
      const model = await chooseOption(rl, `${harness.displayName} default model`, catalog.models.map((item) => modelRow(harness, catalog, item, overrides.model)));
      if (model) await aiSettingsSetProvider(harness.command, 'model', model, false);
    } else if (selected === 'p-clear' && harness) {
      const { aiSettingsClearProvider } = await import('../../commands/ai/settings.js');
      await aiSettingsClearProvider(harness.command, false);
    }
    if (lastPickerExit === 'escape') return;
  }
}
