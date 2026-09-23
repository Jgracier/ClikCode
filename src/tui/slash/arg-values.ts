/** The real values a command's argument can take, for the command palette.
 *
 * `/model op` lists the matching models instead of a hint and a second screen;
 * `/effort`, `/permissions`, `/account` and `/resume` the same. Each value comes
 * from where it is actually decided, never a list kept here:
 *
 *   /model        the harness's own catalog (model-catalog.ts), with its labels
 *   /effort       what the installed harness accepts for this model
 *   /permissions  the modes this harness maps to a real flag
 *   /account      this machine's accounts, signed-out ones included
 *   /resume       the conversations /resume would list
 *
 * The vendor-derived lists load in the background: the palette reads them on
 * every keystroke, so they appear as they arrive rather than making the
 * composer wait. Loading is kicked off once per session, not once per prompt.
 */
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { nativeModelCatalog } from '../../harness/accounts/model-catalog.js';
import { effortChoicesFor } from '../../harness/accounts/effort-choices.js';
import { harnessSupportsPermissionMode } from '../../runtime/lazy-bridge.js';
import { isBlankConversation, VALID_PERMISSION_MODES } from '../../session/options.js';
import type { PaletteEntry } from '../command-palette.js';

type Values = readonly { value: string; detail?: string }[];

const loaded = new Map<string, { models: Values; efforts: Values }>();

function loadVendorValues(session: HarnessSession, harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined): { models: Values; efforts: Values } {
  const key = `${session.id}:${harness.command}:${account?.id ?? ''}:${session.model ?? ''}`;
  const existing = loaded.get(key);
  if (existing) return existing;
  const slot: { models: Values; efforts: Values } = { models: [], efforts: [] };
  loaded.set(key, slot);
  if (loaded.size > 32) loaded.delete(loaded.keys().next().value as string);
  void nativeModelCatalog(harness, account).then((catalog) => {
    slot.models = catalog.models.map((model) => ({
      value: model, ...(catalog.labels?.[model] ? { detail: catalog.labels[model] } : {}),
    }));
  }).catch(() => undefined);
  void effortChoicesFor(harness, account, session.model).then((choices) => {
    slot.efforts = choices.values.map((value) => ({ value }));
  }).catch(() => undefined);
  return slot;
}

/** The palette with each command's values attached where it has them. */
export function withArgValues(
  entries: readonly PaletteEntry[],
  session: HarnessSession,
  harness: AiLocalHarnessDefinition | undefined,
  state: Pick<HarnessState, 'accounts' | 'sessions'>,
): PaletteEntry[] {
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const vendor = harness ? loadVendorValues(session, harness, account) : undefined;
  const permissions: Values = harness
    ? VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode)).map((value) => ({ value }))
    : [];
  const accounts: Values = state.accounts.map((item) => ({
    value: item.label, detail: `${item.provider}${item.status === 'ready' ? '' : ` · ${item.status.replace('_', ' ')}`}`,
  }));
  const chats: Values = state.sessions
    .filter((item) => item.id !== session.id && !isBlankConversation(item) && item.name)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((item) => ({ value: item.name!, detail: new Date(item.updatedAt).toLocaleDateString() }));
  const sources: Record<string, () => Values> = {
    '/model': () => vendor?.models ?? [],
    '/effort': () => vendor?.efforts ?? [],
    '/permissions': () => permissions,
    '/account': () => accounts,
    '/resume': () => chats,
  };
  return entries.map((entry) => (sources[entry.value] ? { ...entry, argValues: sources[entry.value] } : entry));
}
