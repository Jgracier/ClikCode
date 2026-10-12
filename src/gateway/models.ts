/** The models ClikDeploy Gateway offers this account, for choosing one.
 *
 * The Gateway owns the list (`GET /v1/models`, OpenAI's model list): one entry per model, whichever of its providers serves it. Choosing
 * one stores its id on the session and sends it as `model` with every step;
 * the Gateway serves that model from its cheapest provider and never swaps in
 * a different one. No choice (`null`) sends `auto`: the Gateway picks. */

import Conf from 'conf';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withoutFreeTag } from '../harness/model-label.js';
import { stateDirectory } from '../session/store/paths.js';
import { gatewayConnection } from '../agent/models/for-session.js';
import { CLIKCODE_USER_AGENT } from '../version.js';
import { gatewaySubscriptionsOn, subscriptionsHeader } from './subscriptions.js';

export interface GatewayModel {
  id: string;
  /** The lab that made it (`anthropic`, `meta`), as the Gateway names it; absent when unknown. Never who serves it. */
  maker?: string;
  contextWindow?: number;
  /** Takes images beside text: ClikCode sends a message's images to it. */
  vision?: boolean;
  /** A reasoning model: /effort changes how hard it thinks. */
  reasoning?: boolean;
  /** The most it writes in one answer. */
  maxOutput?: number;
  /** Its fastest provider's measured generation rate. */
  tokensPerSecond?: number;
  /** What a call costs this account, $ per 1M tokens: the full price, the
   * discount in force, and the price charged. Absent when the account is not
   * charged (unlimited) or the Gateway predates prices. */
  price?: GatewayModelPrice;
  /** Which tier the Gateway serves it from right now. Sent to the super admin
   * only: everyone else sees the model alone. */
  access?: GatewayAccess;
}

type GatewayAccess = 'subscription' | 'free' | 'paid';
const ACCESS = new Set<string>(['subscription', 'free', 'paid']);

/** A model as a row names it: `claude-opus-5-5 (subscription)` where the Gateway says which tier serves it. */
export function gatewayModelLabel(model: GatewayModel): string {
  const name = withoutFreeTag(model.id);
  return model.access ? `${name} (${model.access})` : name;
}

const MAKER_NAMES: Readonly<Record<string, string>> = {
  openai: 'OpenAI', xai: 'xAI', zai: 'Z.ai', ibm: 'IBM', bytedance: 'ByteDance', nousresearch: 'Nous Research',
  inclusionai: 'inclusionAI', aionlabs: 'AionLabs', 'nex-agi': 'Nex AGI', 'nomic-ai': 'Nomic', deepseek: 'DeepSeek',
  minimax: 'MiniMax', moonshot: 'Moonshot AI', thinkingmachines: 'Thinking Machines', sao10k: 'Sao10K', nvidia: 'NVIDIA',
};

/** Where a model sits in a list of models: its maker's name, or "Other". */
export function gatewayMakerName(model: GatewayModel): string {
  const maker = model.maker;
  if (!maker) return 'Other';
  return MAKER_NAMES[maker] ?? maker.replace(/(^|[-_ ])(\w)/g, (_m, space: string, letter: string) => `${space ? ' ' : ''}${letter.toUpperCase()}`);
}

/** The models ordered by maker (A to Z, Other last), each maker's models in the list's own order. */
export function gatewayModelsByMaker(models: readonly GatewayModel[]): GatewayModel[] {
  const key = (model: GatewayModel): string => (model.maker ? gatewayMakerName(model).toLowerCase() : '\uffff');
  return [...models].sort((left, right) => key(left).localeCompare(key(right)));
}

export interface GatewayModelPrice {
  full: { inMTok: number; outMTok: number };
  discountPercent: number;
  charged: { inMTok: number; outMTok: number };
}

/** What the Gateway says about Automatic itself. Never which model it picks:
 * the Gateway does not say, and the client must not show or lean on it. */
interface GatewayAutoFacts { contextWindow?: number; maxOutput?: number; vision?: boolean }

export interface GatewayModelList {
  /** The facts the Gateway lists for `auto`; null from a Gateway that lists none. */
  auto: GatewayAutoFacts | null;
  models: GatewayModel[];
  /** The super admin's subscription switch (subscriptions.ts), as the list was asked for. Absent for
   * everyone else: its presence is what shows the switch. */
  subscriptions?: boolean;
}

/** One row's detail: the model's token price, then what it can do beyond
 * text (images, reasoning) and how fast it answers. Which of the Gateway's
 * providers serves it, and on what terms, is the Gateway's own decision (the
 * cheapest available) and not the user's concern. */
export function gatewayModelDetail(model: GatewayModel): string {
  return [
    model.price ? gatewayPriceLabel(model.price) : '',
    model.vision ? 'images' : '',
    model.reasoning ? 'reasoning' : '',
    model.tokensPerSecond ? `${Math.round(model.tokensPerSecond)} tok/s` : '',
  ].filter(Boolean).join(' · ');
}

/** `$4/$20 per 1M`, or with a discount `$4/$20 → $3/$15 per 1M (25% off)`: input/output. */
export function gatewayPriceLabel(price: GatewayModelPrice): string {
  const money = (n: number) => `$${Number(n.toFixed(n < 1 ? 3 : 2))}`;
  const pair = (rate: { inMTok: number; outMTok: number }) => `${money(rate.inMTok)}/${money(rate.outMTok)}`;
  const full = pair(price.full);
  const charged = pair(price.charged);
  if (price.discountPercent <= 0 || charged === full) return `${full} per 1M`;
  return `${full} → ${charged} per 1M (${price.discountPercent}% off)`;
}

const TTL_MS = 60_000;
let cached: { baseUrl: string; auth: string; subscriptions: boolean; at: number; list: GatewayModelList } | undefined;

/** The model list includes account-specific access and prices. Keep a digest,
 * never the credential itself, beside its cache entry. */
function authDigest(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/** The last list this machine received, kept on disk so /model opens at once
 * and refreshes in place instead of waiting on the Gateway. */
function diskCachePath(): string {
  return join(stateDirectory(), 'cache', 'gateway-models.json');
}

/** The last list received from `baseUrl`, however old, or undefined. */
export async function savedGatewayModels(options: { config?: Conf } = {}): Promise<GatewayModelList | undefined> {
  const config = options.config ?? new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  const { baseUrl, apiKey } = gatewayConnection(config);
  try {
    const saved = JSON.parse(await readFile(diskCachePath(), 'utf8')) as { baseUrl?: string; auth?: string; subscriptions?: boolean; list?: GatewayModelList };
    // A list asked for with the other switch position is another list (subscription models or not).
    const sameSwitch = (saved.subscriptions ?? true) === gatewaySubscriptionsOn(config);
    return saved.baseUrl === baseUrl && saved.auth === authDigest(apiKey) && sameSwitch && Array.isArray(saved.list?.models) ? saved.list : undefined;
  } catch {
    // fail-open-ok: no saved list (first use, or unreadable) means the picker waits for the Gateway, as before.
    return undefined;
  }
}

async function saveGatewayModels(baseUrl: string, auth: string, subscriptions: boolean, list: GatewayModelList): Promise<void> {
  const file = diskCachePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ baseUrl, auth, subscriptions, at: Date.now(), list }), { mode: 0o600 });
}

/** One model however it is spelled: `claude-opus-5-5` and `claude-opus-5.5` (case, `.`, `_` folded). */
export function sameGatewayModel(a: string, b: string): boolean {
  const fold = (id: string) => id.trim().toLowerCase().split('/').pop()!.replace(/[._]/g, '-');
  return fold(a) === fold(b);
}

/**
 * The model a typed word names in the Gateway's list: the id itself, however spelled; else the
 * newest model whose name holds every word (`opus` → `claude-opus-5.5`, ahead of `claude-opus-5`
 * and of its dearer `-fast` lane). Undefined when nothing holds them.
 */
export function gatewayModelForWord(models: readonly GatewayModel[], value: string): GatewayModel | undefined {
  const exact = models.find((model) => sameGatewayModel(model.id, value));
  if (exact) return exact;
  const words = value.trim().toLowerCase().split(/[\s-]+/).filter(Boolean);
  const parts = (id: string) => id.toLowerCase().split(/[-._/:\s]+/);
  const holding = models.filter((model) => words.every((word) => parts(model.id).includes(word)));
  const version = (id: string) => parts(id).filter((part) => /^\d+$/.test(part)).map(Number);
  const newer = (a: GatewayModel, b: GatewayModel): number => {
    const x = version(a.id);
    const y = version(b.id);
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((y[i] ?? -1) !== (x[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1);
    return Number(parts(a.id).includes('fast')) - Number(parts(b.id).includes('fast'));
  };
  return [...holding].sort(newer)[0];
}

export function isAutomaticModelWord(value: string): boolean {
  return /^(auto|automatic|default|gateway)$/i.test(value.trim());
}

export async function gatewayModels(
  options: { config?: Conf; fetchImpl?: typeof fetch; fresh?: boolean } = {},
): Promise<GatewayModelList> {
  const config = options.config ?? new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  const { baseUrl, apiKey } = gatewayConnection(config);
  const auth = authDigest(apiKey);
  const subscriptions = gatewaySubscriptionsOn(config);
  if (!options.fresh && cached && cached.baseUrl === baseUrl && cached.auth === auth && cached.subscriptions === subscriptions && Date.now() - cached.at < TTL_MS) return cached.list;
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': CLIKCODE_USER_AGENT, ...subscriptionsHeader(subscriptions) },
  });
  const body = await response.json().catch(() => undefined) as { data?: unknown; error?: unknown; clikcode?: { subscriptions?: unknown } } | undefined;
  if (!response.ok || !Array.isArray(body?.data)) {
    // A Gateway that predates its OpenAI-compatible API answers 404.
    const error = body?.error;
    const message = typeof error === 'string' ? error : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : undefined;
    const reason = message ?? (response.status === 404 ? 'this Gateway does not offer a model choice yet' : `HTTP ${response.status}`);
    throw Object.assign(new Error(`ClikDeploy Gateway models: ${reason}`), { statusCode: response.status });
  }
  const switchState = body.clikcode?.subscriptions;
  const list = { ...fromOpenAIModelList(body.data), ...(typeof switchState === 'boolean' ? { subscriptions: switchState } : {}) };
  cached = { baseUrl, auth, subscriptions, at: Date.now(), list };
  // fail-open-ok: a list that cannot be saved still answers this request; only the next instant open is lost.
  await saveGatewayModels(baseUrl, auth, subscriptions, list).catch(() => undefined);
  return list;
}

/** The id the Gateway takes for "you choose". */
const GATEWAY_AUTO_MODEL = 'auto';

/** OpenAI's model list, as the Gateway sends it, to the list ClikCode shows:
 * `auto` is not a row: it supplies the facts Automatic runs under. */
export function fromOpenAIModelList(data: readonly unknown[]): GatewayModelList {
  let auto: GatewayAutoFacts | null = null;
  const models: GatewayModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as {
      id?: unknown; owned_by?: unknown; root?: unknown; type?: unknown; access?: unknown; context_length?: unknown; max_output_tokens?: unknown; tokens_per_second?: unknown;
      capabilities?: { vision?: unknown; reasoning?: unknown }; pricing?: Record<string, unknown>;
    };
    if (typeof entry.id !== 'string' || !entry.id) continue;
    // Embedding models share the list; a conversation cannot run on one.
    if (entry.type === 'embedding') continue;
    if (entry.id === GATEWAY_AUTO_MODEL) {
      const contextWindow = typeof entry.context_length === 'number' && entry.context_length > 0 ? entry.context_length : undefined;
      const maxOutput = typeof entry.max_output_tokens === 'number' && entry.max_output_tokens > 0 ? entry.max_output_tokens : undefined;
      auto = {
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutput ? { maxOutput } : {}),
        ...(entry.capabilities?.vision === true ? { vision: true } : {}),
      };
      continue;
    }
    const pricing = entry.pricing;
    const num = (key: string) => (typeof pricing?.[key] === 'number' ? pricing[key] as number : undefined);
    const charged = { inMTok: num('input_per_mtok'), outMTok: num('output_per_mtok') };
    models.push({
      id: entry.id,
      ...(typeof entry.owned_by === 'string' && entry.owned_by && entry.owned_by !== 'clikdeploy' ? { maker: entry.owned_by } : {}),
      ...(typeof entry.access === 'string' && ACCESS.has(entry.access) ? { access: entry.access as GatewayAccess } : {}),
      ...(typeof entry.context_length === 'number' && entry.context_length > 0 ? { contextWindow: entry.context_length } : {}),
      ...(entry.capabilities?.vision === true ? { vision: true } : {}),
      ...(entry.capabilities?.reasoning === true ? { reasoning: true } : {}),
      ...(typeof entry.max_output_tokens === 'number' && entry.max_output_tokens > 0 ? { maxOutput: entry.max_output_tokens } : {}),
      ...(typeof entry.tokens_per_second === 'number' && entry.tokens_per_second > 0 ? { tokensPerSecond: entry.tokens_per_second } : {}),
      ...(charged.inMTok !== undefined && charged.outMTok !== undefined
        ? {
            price: {
              full: { inMTok: num('full_input_per_mtok') ?? charged.inMTok, outMTok: num('full_output_per_mtok') ?? charged.outMTok },
              discountPercent: num('discount_percent') ?? 0,
              charged: { inMTok: charged.inMTok, outMTok: charged.outMTok },
            },
          }
        : {}),
    });
  }
  return { auto, models };
}

/** Test seam. */
export function resetGatewayModelCache(): void {
  cached = undefined;
}
