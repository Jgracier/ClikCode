/** Choosing a model from the active harness's catalog. */

import type { ModelCatalogResult } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { localHarnessForCommand, localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { nativeModelCatalogForPicker } from '../../harness/accounts/model-catalog.js';
import { loginNativeHarness } from '../../harness/transport/native/login.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { TERMINAL } from '../active-terminal.js';
import { TerminalHarnessPrompter } from '../prompter.js';
import { aiSessionCommand } from '../slash/handlers.js';
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
      const parts = [
        catalog.labels?.[model],
        model === effective ? 'current' : undefined,
        model === effective && !session.model && model === catalog.configured ? 'provider configured' : undefined,
      ].filter((part): part is string => Boolean(part));
      return { label: model, detail: parts.length ? `· ${parts.join(' · ')}` : undefined, value: model };
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
    const signIn = { ...harness, loginArgv: connect.argv };
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    // Hermes asks its own questions (browser code, pasted key), so it gets
    // the real terminal, exactly like an account sign-in.
    if (rl instanceof TerminalHarnessPrompter) {
      await rl.suspend();
      try { await loginNativeHarness(signIn, environment); } finally { rl.resume(); }
    } else {
      await loginNativeHarness(signIn, environment);
    }
    // Signing in rewrites the files the catalog is fingerprinted on, so the
    // reopened picker reads the new provider's models.
    return interactiveModelPicker(rl, id);
  }
  const value = selected === '__custom__' ? (await rl.question('Model ID › ')).trim() : selected;
  // Applies to this chat only, no further "apply to" step: a model choice is
  // read as a per-conversation decision, unlike effort/permissions/failover,
  // which are more often "how I always want this provider to behave" and
  // genuinely benefit from a scope choice.
  if (value) await aiSessionCommand(id, `/model ${value}`);
}
