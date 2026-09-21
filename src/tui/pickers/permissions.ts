/** Choosing how tool calls are approved, from `clikcode permissions` and from
 * in-chat `/permissions`. */

import type { AiHarnessPermissionMode, HarnessPrompter } from '../../harness/types.js';
import { harnessSupportsPermissionMode, localHarnessForCommand } from '../../harness/transport/native-protocol.js';
import { readState } from '../../session/state/read.js';
import { TERMINAL } from '../active-terminal.js';
import { TerminalHarnessPrompter } from '../prompter.js';
import { terminalUiSupported } from '../capabilities.js';
import { VALID_PERMISSION_MODES } from '../../session/options.js';
import { aiSettingsSetGlobal } from '../../commands/ai.js';
import { aiSessionCommand } from '../slash/handlers.js';
import { chooseOption } from './choose.js';
import { applySettingScope } from './settings.js';

/** Edit the active conversation's approval behavior from the top-level
 * `clikcode permissions` command. The same picker and provider capability
 * checks back the in-chat `/permissions` command, so the two surfaces cannot
 * drift. With no conversation yet, a selection becomes the global default. */
export async function aiPermissions(mode?: string): Promise<void> {
  const normalizedMode = mode?.trim().toLowerCase() as AiHarnessPermissionMode | undefined;
  if (normalizedMode && !VALID_PERMISSION_MODES.includes(normalizedMode)) {
    throw new Error('permissions must be ask, bypass, or auto');
  }
  const state = await readState();
  const session = [...state.sessions]
    .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.updatedAt.localeCompare(left.updatedAt))[0];
  if (normalizedMode) {
    if (session) await aiSessionCommand(session.id, `/permissions ${normalizedMode}`);
    else await aiSettingsSetGlobal('permissions', normalizedMode);
    return;
  }
  if (!terminalUiSupported()) throw new Error('an ANSI-capable interactive terminal is required; use `clikcode permissions ask|bypass|auto`');
  const rl = new TerminalHarnessPrompter();
  TERMINAL.active = rl;
  try {
    if (session) {
      const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
      rl.render?.(session, account);
      await interactivePermissionPicker(rl, session.id);
    } else {
      const selected = await chooseOption(rl, 'Choose permissions', VALID_PERMISSION_MODES.map((value) => ({
        label: value[0].toUpperCase() + value.slice(1), value,
      })));
      if (selected) await aiSettingsSetGlobal('permissions', selected);
    }
  } finally {
    TERMINAL.active = undefined;
    rl.close();
  }
}

export async function interactivePermissionPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway permissions are enforced by authenticated platform policy.');
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const current = session.permissionMode ?? 'ask';
  const descriptions: Record<AiHarnessPermissionMode, string> = {
    ask: 'require approval; unanswered headless prompts are denied',
    bypass: 'run without approval prompts',
    auto: 'provider reviews approval requests automatically',
  };
  const supported = harness ? VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode)) : VALID_PERMISSION_MODES;
  if (!supported.length) throw new Error(`${harness?.displayName ?? 'This provider'} does not map ClikCode's permission modes to a real flag.`);
  const selected = await chooseOption(rl, 'Choose permissions', supported.map((value) => ({
    label: value[0].toUpperCase() + value.slice(1), detail: `· ${descriptions[value]}${value === current ? ' · current' : ''}`, value,
  })));
  if (selected) await applySettingScope(rl, id, 'permissions', selected);
}
