/** Default effort, approval mode and failover policy, and how a session's own
 * values are normalized against them. */

import type { HarnessDefaultSettings, HarnessSession, HarnessState } from '../model.js';

export const HARNESS_DEFAULT_SETTINGS: HarnessDefaultSettings = { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' };

export function normalizedPermissionMode(value: unknown): HarnessDefaultSettings['permissionMode'] {
  if (value === 'auto' || value === 'bypass' || value === 'ask') return value;
  // Legacy ClikCode releases described sandbox width instead of approval
  // behavior. Both interactive legacy modes become the new explicit Ask.
  if (value === 'read-only' || value === 'workspace-write') return 'ask';
  return HARNESS_DEFAULT_SETTINGS.permissionMode;
}

export function normalizedSessionPermission(session: HarnessSession): Pick<HarnessSession, 'permissionMode'> {
  // Both routes. The Gateway route runs ClikCode's own agent on this machine,
  // which asks, bypasses or auto-approves by this setting like any harness;
  // the Gateway supplies the model, not the decision about local files.
  return { permissionMode: normalizedPermissionMode(session.permissionMode) };
}

/** Sessions created before lifecycle state existed were still open at the
 * time of upgrade, so they read as active. */
export function normalizedStatus(session: HarnessSession): Pick<HarnessSession, 'status'> {
  return { status: session.status === 'closed' || session.status === 'archived' ? session.status : 'active' };
}

export function normalizedConversation(session: HarnessSession): Pick<HarnessSession, 'conversationId'> {
  // Pre-handoff state had one ClikCode session per conversation. Preserve
  // that exact behavior while giving every existing record a durable root.
  return { conversationId: session.conversationId || session.id };
}

export function resolveDefaultSettings(state: HarnessState, provider?: string | null): HarnessDefaultSettings {
  const overrides = provider ? state.providerSettings[provider] : undefined;
  return {
    effort: overrides?.effort ?? state.globalSettings.effort,
    permissionMode: overrides?.permissionMode ?? state.globalSettings.permissionMode,
    accountFailover: overrides?.accountFailover ?? state.globalSettings.accountFailover,
  };
}
