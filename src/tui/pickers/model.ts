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
import { withSlowWait } from '../slow-wait.js';
import { hostedAdapter, hostedList, hostedSelectionCommand, HOSTED_TAGS, type HostedRow } from '../../hosted-models/index.js';
import { GATEWAY_ID, LOCAL_ID } from '../../session/picker-rows.js';
import { providerConversationKey } from './engine.js';
import { selectProviderConversation } from './conversation.js';

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
  // A model on this computer is hosted AI under the Gateway: the same list as /hosted, with this computer's models first.
  if (session.route === 'clikcode-local') return interactiveHostedPicker(rl, id);
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

/** Hosted AI: models that run on this computer (tagged Local) or on a ClikDeploy GPU, in one list. A search names
 * the model, and `local` or `cloud` in it names where. Choosing one shows what starting it takes -- the download, or
 * the GPU and price -- and only then starts it and moves the chat onto it (hosted-models/). */
export async function interactiveHostedPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const waiting = TERMINAL.active === rl ? TERMINAL.active : undefined;
  const open = (await readState({ transcripts: [id] })).sessions.find((item) => item.id === id);
  // A chat on a model on this computer: that model is current, and the Gateway's own (token-billed) models are one row away.
  const onThisComputer = open?.route === 'clikcode-local' ? open.model : undefined;
  const rows = (rowsOf: readonly HostedRow[]): PickerOption<HostedRow | typeof GATEWAY_MODELS>[] => rowsOf.map((row) => ({
    label: row.label,
    detail: `· ${[row.target === 'this-computer' && row.id === onThisComputer ? 'current' : '', HOSTED_TAGS[row.target], row.recommended ? 'recommended' : '', row.detail].filter(Boolean).join(' · ')}`,
    value: row,
    group: row.target === 'this-computer' ? 'Fits this computer' : 'ClikDeploy GPU',
  }));
  const initial = await withSlowWait(waiting, 'finding hosted AI models…', () => hostedList(''));
  for (const note of initial.unavailable) {
    if (note.target === 'clikdeploy') rl.panel?.('Hosted AI', 'ClikDeploy GPUs need an internet connection and a Gateway sign-in; models for this computer are listed.');
  }
  const gatewayRow: PickerOption<typeof GATEWAY_MODELS>[] = open?.route === 'clikcode-local'
    ? [{ label: 'ClikDeploy Gateway models…', detail: '· billed by the token, from every lab', value: GATEWAY_MODELS, group: 'ClikDeploy Gateway' }] : [];
  const picked = await chooseOption(rl, 'Hosted AI', [...rows(initial.rows), ...gatewayRow], undefined, {
    onFilter: async (query) => rows((await withSlowWait(waiting, 'searching…', () => hostedList(query))).rows),
  });
  if (picked === GATEWAY_MODELS) {
    // Moves the chat to the Gateway (a sign-in if it has none), then lists the Gateway's models.
    const moved = await selectProviderConversation(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }), rl, id, '__gateway__');
    return interactiveModelPicker(rl, moved);
  }
  const selected = picked;
  if (!selected) return;

  const adapter = hostedAdapter(selected.target);
  const plan = await withSlowWait(waiting, selected.target === 'clikdeploy' ? `checking ${selected.label} and matching compute…` : `checking ${selected.label}…`, () => adapter.plan(selected));
  const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  // Only what bills asks to be sure; "always start" is the user's own standing answer.
  if (plan.costly && !alwaysStartOwnModels(config)) {
    if (rl.panel) rl.panel(plan.title, plan.lines.join('\n')); else process.stdout.write(`\n${plan.title}\n${plan.lines.join('\n')}\n`);
    const answer = await chooseOption(rl, `Start ${selected.label}?`, [
      { label: `Yes, ${plan.confirm.charAt(0).toLowerCase()}${plan.confirm.slice(1)}`, value: 'start' },
      { label: 'No, choose another model', detail: 'Back to the list.', value: 'back' },
      { label: 'Always start hosted AI models', detail: 'Remember this on this machine.', value: 'always' },
    ]);
    if (answer === 'back') return interactiveHostedPicker(rl, id);
    if (answer === 'always') setAlwaysStartOwnModels(true, config);
    else if (answer !== 'start') return;
  } else if (!plan.costly) {
    // A download is told in full before it begins: its size, and that it works offline after.
    if (rl.panel) rl.panel(plan.title, plan.lines.join('\n'));
    const answer = await chooseOption(rl, plan.confirm, [
      { label: plan.confirm, value: 'start' },
      { label: 'Choose another model', value: 'back' },
    ]);
    if (answer === 'back') return interactiveHostedPicker(rl, id);
    if (answer !== 'start') return;
  }

  const selection = await withSlowWait(waiting, selected.target === 'clikdeploy' ? `starting ${selected.label} on ClikDeploy…` : `preparing ${selected.label}…`, () => adapter.start(selected));
  // The route may differ from the chat's (a Gateway chat choosing a model for this computer): the chat moves
  // onto it, history and all, as a provider change does.
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  let target = id;
  if (session?.route !== selection.route) target = await selectProviderConversation(config, rl, id, providerConversationKey(selection.route === 'gateway' ? GATEWAY_ID : LOCAL_ID));
  await aiSessionCommand(target, hostedSelectionCommand(selection));
}

/** A Gateway conversation's picker. Models run ClikCode locally; selected
 * platform agents run on ClikDeploy with their own tools. */
/** The row, in a chat on a model on this computer, that goes to the Gateway's own models. */
const GATEWAY_MODELS = '__gateway_models__' as const;

type GatewayChoice = { kind: 'agent'; id?: string } | { kind: 'model'; id: string } | { kind: 'subscriptions' } | { kind: 'hosted' };

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
    { label: 'Hosted AI…', detail: '· run a model on this computer (free, works offline) or on a ClikDeploy GPU', value: { kind: 'hosted' as const }, group: 'Hosted AI' },
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
    if (selected.kind === 'hosted') return interactiveHostedPicker(rl, id);
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
