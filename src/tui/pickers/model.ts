/** Choosing a model from the active harness's catalog. */

import type { AiLocalHarnessDefinition, ModelCatalogResult } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { isGatewayService } from '../../session/route.js';
import { gatewayModelDetail, gatewayModels, savedGatewayModels } from '../../gateway/models.js';
import { localHarnessForCommand, localHarnessForProvider, modelIdFromDisplay } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { harnessModelLabel, modelSettingsDetail, modelIdFromLabel, nativeModelCatalogForPicker } from '../../harness/accounts/model-catalog.js';
import { turboFitModelChanged } from '../../commands/ai/turbofit.js';
import { loginNativeHarness } from '../../harness/transport/native/login.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { TERMINAL } from '../active-terminal.js';
import { TerminalHarnessPrompter } from '../prompter.js';
import { aiSessionCommand } from '../slash/handlers.js';
import { withVendorTerminal } from '../../commands/account.js';
import { chooseOption } from './choose.js';
import { localModelChoices, type LocalModelChoice } from '../../local-models/index.js';

/** Prefix of a row for a model this machine cannot run: listed, so the
 * catalog is honest about what exists and why it is out of reach, but
 * choosing it explains rather than starting a load that would fail. */
const UNFIT = '__unfit__:';

/** ClikCode Local's /model rows, in the engine's order (best first). */
export function localModelRows(choices: readonly LocalModelChoice[], current: string | null | undefined): PickerOption<string>[] {
  return choices.map((choice) => {
    const parts = [
      choice.id === current ? 'current' : undefined,
      choice.fits && choice.recommended ? 'recommended' : undefined,
      choice.detail,
    ].filter((part): part is string => Boolean(part));
    return { label: choice.label, detail: `· ${parts.join(' · ')}`, value: choice.fits ? choice.id : `${UNFIT}${choice.id}` };
  });
}

/** The row a picker selection names, as the model to load: a model that
 * does not fit is refused with the engine's reason. */
export function localModelSelection(choices: readonly LocalModelChoice[], selected: string): string {
  if (!selected.startsWith(UNFIT)) return selected;
  const choice = choices.find((item) => item.id === selected.slice(UNFIT.length));
  throw new Error(`${choice?.label ?? selected.slice(UNFIT.length)} cannot run on this machine: ${choice?.detail ?? 'it does not fit'}.`);
}

async function localModelPicker(rl: HarnessPrompter, id: string, current: string | null | undefined): Promise<void> {
  const waiting = TERMINAL.active === rl ? TERMINAL.active : undefined;
  waiting?.startWaiting('checking which models fit this machine…');
  let choices: LocalModelChoice[];
  try { choices = await localModelChoices(); } finally { waiting?.stopWaiting(); }
  if (!choices.length) {
    rl.panel?.('ClikCode Local', 'No supported GGUF model fits the memory currently available. Close other programs or free memory, then open /model again.');
    return;
  }
  const selected = await chooseOption(rl, 'Choose a ClikCode Local model', localModelRows(choices, current));
  if (!selected) return;
  const choice = choices.find((item) => item.id === selected);
  if (choice?.downloadBytes) {
    const confirmed = await chooseOption(rl, `Download ${choice.label}?`, [
      { label: 'Cancel', value: false },
      { label: `Download ${choice.detail.split(' · ').at(-1) ?? ''}`, value: true },
    ]);
    if (!confirmed) return;
  }
  // The handler loads it (progress on the waiting line) before the session
  // switches; the same path `/model <id>` takes.
  await aiSessionCommand(id, `/model --download ${localModelSelection(choices, selected)}`);
}

/** One model as every model list shows it. A harness that drives other
 * providers shows `provider/model` (never its own name as the provider:
 * OpenCode's `opencode/big-pickle` is `big-pickle`), and a name only where it says something
 * the id does not ("Opus 5.5" for `opus`) -- never the id a second time;
 * "Claude Opus 5.5" only respells `claude-opus-5-5`, compared on letters and
 * digits alone. */
export function modelRow(
  harness: AiLocalHarnessDefinition | undefined, catalog: ModelCatalogResult, model: string, current: string | undefined, providerConfigured = false,
): PickerOption<string> {
  const localLabel = harness?.turboFit && /^(?:custom:)?turbofit:/.test(model)
    ? catalog.labels?.[model]
    : undefined;
  const shown = localLabel ?? (harness ? harnessModelLabel(harness, model) : model);
  const name = localLabel ? undefined : catalog.labels?.[model];
  const bare = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const respells = name !== undefined && [shown, shown.slice(shown.indexOf('/') + 1)].some((id) => bare(id) === bare(name));
  const parts = [
    name && !respells ? name : undefined,
    modelSettingsDetail(model),
    model === current ? 'current' : undefined,
    model === current && providerConfigured ? 'provider configured' : undefined,
  ].filter((part): part is string => Boolean(part));
  return { label: shown, detail: parts.length ? `· ${parts.join(' · ')}` : undefined, value: model };
}

export async function interactiveModelPicker(rl: HarnessPrompter, id: string): Promise<void> {
  // Index + this chat: the picker never needs every other transcript.
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (isGatewayService(session)) return gatewayModelPicker(rl, id, session.model ?? null);
  if (session.route === 'clikcode-local') return localModelPicker(rl, id, session.model);
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
    // Only a wait worth seeing gets a spinner. A warm cache answers in
    // milliseconds, and starting and stopping one flashed a spinner and an
    // empty composer between Settings and the list.
    let spinning = false;
    const spinner = setTimeout(() => { spinning = true; waiting?.startWaiting(`finding ${harness.displayName} models…`); }, 250);
    try { catalog = await nativeModelCatalogForPicker(harness, account); }
    finally { clearTimeout(spinner); if (spinning) waiting?.stopWaiting(); }
  }
  const effective = session.model ?? catalog.configured;
  const discoveredModels = [...catalog.models].sort((left, right) => left === effective ? -1 : right === effective ? 1 : left.localeCompare(right));
  const options: PickerOption<string>[] = [
    ...discoveredModels.map((model) => modelRow(harness, catalog, model, effective, !session.model && model === catalog.configured)),
    ...(harness?.turboFit ? (catalog.localRecommendations ?? []).map((item) => ({
      label: item.label,
      detail: `· TurboFit · ${item.detail}`,
      value: `__turbofit_profile__:${encodeURIComponent(item.id)}`,
    })) : []),
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
  // Nothing to list and nothing to connect: the one thing left to do is type
  // an id, so ask for it rather than showing a one-row list first.
  const hasLocalRecommendations = Boolean(catalog.localRecommendations?.length);
  const selected = !discoveredModels.length && !catalog.connect?.length && !hasLocalRecommendations
    ? '__custom__'
    : await chooseOption(rl, discoveredModels.length || hasLocalRecommendations ? 'Choose a model' : `${harness?.displayName ?? 'This provider'} reported no models — enter one`, options);
  if (!selected) return;
  if (selected.startsWith('__turbofit_profile__:') && harness?.turboFit) {
    const profile = decodeURIComponent(selected.slice('__turbofit_profile__:'.length));
    // Hermes names the provider `turbofit` (config providers:) or
    // `custom:turbofit` (legacy custom_providers:); use the one it listed.
    const main = catalog.models.find((model) => /^(?:custom:)?turbofit:active:main$/.test(model)) ?? 'custom:turbofit:active:main';
    // Selected, downloaded, built and answering before the session moves to
    // it; a failure leaves the session on the model it had.
    await turboFitModelChanged(harness, account, id, session.model, main, profile);
    await aiSessionCommand(id, `/model ${main}`);
    return;
  }
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
  const typed = selected === '__custom__' ? (await rl.question(discoveredModels.length ? 'Model ID › ' : `${harness?.displayName ?? 'This provider'} lists no models — model ID › `)).trim() : undefined;
  const value = typed !== undefined ? (harness && typed ? modelIdFromLabel(harness, catalog.models, modelIdFromDisplay(harness, typed)) : typed) : selected;
  // Applies to this chat only, no further "apply to" step: a model choice is
  // read as a per-conversation decision, unlike effort/permissions/failover,
  // which are more often "how I always want this provider to behave" and
  // genuinely benefit from a scope choice.
  if (value) {
    await aiSessionCommand(id, typed !== undefined ? `/model --any ${value}` : `/model ${value}`);
    rl.notice?.(`Model set to ${harness ? harnessModelLabel(harness, value) : value}`);
  }
}

/** A Gateway conversation's picker: the Gateway's own list for this account,
 * cheapest access first, with "Automatic" to hand the choice back. Whichever
 * model is chosen, the Gateway serves it from its cheapest provider --
 * subscription, then free, then paid -- and never swaps in another. */
async function gatewayModelPicker(rl: HarnessPrompter, id: string, current: string | null): Promise<void> {
  // Open at once from the last list this machine received, and refresh it in
  // place: the Gateway can take seconds to answer, and the picker must not.
  let list = await savedGatewayModels();
  const fresh = gatewayModels({ fresh: true }).then((latest) => { list = latest; });
  if (!list) {
    const waiting = TERMINAL.active === rl ? TERMINAL.active : undefined;
    waiting?.startWaiting('finding ClikDeploy Gateway models…');
    try { await fresh; } finally { waiting?.stopWaiting(); }
  } else {
    // fail-open-ok: the saved list is on screen; a failed refresh leaves it there.
    fresh.catch(() => undefined);
  }
  const options = (): PickerOption<string>[] => [
    { label: 'Automatic', detail: `· the Gateway chooses${list!.automatic ? ` (now ${list!.automatic})` : ''}${current ? '' : ' · current'}`, value: 'auto' },
    ...list!.models.map((model) => {
      const price = gatewayModelDetail(model);
      return {
        label: model.id,
        detail: `${price ? `· ${price}` : ''}${model.id === current ? ' · current' : ''}`,
        value: model.id,
      };
    }),
  ];
  const selected = await chooseOption(rl, 'Choose a ClikDeploy Gateway model', options(), undefined, { refreshedOptions: options, refresh: fresh });
  if (selected) await aiSessionCommand(id, `/model ${selected}`);
}
