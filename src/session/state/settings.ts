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
  // Gateway authorization is enforced by the authenticated platform and has
  // no local Ask/Bypass/Auto override. Keep that distinction in persisted
  // state too; otherwise every read silently reintroduced `ask` after the
  // Gateway creation/switch paths deliberately removed it.
  return session.route === 'gateway'
    ? { permissionMode: undefined }
    : { permissionMode: normalizedPermissionMode(session.permissionMode) };
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


// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
