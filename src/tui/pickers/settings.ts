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
import { harnessSupportsEffort, harnessSupportsPermissionMode, localHarnessCapabilityManifest, localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { effortChoicesFor } from '../../harness/accounts/effort-choices.js';
import { nativeModelLabel } from '../../harness/accounts/model-catalog.js';
import { VALID_PERMISSION_MODES } from '../../session/options.js';
import { readState } from '../../session/state/read.js';
import { aiSettingsClearProvider, aiSettingsSetGlobal, aiSettingsSetProvider } from '../../commands/ai/settings.js';
import { lastPickerExit } from '../option-picker.js';
import { chooseOption } from './choose.js';
import { interactiveAccountPicker } from './account.js';
import { interactiveEffortPicker } from './effort.js';
import { interactiveEnginePicker } from './engine.js';
import { interactiveModelPicker } from './model.js';
import { interactiveHarnessOptionPicker } from './options.js';
import { interactivePermissionPicker } from './permissions.js';
import { applyToChat, settingLabel } from './setting-scope.js';
import { aiSessionCommand } from '../slash/handlers.js';
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
    const optionCount = harness ? vendorFacingOptions(localHarnessCapabilityManifest(harness).options, harness).length : 0;
    const setOptions = Object.keys(session.harnessOptions ?? {}).length;
    const values: Record<DefaultKey, string | undefined> = {
      model: session.model ?? undefined, effort: session.effort || undefined, permissions: session.permissionMode ?? 'ask', failover,
    };

    const rows: PickerOption<string>[] = [
      {
        label: 'Provider', detail: harness?.displayName ?? (session.route === 'gateway' ? 'ClikDeploy Gateway' : 'none chosen'), value: 'provider',
        ...(harness ? { actions: [{ label: `Use global defaults for ${harness.displayName}`, value: 'clear-provider' }] } : {}),
      },
      ...(!harness ? [
        {
          label: 'Every harness · permissions', detail: settingLabel(state.globalSettings.permissionMode), value: 'global-permissions',
          inline: {
            choices: VALID_PERMISSION_MODES.map((value) => ({ label: settingLabel(value), value })),
            current: state.globalSettings.permissionMode,
            apply: (value: string) => aiSettingsSetGlobal('permissions', value, false),
          },
        },
        {
          label: 'Every harness · failover', detail: settingLabel(state.globalSettings.accountFailover === 'never' ? 'never' : 'auto'), value: 'global-failover',
          inline: {
            choices: [{ label: 'Auto', value: 'auto' }, { label: 'Never', value: 'never' }],
            current: state.globalSettings.accountFailover === 'never' ? 'never' : 'auto',
            apply: (value: string) => aiSettingsSetGlobal('failover', value, false),
          },
        },
      ] : []),
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
      // One Plan mode for every harness that has a read-only planning mode,
      // whatever the vendor calls it.
      ...(harness?.planMode ? [{
        label: 'Plan mode', detail: 'read-only: plan, change nothing', value: 'plan',
        inline: {
          choices: [{ label: 'Off', value: 'off' }, { label: 'On', value: 'on' }],
          current: session.harnessOptions?.[harness.planMode.option] === harness.planMode.value ? 'on' : 'off',
          apply: (value: string) => aiSessionCommand(id, `/settings option ${harness.planMode!.option} ${value === 'on' ? String(harness.planMode!.value === true ? 'on' : harness.planMode!.value) : 'default'}`).then(() => undefined),
        },
      }] : []),
      ...(harness && optionCount ? [{ label: `${harness.displayName} options`, detail: setOptions ? `${setOptions} set` : `${optionCount} available`, value: 'options' }] : []),
      ...(harness ? [{ label: 'Tools & integrations', detail: harnessManagers(harness).map(([, manager]) => manager.label).join(', ') || 'MCP servers', value: 'tools' }] : []),
    ];

    const selected = await chooseOption(rl, 'Settings', rows, async (_row, action) => {
      if (action === 'clear-provider' && harness) {
        await aiSettingsClearProvider(harness.command, false);
        rl.panel?.('Defaults cleared', `${harness.displayName} now uses every-harness defaults.`);
        return;
      }
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
    // Esc in a sub-list leaves Settings; ← or a choice comes back here.
    if (lastPickerExit === 'escape') return id;
  }
}
