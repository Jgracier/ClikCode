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
import { stateDirectory } from '../session/store/paths.js';
import { gatewayConnection } from '../agent/models/for-session.js';
import { CLIKCODE_USER_AGENT } from '../version.js';

export interface GatewayModel {
  id: string;
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

export type GatewayAccess = 'subscription' | 'free' | 'paid';
const ACCESS = new Set<string>(['subscription', 'free', 'paid']);

/** A model as a row names it: `claude-opus-5-5 (subscription)` where the Gateway says which tier serves it. */
export function gatewayModelLabel(model: GatewayModel): string {
  return model.access ? `${model.id} (${model.access})` : model.id;
}

export interface GatewayModelPrice {
  full: { inMTok: number; outMTok: number };
  discountPercent: number;
  charged: { inMTok: number; outMTok: number };
}

export interface GatewayModelList {
  /** What the Gateway picks when nothing is chosen. */
  automatic: string | null;
  models: GatewayModel[];
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
let cached: { baseUrl: string; auth: string; at: number; list: GatewayModelList } | undefined;

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
  const { baseUrl, apiKey } = gatewayConnection(options.config ?? new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
  try {
    const saved = JSON.parse(await readFile(diskCachePath(), 'utf8')) as { baseUrl?: string; auth?: string; list?: GatewayModelList };
    return saved.baseUrl === baseUrl && saved.auth === authDigest(apiKey) && Array.isArray(saved.list?.models) ? saved.list : undefined;
  } catch {
    // fail-open-ok: no saved list (first use, or unreadable) means the picker waits for the Gateway, as before.
    return undefined;
  }
}

async function saveGatewayModels(baseUrl: string, auth: string, list: GatewayModelList): Promise<void> {
  const file = diskCachePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ baseUrl, auth, at: Date.now(), list }), { mode: 0o600 });
}

/** Words that mean "let the Gateway choose" rather than a model id. */
export function isAutomaticModelWord(value: string): boolean {
  return /^(auto|automatic|default|gateway)$/i.test(value.trim());
}

export async function gatewayModels(
  options: { config?: Conf; fetchImpl?: typeof fetch; fresh?: boolean } = {},
): Promise<GatewayModelList> {
  const { baseUrl, apiKey } = gatewayConnection(options.config ?? new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
  const auth = authDigest(apiKey);
  if (!options.fresh && cached && cached.baseUrl === baseUrl && cached.auth === auth && Date.now() - cached.at < TTL_MS) return cached.list;
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
  });
  const body = await response.json().catch(() => undefined) as { data?: unknown; error?: unknown } | undefined;
  if (!response.ok || !Array.isArray(body?.data)) {
    // A Gateway that predates its OpenAI-compatible API answers 404.
    const error = body?.error;
    const message = typeof error === 'string' ? error : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : undefined;
    const reason = message ?? (response.status === 404 ? 'this Gateway does not offer a model choice yet' : `HTTP ${response.status}`);
    throw Object.assign(new Error(`ClikDeploy Gateway models: ${reason}`), { statusCode: response.status });
  }
  const list = fromOpenAIModelList(body.data);
  cached = { baseUrl, auth, at: Date.now(), list };
  // fail-open-ok: a list that cannot be saved still answers this request; only the next instant open is lost.
  await saveGatewayModels(baseUrl, auth, list).catch(() => undefined);
  return list;
}

/** The id the Gateway takes for "you choose". */
export const GATEWAY_AUTO_MODEL = 'auto';

/** OpenAI's model list, as the Gateway sends it, to the list ClikCode shows:
 * `auto` names the automatic pick (its `root`) rather than being a row. */
export function fromOpenAIModelList(data: readonly unknown[]): GatewayModelList {
  let automatic: string | null = null;
  const models: GatewayModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as {
      id?: unknown; root?: unknown; type?: unknown; access?: unknown; context_length?: unknown; max_output_tokens?: unknown; tokens_per_second?: unknown;
      capabilities?: { vision?: unknown; reasoning?: unknown }; pricing?: Record<string, unknown>;
    };
    if (typeof entry.id !== 'string' || !entry.id) continue;
    // Embedding models share the list; a conversation cannot run on one.
    if (entry.type === 'embedding') continue;
    if (entry.id === GATEWAY_AUTO_MODEL) {
      if (typeof entry.root === 'string' && entry.root) automatic = entry.root;
      continue;
    }
    const pricing = entry.pricing;
    const num = (key: string) => (typeof pricing?.[key] === 'number' ? pricing[key] as number : undefined);
    const charged = { inMTok: num('input_per_mtok'), outMTok: num('output_per_mtok') };
    models.push({
      id: entry.id,
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
  return { automatic, models };
}

/** Test seam. */
export function resetGatewayModelCache(): void {
  cached = undefined;
}
