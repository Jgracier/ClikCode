/** Choosing a model from the active harness's catalog. */

import type { ModelCatalogResult } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { localHarnessForCommand, localHarnessForProvider, modelDisplayId, modelIdFromDisplay } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { nativeModelCatalogForPicker } from '../../harness/accounts/model-catalog.js';
import { loginNativeHarness } from '../../harness/transport/native/login.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { TERMINAL } from '../active-terminal.js';
import { TerminalHarnessPrompter } from '../prompter.js';
import { aiSessionCommand } from '../slash/handlers.js';
import { withVendorTerminal } from '../../commands/account.js';
import { chooseOption } from './choose.js';

export async function interactiveModelPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
    : session.provider ? localHarnessForProvider(session.provider) : undefined;
  // Awaited, not fired and forgotten: opening /model on a cold cache used to
  // show an empty list, and the models only appeared if the user backed out
  // and opened it a second time. The wait is bounded and a warm cache is
  // instant, so this costs a beat once per provider rather than a wrong list
  // every time.
  let catalog: ModelCatalogResult = { models: account?.models ?? [] };
  if (harness) {
    // Feature-detected, never assumed: the headless prompter has no spinner.
    const waiting = TERMINAL.active === rl ? TERMINAL.active : undefined;
    waiting?.startWaiting(`finding ${harness.displayName} models…`);
    try { catalog = await nativeModelCatalogForPicker(harness, account); }
    finally { waiting?.stopWaiting(); }
  }
  const effective = session.model ?? catalog.configured;
  const discoveredModels = [...catalog.models].sort((left, right) => left === effective ? -1 : right === effective ? 1 : left.localeCompare(right));
  const options: PickerOption<string>[] = [
    ...discoveredModels.map((model) => {
      // A harness that drives other providers shows every model one way,
      // `provider:model`, and a name only where it says something the id
      // does not ("Opus 5.5" for `opus`) -- never the id a second time.
      const shown = harness ? modelDisplayId(harness, model) : model;
      const name = catalog.labels?.[model];
      // "Claude Opus 5.5" only respells `claude-opus-5-5`; "Opus 5.5" names
      // what `opus` is. Compared on letters and digits alone.
      const bare = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');
      const respells = name !== undefined && [shown, shown.slice(shown.indexOf(':') + 1)].some((id) => bare(id) === bare(name));
      const parts = [
        name && !respells ? name : undefined,
        model === effective ? 'current' : undefined,
        model === effective && !session.model && model === catalog.configured ? 'provider configured' : undefined,
      ].filter((part): part is string => Boolean(part));
      return { label: shown, detail: parts.length ? `· ${parts.join(' · ')}` : undefined, value: model };
    }),
    // A multi-provider harness (Hermes) lists providers it can reach but is
    // not signed in to. Signing in here is the whole connection flow: no
    // command to know, and the picker comes back with that provider's models.
    ...(catalog.connect?.length ? [{ label: 'Connect a provider…', detail: `· ${catalog.connect.length} more in ${harness?.displayName ?? 'this harness'}`, value: '__connect__' }] : []),
    { label: 'Enter a model ID…', value: '__custom__' },
  ];
  // No synthetic "Automatic provider default" row. It resolved to nothing the
  // user could see -- it set session.model to null and left the real model
  // whatever the vendor happened to pick -- and it sat at the top of the list
  // looking like a choice. A model picker lists models.
  const selected = await chooseOption(
    rl,
    discoveredModels.length ? 'Choose a model' : `${harness?.displayName ?? 'This provider'} reported no models — enter one`,
    options,
  );
  if (!selected) return;
  if (selected === '__connect__' && harness && catalog.connect?.length) {
    const target = await chooseOption(rl, `Connect ${harness.displayName} to`, catalog.connect.map((item) => ({
      label: item.label, detail: item.detail ? `· ${item.detail}` : undefined, value: item.id,
    })));
    const connect = catalog.connect.find((item) => item.id === target);
    if (!connect) return;
    const signIn = { ...harness, loginArgv: connect.argv, ...(connect.hint ? { loginHint: connect.hint } : {}) };
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    // The vendor asks its own questions (browser code, pasted key), so it
    // gets the real terminal, exactly like an account sign-in.
    await withVendorTerminal(rl instanceof TerminalHarnessPrompter ? rl : undefined, signIn, () => loginNativeHarness(signIn, environment), `${harness.displayName} › ${connect.label}`);
    // Signing in rewrites the files the catalog is fingerprinted on, so the
    // reopened picker reads the new provider's models.
    return interactiveModelPicker(rl, id);
  }
  const typed = selected === '__custom__' ? (await rl.question('Model ID › ')).trim() : undefined;
  const value = typed !== undefined ? (harness && typed ? modelIdFromDisplay(harness, typed) : typed) : selected;
  // Applies to this chat only, no further "apply to" step: a model choice is
  // read as a per-conversation decision, unlike effort/permissions/failover,
  // which are more often "how I always want this provider to behave" and
  // genuinely benefit from a scope choice.
  if (value) await aiSessionCommand(id, `/model ${value}`);
}
