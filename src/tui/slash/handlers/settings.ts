import { aiSessionCommand } from '../handlers.js';
/** /permissions, /sandbox, /send and /settings. */
import { isAiHarnessRoute, isClikCodeAgent, ROUTE_CHOICES_TEXT } from '../../../session/route.js';
import { releaseHeldLocalModel } from '../../../commands/ai/local-model.js';
import { localHarnessForCommand } from '../../../runtime/lazy-bridge.js';
import { emitHarnessOutput } from '../../../harness/output.js';
import { parseSendMode, sendModeOf, SEND_MODE_DETAIL, SEND_MODES } from '../../../turn/send-mode.js';
import { sessionPermissionModes, setSessionHarnessOption } from '../../../session/options.js';
import type { SlashHandlerKey } from '../registry.js';
import { parseSandboxMode, sandboxModeText, sessionSandboxMode } from '../../../agent/sandbox.js';
import { computerEnabled, setComputerEnabled } from '../../../agent/computer/settings.js';
import { stateDirectory } from '../../../session/store/paths.js';
import { closeComputerBrowser } from '../../../agent/computer/browser.js';
import { lockCredentialVault } from '../../../agent/computer/credential-vault.js';
import type { AiHarnessPermissionMode } from '../../../harness/definition.js';
import { applyClikCodeAgentSessionPolicy, applyFreshLocalSessionPolicy } from '../../../commands/ai/sessions.js';
import { aiSettingsClearProvider, aiSettingsSetGlobal, aiSettingsSetProvider } from '../../../commands/ai/settings.js';
import { cliThreadTransport } from '../../../harness/transport/select.js';
import { type HeadlessSlashHandler, saveSettings } from './shared.js';

export const settingsHandlers = {
  permissions: async ({ state, session, words }) => {
    const value = words.shift()?.toLowerCase();
    // ClikCode's own agent implements every mode itself; a vendor harness
    // only the ones it carries to a real flag.
    const agent = isClikCodeAgent(session);
    const harness = !agent && session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!agent && !harness) throw new Error('Choose a provider before setting permissions.');
    const controls = sessionPermissionModes(session, harness);
    if (!value) {
      if (!controls.length) throw new Error(`${harness!.displayName} does not map ClikCode's permission modes to a real flag.`);
      return emitHarnessOutput({ panel: 'permissions', session, controls });
    }
    if (agent) {
      if (!controls.includes(value as AiHarnessPermissionMode)) throw new Error('permissions must be ask, bypass, or auto');
      session.permissionMode = value as AiHarnessPermissionMode;
    } else setSessionHarnessOption(session, harness!, 'permissions', value);
    // Same as /model: the reported mode described the previous request.
    if (session.reported?.permissionMode) delete session.reported.permissionMode;
    return saveSettings(state, session);
  },
  sandbox: async ({ state, session, words }) => {
    if (!isClikCodeAgent(session)) throw new Error("The sandbox applies to ClikCode's own agent; a vendor harness sandboxes its own commands.");
    if (!words[0]) {
      const current = sessionSandboxMode(session.sandbox);
      return emitHarnessOutput({ panel: 'sandbox', sandbox: current, text: sandboxModeText(current), controls: ['sandbox on', 'sandbox off'] });
    }
    const mode = words.length === 1 ? parseSandboxMode(words[0]) : undefined;
    if (!mode) throw new Error('usage: /sandbox [on|off]');
    // On is the default, so it is stored as no value; off is the explicit choice.
    if (mode === 'off') session.sandbox = 'off';
    else delete session.sandbox;
    return saveSettings(state, session);
  },
  computer: async ({ session, words }) => {
    if (!isClikCodeAgent(session)) throw new Error('Computer use is available in ClikCode’s own agent.');
    const value = words[0]?.toLowerCase();
    if (words.length > 1 || (value && value !== 'on' && value !== 'off')) throw new Error('usage: /computer [on|off]');
    if (value) {
      await setComputerEnabled(stateDirectory(), value === 'on');
      if (value === 'off') { await closeComputerBrowser(stateDirectory()); lockCredentialVault(stateDirectory()); }
    }
    const enabled = await computerEnabled(stateDirectory());
    return emitHarnessOutput({ panel: 'settings-updated', text: enabled
      ? 'Computer use is on. The agent can open URLs and control the desktop when a task needs it.'
      : 'Computer use is off. New computer actions are refused.' });
  },
  // Global, not this chat's: how mid-turn messages go is the user's habit.
  // The worker reads it as each message arrives (session-worker.ts).
  send: async ({ state, words }) => {
    if (!words[0]) {
      const current = sendModeOf(state.globalSettings);
      return emitHarnessOutput({ panel: 'send', sendMode: current, text: `Messages typed mid-turn: ${current} · ${SEND_MODE_DETAIL[current]}`, controls: SEND_MODES.map((mode) => `send ${mode}`) });
    }
    const mode = parseSendMode(words[0]);
    await aiSettingsSetGlobal('send', mode, false);
    return emitHarnessOutput({ panel: 'settings-updated', sendMode: mode, text: `Messages typed mid-turn: ${mode}` });
  },
  settings: async ({ id, state, session, words }) => {
    const setting = words.shift()?.toLowerCase();
    const value = words.join(' ').trim();
    if (!setting) return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
    if (setting === 'global') {
      const [key, ...rest] = words;
      if (!key || !rest.length) throw new Error('usage: /settings global <effort|permissions|send> <value>');
      await aiSettingsSetGlobal(key, rest.join(' '), false);
      return emitHarnessOutput({ panel: 'settings-updated', text: `Global default updated: ${key} = ${rest.join(' ')}` });
    }
    if (setting === 'provider') {
      const [providerId, key, ...rest] = words;
      if (!providerId || !key) throw new Error('usage: /settings provider <id> <model|effort|permissions> <value>, or /settings provider <id> clear');
      if (key.toLowerCase() === 'clear') {
        await aiSettingsClearProvider(providerId, false);
        return emitHarnessOutput({ panel: 'settings-updated', text: `Provider defaults cleared for ${providerId}` });
      }
      if (!rest.length) throw new Error('usage: /settings provider <id> <key> <value>');
      await aiSettingsSetProvider(providerId, key, rest.join(' '), false);
      return emitHarnessOutput({ panel: 'settings-updated', text: `${providerId} default updated: ${key} = ${rest.join(' ')}` });
    }
    if (!value) throw new Error(`usage: /settings ${setting} <value>`);
    if (setting === 'route') {
      if (!isAiHarnessRoute(value)) throw new Error(ROUTE_CHOICES_TEXT);
      // Leaving ClikCode Local lets go of its model at once, not at the
      // interactive loop's next pass.
      if (session.route === 'clikcode-local' && value !== 'clikcode-local') await releaseHeldLocalModel(session.id);
      if (value === 'gateway' || value === 'clikcode-local') applyClikCodeAgentSessionPolicy(session, value, state);
      else if (isClikCodeAgent(session)) applyFreshLocalSessionPolicy(state, session);
      else session.route = 'local';
    } else if (setting === 'account' || setting === 'model' || setting === 'effort' || setting === 'permissions' || setting === 'permission') {
      // One way to set each, with that command's checks. The copies here had
      // fewer: /settings account moved a conversation with content to another
      // harness, and /settings model kept an effort the new model rejects.
      const command = setting === 'account' ? 'accounts use' : setting === 'permission' ? 'permissions' : setting;
      return aiSessionCommand(id, `/${command} ${value}`);
    } else if (setting === 'option') {
      const [optionId, ...optionValue] = value.split(/\s+/);
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness || !optionId || !optionValue.length) throw new Error('usage: /settings option <id> <value|default>');
      // `default` clears it: nothing is sent, the harness decides.
      if (optionValue.join(' ') === 'default') {
        const { [optionId]: _cleared, ...rest } = session.harnessOptions ?? {};
        session.harnessOptions = rest;
      } else setSessionHarnessOption(session, harness, optionId, optionValue.join(' '));
    } else if (setting === 'native-session') {
      if (!session.nativeHarness) throw new Error('select a native harness before attaching its session id');
      const selectedHarness = localHarnessForCommand(session.nativeHarness);
      if (!selectedHarness?.session?.resumeIdPrefix) throw new Error(`${selectedHarness?.displayName ?? session.nativeHarness} does not support exact session resume`);
      session.nativeSessionId = value;
      delete session.nativeSessionPreallocated;
      // An id given by hand is the vendor CLI's: the thread stays on it.
      const pinned = cliThreadTransport(selectedHarness);
      if (pinned) session.nativeTransport = pinned;
      else delete session.nativeTransport;
    } else {
      throw new Error(`unknown setting: ${setting}`);
    }
    return saveSettings(state, session);
  },
} satisfies Partial<Record<SlashHandlerKey, HeadlessSlashHandler>>;
