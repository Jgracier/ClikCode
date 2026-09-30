/** The editor's screens as data (IDE protocol revision 2).
 *
 * The terminal draws its pickers as text; an editor draws its own widgets --
 * a provider·model menu in the composer, a history list, an accounts page --
 * and needs the same facts as records. Every answer here is read from the
 * sources the terminal's pickers read (tui/pickers/*), in their order and
 * with their rules, so the two surfaces show the same thing. Choosing goes
 * the other way through `choose` in bridge.ts, onto the same commands the
 * pickers end in.
 */
import type Conf from 'conf';
import { getApiKeyForUrl, getApiUrl } from '../gateway/credentials.js';
import { savedGatewayModels, gatewayModels, gatewayModelDetail } from '../gateway/models.js';
import { gatewayEffort, GATEWAY_EFFORTS } from '../gateway/options.js';
import { inspectNativeHarnessForPicker } from '../harness/transport/native/inspect.js';
import { harnessInstallRoute } from '../harness/transport/native/install-route.js';
import { authEvidencePresent, hasAuthEvidence, harnessCanLogout } from '../harness/accounts/auth-files.js';
import { accountUsageReading } from '../harness/accounts/account-usage.js';
import { learnedUsageReading } from '../harness/accounts/usage-learning.js';
import { NATIVE_USAGE_PROBES } from '../harness/accounts/usage-probes.js';
import { accountQuotaSpent, usageReadingIsCurrent, type UsageWindow } from '../harness/accounts/usage-reading.js';
import { nativeModelCatalogForPicker } from '../harness/accounts/model-catalog.js';
import { effortChoicesFor } from '../harness/accounts/effort-choices.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import { vendorFacingOptions } from '../harness/options.js';
import {
  allLocalHarnesses, harnessCanRunTurns, harnessSupportsEffort, harnessTierRank, localHarnessCapabilityManifest,
  localHarnessForCommand, localHarnessForProvider,
} from '../runtime/lazy-bridge.js';
import { localModelChoices } from '../local-models/index.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { CLIKCODE_LOCAL_LABEL, isClikCodeAgent, isGatewayService } from '../session/route.js';
import { conversationIdFor, integrationLabel, optionForHarness, sessionPermissionModes, VALID_EFFORTS } from '../session/options.js';
import { sessionClaimIsLive } from '../session/claim.js';
import { liveWorkerSessions, sessionActivity } from '../session/liveness.js';
import { sessionTranscriptMessages } from '../turn/checkpoint.js';
import { sessionModelLabel } from '../harness/output.js';
import { modelRow } from '../tui/pickers/model.js';
import { CLIKCODE_USER_AGENT } from '../version.js';
import type {
  IdeAccount, IdeAccounts, IdeChatSettings, IdeConversation, IdeGateway, IdeModel, IdeModels, IdeProvider, IdeUsageWindow,
} from './protocol.js';

export const GATEWAY_ID = 'gateway';
export const LOCAL_ID = 'clikcode-local';
/** How long the editor's model menu waits for a harness to list its models. */
const IDE_MODEL_DISCOVERY_WAIT_MS = 45_000;

function harnessOf(session: HarnessSession | undefined): AiLocalHarnessDefinition | undefined {
  if (!session || isClikCodeAgent(session)) return undefined;
  return session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
    : session.provider ? localHarnessForProvider(session.provider) : undefined;
}

/** The account a model list is read with: the chat's own on that provider,
 * else the first ready one there. */
function accountFor(state: HarnessState, session: HarnessSession | undefined, harness: AiLocalHarnessDefinition): AiHarnessAccount | undefined {
  const own = session?.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  if (own && own.provider === harness.provider) return own;
  return state.accounts.find((item) => item.provider === harness.provider && item.status === 'ready');
}

function choosesModel(harness: AiLocalHarnessDefinition): boolean {
  return harness.modelArgvPrefix !== undefined || Boolean(harness.acp?.listsModels);
}

/** Every provider the terminal's /provider lists, in its order: the two
 * ClikCode routes, then installed harnesses, then the catalog's tiers. */
export async function providerList(config: Conf, state: HarnessState, session: HarnessSession | undefined): Promise<IdeProvider[]> {
  const harnesses = allLocalHarnesses().filter((harness) => harnessCanRunTurns(harness));
  const inspected = await Promise.all(harnesses.map(async (harness) => ({ harness, inspection: await inspectNativeHarnessForPicker(harness) })));
  inspected.sort((left, right) => Number(right.inspection.installed) - Number(left.inspection.installed)
    || harnessTierRank(left.harness) - harnessTierRank(right.harness));
  const ready = new Set(state.accounts.filter((item) => item.status === 'ready').map((item) => item.provider));
  const gatewayConnected = Boolean(getApiKeyForUrl(config, getApiUrl(config)));
  const rows: IdeProvider[] = [
    {
      id: GATEWAY_ID, kind: 'gateway', name: 'ClikDeploy Gateway', installed: true, install: 'ready',
      signedIn: gatewayConnected, accounts: gatewayConnected ? 1 : 0, current: session?.route === 'gateway', choosesModel: true,
    },
    {
      id: LOCAL_ID, kind: 'clikcode-local', name: CLIKCODE_LOCAL_LABEL, installed: true, install: 'ready',
      signedIn: true, accounts: 0, current: session?.route === 'clikcode-local', choosesModel: true,
    },
  ];
  for (const { harness, inspection } of inspected) {
    const signedIn = ready.has(harness.provider) || (inspection.installed && hasAuthEvidence(harness) && await authEvidencePresent(harness, {}).catch(() => false));
    rows.push({
      id: harness.command, kind: 'harness', name: harness.displayName, installed: inspection.installed,
      ...(inspection.version ? { version: inspection.version } : {}),
      install: inspection.installed ? 'ready' : harnessInstallRoute(harness).kind !== 'none' ? 'auto' : 'manual',
      integration: integrationLabel(harness),
      signedIn, accounts: state.accounts.filter((item) => item.provider === harness.provider).length,
      current: session?.route === 'local' && session.nativeHarness === harness.command,
      choosesModel: choosesModel(harness),
    });
  }
  return rows;
}

/** A provider's models, as its /model picker lists them. */
export async function modelList(config: Conf, state: HarnessState, session: HarnessSession | undefined, provider: string): Promise<IdeModels> {
  if (provider === GATEWAY_ID) {
    const list = await savedGatewayModels({ config }) ?? await gatewayModels({ config, fresh: true });
    const current = session && isGatewayService(session) ? session.model ?? undefined : undefined;
    return {
      provider, custom: false, ...(current ? { current } : {}),
      models: [
        { id: 'auto', label: 'Automatic', detail: `the Gateway chooses${list.automatic ? ` (now ${list.automatic})` : ''}`, current: session?.route === 'gateway' && !current },
        ...list.models.map((model) => ({ id: model.id, label: model.id, ...(gatewayModelDetail(model) ? { detail: gatewayModelDetail(model) } : {}), current: model.id === current })),
      ],
    };
  }
  if (provider === LOCAL_ID) {
    const current = session?.route === 'clikcode-local' ? session.model ?? undefined : undefined;
    const choices = await localModelChoices();
    return {
      provider, custom: false, ...(current ? { current } : {}),
      models: choices.map((choice) => ({
        id: choice.id, label: choice.label,
        detail: [choice.recommended ? 'recommended' : undefined, choice.detail].filter(Boolean).join(' · '),
        current: choice.id === current,
        ...(choice.fits ? {} : { unavailable: choice.detail }),
      })),
    };
  }
  const harness = localHarnessForCommand(provider);
  if (!harness) throw new Error(`unknown provider "${provider}"`);
  if (!choosesModel(harness)) return { provider, models: [], custom: false, error: `${harness.displayName} does not publish a model selector.` };
  const onIt = session?.route === 'local' && session.nativeHarness === harness.command ? session : undefined;
  // The terminal's picker gives discovery 3 s and redraws when it lands; the
  // editor's menu shows a spinner and draws once, so it waits for the list.
  const catalog = await nativeModelCatalogForPicker(harness, accountFor(state, session, harness), IDE_MODEL_DISCOVERY_WAIT_MS);
  const effective = onIt?.model ?? catalog.configured ?? undefined;
  const models: IdeModel[] = [...catalog.models]
    .sort((left, right) => (left === effective ? -1 : right === effective ? 1 : left.localeCompare(right)))
    .map((model) => {
      const row = modelRow(harness, catalog, model, effective);
      const detail = row.detail?.replace(/^·\s*/, '').replace(/(?:^|\s·\s)current$/, '').trim();
      return { id: model, label: row.label, ...(detail ? { detail } : {}), current: Boolean(onIt) && model === effective };
    });
  return { provider, models, custom: true, ...(effective ? { current: effective } : {}) };
}

/** The conversations /resume lists: one row per conversation (its latest
 * chat), running ones first, then by recency. */
export async function conversationList(state: HarnessState, currentId: string | undefined): Promise<IdeConversation[]> {
  const sessions = state.sessions
    .filter((session) => session.status !== 'archived' || session.id === currentId)
    .filter((session) => session.id === currentId || sessionTranscriptMessages(session).length > 0 || Boolean(session.nativeSessionId));
  const live = await liveWorkerSessions(sessions);
  const now = Date.now();
  const byRoot = new Map<string, HarnessSession[]>();
  for (const session of sessions) {
    const root = conversationIdFor(session);
    byRoot.set(root, [...(byRoot.get(root) ?? []), session]);
  }
  const rows: IdeConversation[] = [];
  for (const group of byRoot.values()) {
    const latest = [...group].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!;
    const activity = group.map((session) => sessionActivity(session, live, now)).find((value) => value === 'working')
      ?? group.map((session) => sessionActivity(session, live, now)).find(Boolean);
    const messages = sessionTranscriptMessages(latest);
    const last = messages.at(-1)?.content.replace(/\s+/g, ' ').trim();
    const harness = latest.nativeHarness ? localHarnessForCommand(latest.nativeHarness) : undefined;
    const isCurrent = group.some((session) => session.id === currentId);
    rows.push({
      id: latest.id,
      title: latest.name?.replace(/\s+\(from [^)]+\)$/i, '').trim() || messages.find((message) => message.role === 'user')?.content.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled chat',
      ...(latest.route === 'gateway' ? { provider: 'ClikDeploy Gateway' } : latest.route === 'clikcode-local' ? { provider: CLIKCODE_LOCAL_LABEL } : harness ? { provider: harness.displayName } : {}),
      ...(latest.model ? { model: sessionModelLabel(latest) ?? latest.model } : {}),
      ...(latest.workspace ? { workspace: latest.workspace } : {}),
      updatedAt: latest.updatedAt,
      messages: messages.length,
      ...(last ? { preview: last.slice(0, 140) } : {}),
      ...(activity ?? (isCurrent ? 'idle' : undefined) ? { activity: activity ?? 'idle' } : {}),
      current: isCurrent,
      elsewhere: !isCurrent && group.some((session) => sessionClaimIsLive(session)),
      history: group.length,
    });
  }
  const rank = (row: IdeConversation): number => (row.activity === 'working' ? 0 : row.activity === 'idle' ? 1 : 2);
  return rows.sort((left, right) => rank(left) - rank(right) || right.updatedAt.localeCompare(left.updatedAt));
}

function windowsOf(windows: readonly UsageWindow[] | undefined): IdeUsageWindow[] {
  return (windows ?? []).map((window) => ({ name: window.name, usedPct: window.usedPct, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) }));
}

/** Every account, grouped by provider, with its usage: what the account
 * record last published when `network` is off (instant), a fresh reading from
 * the vendor when it is on -- the terminal's account picker does both, in
 * that order. */
export async function accountList(state: HarnessState, session: HarnessSession | undefined, network: boolean): Promise<IdeAccounts> {
  const now = Date.now();
  const accounts = await Promise.all(state.accounts.map(async (account): Promise<IdeAccount> => {
    const harness = localHarnessForProvider(account.provider);
    let usage: IdeAccount['usage'];
    if (harness && account.authKind === 'vendor-cli') {
      if (network && NATIVE_USAGE_PROBES[harness.command]) {
        const reading = await accountUsageReading(account, state, { network: true }).catch(() => undefined);
        if (reading) usage = { ...(reading.label ? { label: reading.label } : {}), windows: windowsOf(reading.windows) };
      } else {
        const shared = account.usage as (AiHarnessAccount['usage'] & { windows?: UsageWindow[] }) | undefined;
        if (shared && !shared.failed && shared.windows?.length && usageReadingIsCurrent(shared, now)) {
          usage = { ...(shared.label ? { label: shared.label } : {}), windows: windowsOf(shared.windows) };
        }
      }
      if (!usage && !NATIVE_USAGE_PROBES[harness.command]) {
        const learned = learnedUsageReading(account.usageLearning, state.invocations, account.id, now);
        if (learned) usage = { ...(learned.label ? { label: learned.label } : {}), windows: windowsOf(learned.windows), learned: true };
      }
    }
    const problem: IdeAccount['problem'] = account.verification ? 'verify'
      : account.status === 'needs_login' ? 'reauth'
        : accountQuotaSpent(account, now) ? 'out-of-usage' : undefined;
    const actions: IdeAccount['actions'] = [
      ...(harness?.loginArgv && account.authKind === 'vendor-cli' && account.status !== 'ready' ? ['reauthenticate' as const] : []),
      ...(account.verification ? ['verified' as const] : []),
      harness && harnessCanLogout(harness) && account.authKind === 'vendor-cli' && account.status === 'ready' ? 'disconnect' as const : 'remove' as const,
    ];
    return {
      id: account.id, provider: account.provider, ...(harness ? { harness: harness.command } : {}),
      providerName: harness?.displayName ?? account.provider, label: account.label, status: account.status,
      ...(problem ? { problem } : {}), current: account.id === session?.accountId,
      ...(usage ? { usage } : {}), actions,
    };
  }));
  accounts.sort((left, right) => left.providerName.localeCompare(right.providerName) || left.label.localeCompare(right.label));
  const addable = allLocalHarnesses()
    .filter((harness) => harnessCanRunTurns(harness) && (harness.localAuth.includes('api-key') || Boolean(harness.loginArgv)))
    .sort((left, right) => harnessTierRank(left) - harnessTierRank(right))
    .map((harness) => ({ provider: harness.command, name: harness.displayName }));
  return { accounts, addable, failover: (session?.accountFailover ?? 'on-quota-exhausted') === 'never' ? 'never' : 'auto' };
}

/** The choices the composer footer offers for this chat: what /effort and
 * /permissions would list, and the Settings rows that are a switch. */
export async function chatSettings(state: HarnessState, session: HarnessSession): Promise<IdeChatSettings> {
  const harness = harnessOf(session);
  const settings: IdeChatSettings = {};
  if (isGatewayService(session)) {
    const current = gatewayEffort(session);
    settings.effort = { ...(current ? { current } : {}), choices: [...GATEWAY_EFFORTS] };
    settings.fast = session.speed === 'fast';
  } else if (harness && harnessSupportsEffort(harness)) {
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    const discovered = (await effortChoicesFor(harness, account, session.model).catch(() => ({ values: [] as string[] }))).values;
    const fromCatalog = optionForHarness(harness, 'effort')?.values ?? [];
    const choices = discovered.length ? discovered : fromCatalog.length ? fromCatalog : [...VALID_EFFORTS];
    settings.effort = { ...(session.effort && session.effort !== 'platform-managed' ? { current: session.effort } : {}), choices: [...choices] };
  }
  const permissions = sessionPermissionModes(session, isClikCodeAgent(session) ? undefined : harness);
  if (permissions.length) settings.permissions = { current: session.permissionMode ?? 'ask', choices: [...permissions] };
  if (harness) {
    settings.failover = (session.accountFailover ?? 'on-quota-exhausted') === 'never' ? 'never' : 'auto';
    if (harness.planMode) settings.plan = session.harnessOptions?.[harness.planMode.option] === harness.planMode.value;
    const available = vendorFacingOptions(localHarnessCapabilityManifest(harness).options, harness).length;
    if (available) settings.options = { available, set: Object.keys(session.harnessOptions ?? {}).length };
  }
  return settings;
}

/** Whether the Gateway is connected, and the credit its calls are paid from
 * (`GET /v1/credits`, the same ledger `clikcode gateway usage` reads). */
export async function gatewayStatus(config: Conf, fetchImpl: typeof fetch = fetch): Promise<IdeGateway> {
  const apiUrl = getApiUrl(config);
  const apiKey = getApiKeyForUrl(config, apiUrl);
  if (!apiKey) return { connected: false, apiUrl };
  try {
    const response = await fetchImpl(new URL('/v1/credits', apiUrl), {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => undefined) as { data?: Record<string, unknown> } | undefined;
    if (!response.ok || !body?.data) return { connected: true, apiUrl, error: `the Gateway answered HTTP ${response.status}` };
    return { connected: true, apiUrl, credit: creditOf(body.data) };
  } catch (error) {
    return { connected: true, apiUrl, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The Gateway's credit record, whichever unit it states the balance in. */
export function creditOf(data: Record<string, unknown>): NonNullable<IdeGateway['credit']> {
  const number = (value: unknown): number | undefined => {
    const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const micro = number(data.balanceMicroUsd);
  const cents = number(data.balanceCents);
  const usd = number(data.balanceUsd);
  const balanceUsd = micro !== undefined ? micro / 1_000_000 : cents !== undefined ? cents / 100 : usd;
  return {
    unlimited: data.unlimited === true,
    ...(balanceUsd !== undefined ? { balanceUsd } : {}),
    ...(typeof data.allowed === 'boolean' ? { allowed: data.allowed } : {}),
    ...(typeof data.autoTopUpEnabled === 'boolean' ? { autoTopUp: data.autoTopUpEnabled } : {}),
  };
}

/** A Stripe checkout page for Gateway credit; the editor opens it. */
export async function gatewayCheckoutUrl(config: Conf, fetchImpl: typeof fetch = fetch): Promise<string> {
  const apiUrl = getApiUrl(config);
  const apiKey = getApiKeyForUrl(config, apiUrl);
  if (!apiKey) throw new Error('Sign in to ClikDeploy Gateway first.');
  const response = await fetchImpl(new URL('/v1/credits/checkout', apiUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
    body: '{}',
  });
  const body = await response.json().catch(() => undefined) as { data?: { url?: unknown } } | undefined;
  const url = typeof body?.data?.url === 'string' ? body.data.url : undefined;
  if (!response.ok || !url) throw new Error(`ClikDeploy Gateway credit: HTTP ${response.status}`);
  return url;
}

export { harnessOf as sessionHarnessDefinition };
