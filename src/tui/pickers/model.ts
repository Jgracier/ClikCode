import { diagnostic, quiet } from '../../runtime/lifecycle-log.js';
import Conf from 'conf';
/** Choosing a model from the active harness's catalog. */

import { freePlanModels } from '../../harness/accounts/free-plan.js';
import type { AiLocalHarnessDefinition, ModelCatalogResult } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { isGatewayService } from '../../session/route.js';
import { gatewayMakerName, gatewayModelsByMaker, gatewayModelDetail, gatewayModelLabel, gatewayModels, savedGatewayModels } from '../../gateway/models.js';
import { gatewayAgents, type GatewayAgent } from '../../gateway/agents.js';
import { gatewaySubscriptionsOn, setGatewaySubscriptions } from '../../gateway/subscriptions.js';
import { alwaysStartOwnModels, setAlwaysStartOwnModels } from '../../gateway/own-models.js';
import type { GatewayModelList } from '../../gateway/models.js';
import { modelIdFromDisplay } from '../../runtime/lazy-bridge.js';
import { sessionOrProviderHarness } from '../slash/context.js';
import { readState } from '../../session/state/read.js';
import { harnessModelLabel, modelSettingsDetail, modelIdFromLabel, nativeModelCatalogForPicker } from '../../harness/accounts/model-catalog.js';
import { loginNativeHarness } from '../../harness/transport/native/login.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { TERMINAL } from '../active-terminal.js';
import { aiSessionCommand } from '../slash/handlers.js';
import { selectGatewayAgent } from '../../commands/ai/sessions.js';
import { withSignIn } from '../../commands/account.js';
import { chooseOption } from './choose.js';
import { localModelChoices, type LocalModelChoice } from '../../local-models/index.js';
import { withSlowWait } from '../slow-wait.js';
import { deployPrivateModel, quoteSummary, quotePrivateModel, searchDeployableModels, type DeployableModel, type PrivateModelQuote } from '../../gateway/private-models.js';

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
  const choices = await withSlowWait(waiting, 'checking which models fit this machine…', () => localModelChoices());
  if (!choices.length) {
    rl.panel?.('ClikCode Local', 'No supported GGUF model fits the memory currently available. Close other programs or free memory, then open /model again.');
    return;
  }
  const selected = await chooseOption(rl, 'Choose a ClikCode Local model', localModelRows(choices, current));
  if (!selected) return;
  // The handler asks before a download, then loads it (progress on the
  // waiting line) before the session switches: the path `/model <id>` takes.
  await aiSessionCommand(id, `/model ${localModelSelection(choices, selected)}`);
}

/** One model as every model list shows it. A harness that drives other
 * providers shows `provider/model` (never its own name as the provider:
 * OpenCode's `opencode/big-pickle` is `big-pickle`), and a name only where it says something
 * the id does not ("Opus 5.5" for `opus`) -- never the id a second time;
 * "Claude Opus 5.5" only respells `claude-opus-5-5`, compared on letters and
 * digits alone. */
export function modelRow(
  harness: AiLocalHarnessDefinition | undefined, catalog: ModelCatalogResult, model: string, current: string | undefined, providerConfigured = false,
  /** freePlanModels for the account: these say "free plan". */
  free?: ReadonlySet<string>,
): PickerOption<string> {
  const shown = harness ? harnessModelLabel(harness, model) : model;
  const name = catalog.labels?.[model];
  const bare = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const respells = name !== undefined && [shown, shown.slice(shown.indexOf('/') + 1)].some((id) => bare(id) === bare(name));
  const parts = [
    // First: a narrow screen cuts the end of a row, and this is what it is for.
    model === current ? 'current' : undefined,
    name && !respells ? name : undefined,
    modelSettingsDetail(model),
    free?.has(model) ? 'free plan' : undefined,
    model === current && providerConfigured ? 'provider configured' : undefined,
  ].filter((part): part is string => Boolean(part));
  return { label: shown, detail: parts.length ? `· ${parts.join(' · ')}` : undefined, value: model };
}

export async function interactiveModelPicker(rl: HarnessPrompter, id: string): Promise<void> {
  // Index + this chat: the picker never needs every other transcript.
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (isGatewayService(session)) return gatewayModelPicker(rl, id, session.model ?? null, session.gatewayAgentId);
  if (session.route === 'clikcode-local') return localModelPicker(rl, id, session.model);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const harness = sessionOrProviderHarness(session);
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
    catalog = await withSlowWait(waiting, `finding ${harness.displayName} models…`, () => nativeModelCatalogForPicker(harness, account));
  }
  const effective = session.model ?? catalog.configured;
  const free = freePlanModels(harness, account, catalog);
  const discoveredModels = [...catalog.models].sort((left, right) => left === effective ? -1 : right === effective ? 1 : left.localeCompare(right));
  const options: PickerOption<string>[] = [
    ...discoveredModels.map((model) => modelRow(harness, catalog, model, effective, !session.model && model === catalog.configured, free)),
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
  const selected = !discoveredModels.length && !catalog.connect?.length
    ? '__custom__'
    : await chooseOption(rl, discoveredModels.length ? 'Choose a model' : `${harness?.displayName ?? 'This provider'} reported no models — enter one`, options);
  if (!selected) return;
  if (selected === '__connect__' && harness && catalog.connect?.length) {
    const target = await chooseOption(rl, `Connect ${harness.displayName} to`, catalog.connect.map((item) => ({
      label: item.label, detail: item.detail ? `· ${item.detail}` : undefined, value: item.id,
    })));
    const connect = catalog.connect.find((item) => item.id === target);
    if (!connect) return;
    const signIn = { ...harness, loginArgv: connect.argv };
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    // The vendor asks its own questions (browser code, pasted key), so it
    // gets the real terminal, exactly like an account sign-in.
    await withSignIn(rl, `${harness.displayName} › ${connect.label}`, () => loginNativeHarness(signIn, environment));
    // Signing in rewrites the files the catalog is fingerprinted on, so the
    // reopened picker reads the new provider's models.
    return interactiveModelPicker(rl, id);
  }
  let typed: string | undefined;
  if (selected === '__custom__') {
    // Esc leaves the model as it was.
    try {
      typed = (await rl.question(discoveredModels.length ? 'Model ID › ' : `${harness?.displayName ?? 'This provider'} lists no models — model ID › `, undefined, { cancellable: true })).trim();
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_PROMPT_CANCELLED') return;
      throw error;
    }
  }
  const value = typed !== undefined ? (harness && typed ? modelIdFromLabel(harness, catalog.models, modelIdFromDisplay(harness, typed)) : typed) : selected;
  // Applies to this chat only, no further "apply to" step: a model choice is
  // read as a per-conversation decision, unlike effort/permissions,
  // which are more often "how I always want this provider to behave" and
  // genuinely benefit from a scope choice.
  if (value) {
    await aiSessionCommand(id, typed !== undefined ? `/model --any ${value}` : `/model ${value}`);
  }
}

/** Search Hugging Face models ClikDeploy can deploy, ask its shared planner
 * for the GPU and price, then start the deployment and select it for this chat. */
export async function interactivePrivateModelsPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (!isGatewayService(session)) throw new Error('Hosted AI is available on ClikDeploy Gateway conversations.');

  const waiting = TERMINAL.active === rl ? TERMINAL.active : undefined;
  const rows = (models: readonly DeployableModel[]): PickerOption<DeployableModel>[] => models
    .filter((model) => !model.modality || model.modality === 'llm')
    .map((model) => ({
      label: model.modelId,
      detail: [model.parameterCount ? `${formatParameterCount(model.parameterCount)} params` : '', model.gated ? 'restricted access' : ''].filter(Boolean).join(' · '),
      value: model,
      group: 'Hugging Face models',
    }));
  const initial = await withSlowWait(waiting, 'loading hosted AI models…', () => searchDeployableModels());
  const options = rows(initial);
  const selected = await chooseOption(rl, 'Hosted AI', options, undefined, {
    onFilter: async (query) => rows(await withSlowWait(waiting, 'searching Hugging Face…', () => searchDeployableModels(query))),
  });
  if (!selected) return;

  let quote: PrivateModelQuote;
  try {
    quote = await withSlowWait(waiting, `checking ${selected.displayName} and matching compute…`, () => quotePrivateModel(selected.modelId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (selected.gated) throw new Error(`${message} Connect Hugging Face in ClikDeploy, then try again.`);
    throw error;
  }
  const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  if (!alwaysStartOwnModels(config)) {
    // The estimate and the GPU, wrapped in full above the question: a picker row cuts a long detail on a narrow screen.
    const summary = quoteSummary(selected, quote);
    if (rl.panel) rl.panel(summary.title, summary.body); else process.stdout.write(`\n${summary.title}\n${summary.body}\n`);
    const answer = await chooseOption(rl, `Start ${selected.displayName} on ClikDeploy?`, [
      // The price leads the row, so it is the last thing a short screen can lose.
      { label: `Yes, start it · $${quote.pricePerHour.toFixed(2)}/hour`, detail: quote.sku.displayName, value: 'start' },
      { label: 'No, use AI billed by the token', detail: 'Choose a pay-per-token Gateway model instead.', value: 'hosted' },
      { label: 'Always start hosted AI models', detail: 'Remember this on this machine.', value: 'always' },
    ]);
    if (answer === 'hosted') return interactiveModelPicker(rl, id);
    if (answer === 'always') setAlwaysStartOwnModels(true, config);
    else if (answer !== 'start') return;
  }

  const deployment = await withSlowWait(waiting, `starting ${selected.displayName} on ${quote.sku.displayName}…`, () => deployPrivateModel(selected, quote));
  // Select the deployment we just created, never its public model name. The
  // create response establishes ownership; don't wait for a cached model list
  // to publish it. The first prompt waits for this deployment's readiness.
  await aiSessionCommand(id, `/model --any ${deployment.gatewayModelId}`);
}

function formatParameterCount(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(count >= 10_000_000_000 ? 0 : 2).replace(/\.?0+$/, '')}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1).replace(/\.?0+$/, '')}M`;
  return count.toLocaleString();
}

/** A Gateway conversation's picker. Models run ClikCode locally; selected
 * platform agents run on ClikDeploy with their own tools. */
type GatewayChoice = { kind: 'agent'; id?: string } | { kind: 'model'; id: string } | { kind: 'subscriptions' };

/** Top to bottom: the super admin's subscription switch (only when the Gateway reports it, which it
 * does for the super admin alone), the account's own agents, then the models. Choosing a model
 * closes the picker; the switch and an agent keep it open. */
export function gatewayPickerRows(list: GatewayModelList, agents: readonly GatewayAgent[], current: string | null, currentAgent?: string): PickerOption<GatewayChoice>[] {
  const subscriptions: PickerOption<GatewayChoice>[] = list.subscriptions === undefined ? [] : [{
    label: `${list.subscriptions ? '✓' : '○'} Use subscriptions`,
    detail: list.subscriptions
      ? '· on: your ClikCode turns may use the platform\'s subscriptions · enter turns off'
      : '· off: your ClikCode turns use customer accounts only · enter turns on',
    value: { kind: 'subscriptions' as const },
    group: 'Gateway',
  }];
  const agentRows: PickerOption<GatewayChoice>[] = [
    ...(agents.length || currentAgent ? [{ label: currentAgent ? 'No agent' : '✓ No agent', detail: '· use ClikCode with the Gateway model', value: { kind: 'agent' as const }, group: 'Your agents (remote)' }] : []),
    ...agents.map((agent) => ({
      label: `${agent.id === currentAgent ? '✓ ' : ''}${agent.name}`,
      detail: `· runs on ClikDeploy${agent.description ? ` · ${agent.description}` : ''}`,
      value: { kind: 'agent' as const, id: agent.id },
      group: 'Your agents (remote)',
    })),
  ];
  return [
    ...subscriptions,
    ...agentRows,
    { label: currentAgent ? 'Agent default' : 'Automatic', detail: currentAgent
      ? `${current ? '' : '· current '}· use this agent's configured pin or router`
      : `${current ? '' : '· current '}· the Gateway chooses`,
      value: { kind: 'model' as const, id: 'auto' }, group: 'Automatic' },
    ...gatewayModelsByMaker(list.models).map((model) => {
      const price = gatewayModelDetail(model);
      return {
        label: gatewayModelLabel(model),
        detail: [model.id === current ? '· current' : '', price ? `· ${price}` : ''].filter(Boolean).join(' '),
        value: { kind: 'model' as const, id: model.id },
        group: gatewayMakerName(model),
      };
    }),
  ];
}

async function gatewayModelPicker(rl: HarnessPrompter, id: string, current: string | null, currentAgent?: string): Promise<void> {
  // The saved model list avoids another model-list wait. Agents are never
  // cached locally, so opening waits for the authenticated private roster.
  let list = await savedGatewayModels();
  const fresh = gatewayModels({ fresh: true }).then((latest) => { list = latest; return latest; });
  // The model request may finish before the roster request; attach rejection
  // handling now so an early failure cannot become an unhandled rejection.
  void fresh.catch(quiet('tui/pickers/model'));
  // Account-private roster: always ask with the current key; never display
  // another account's cached agents. A missing roster does not block models.
  const agents = await gatewayAgents().catch((error: unknown) => {
    diagnostic('gateway.agents-unavailable', error instanceof Error ? error.message : String(error));
    return [];
  });
  if (!list) {
    const waiting = TERMINAL.active === rl ? TERMINAL.active : undefined;
    list = await withSlowWait(waiting, 'finding ClikDeploy Gateway models…', () => fresh);
  }
  const options = (): PickerOption<GatewayChoice>[] => gatewayPickerRows(list!, agents, current, currentAgent);
  for (;;) {
    const selected = await chooseOption(rl, 'Choose an agent or ClikDeploy Gateway model', options(), undefined, { refreshedOptions: options, refresh: fresh });
    if (!selected) return;
    if (selected.kind === 'subscriptions') {
      // The super admin's switch: flipped, then the list as the Gateway serves it in the new position.
      const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
      const on = !gatewaySubscriptionsOn(config);
      setGatewaySubscriptions(config, on);
      const waiting = TERMINAL.active === rl ? TERMINAL.active : undefined;
      try {
        list = await withSlowWait(waiting, 'finding ClikDeploy Gateway models…', () => gatewayModels({ fresh: true, config }));
      } catch (error) {
        diagnostic('gateway.models-unavailable', error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    if (selected.kind === 'agent') {
      currentAgent = selected.id === currentAgent ? undefined : selected.id;
      await selectGatewayAgent(id, currentAgent, agents.find((agent) => agent.id === currentAgent)?.name);
      continue;
    }
    const own = list.models.find((model) => model.id === selected.id)?.own;
    if (own?.state === 'asleep') {
      const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
      if (!alwaysStartOwnModels(config)) {
        const answer = await chooseOption(rl, `Start ${selected.id} on ClikDeploy?`, [
          {
            label: 'Yes, start private model',
            detail: 'Uses credits by the hour while it runs; it may take a few minutes to start.',
            value: 'start',
          },
          {
            label: 'No, use a token-billed model',
            detail: 'Choose a pay-per-token Gateway model instead.',
            value: 'hosted',
          },
          {
            label: 'Always start hosted AI models',
            detail: 'Remember this choice on this machine.',
            value: 'always',
          },
        ]);
        if (answer === 'hosted') {
          const tokenModels = list.models
            .filter((model) => !model.own && model.price && model.access !== 'subscription' && model.access !== 'free')
            .map((model) => ({
              label: gatewayModelLabel(model),
              detail: gatewayModelDetail(model),
              value: model.id,
            }));
          const hosted = await chooseOption(rl, 'Choose a token-billed Gateway model', tokenModels);
          if (hosted) {
            await aiSessionCommand(id, `/model ${hosted}`);
            return;
          }
          continue;
        }
        if (answer === 'always') setAlwaysStartOwnModels(true, config);
        else if (answer !== 'start') continue;
      }
    }
    await aiSessionCommand(id, `/model ${selected.id}`);
    return;
  }
}
