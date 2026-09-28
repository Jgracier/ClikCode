/** The models ClikDeploy Gateway offers this account, for choosing one.
 *
 * The Gateway owns the list: one entry per model across the providers it has
 * connected, each with the cheapest access it can serve it through right now
 * (subscription, then free, then paid). Choosing one stores its id on the
 * session and sends it with every step; the Gateway then serves that model
 * from its cheapest provider and never swaps in a different one. No choice
 * (`null`) leaves the pick to the Gateway. */

import Conf from 'conf';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDirectory } from '../session/store/paths.js';
import { gatewayConnection } from '../agent/models/for-session.js';
import { CLIKCODE_USER_AGENT } from '../version.js';

export type GatewayModelAccess = 'subscription' | 'free-tier' | 'metered';

export interface GatewayModel {
  id: string;
  access: GatewayModelAccess;
  providers: { provider: string; access: GatewayModelAccess }[];
  contextWindow?: number;
  vision?: boolean;
  /** What a call costs this account, $ per 1M tokens: the full price, the
   * discount in force, and the price charged. Absent when the account is not
   * charged (unlimited) or the Gateway predates prices. */
  price?: GatewayModelPrice;
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

/** How the access tier reads beside a model. */
export function gatewayAccessLabel(access: GatewayModelAccess): string {
  return access === 'subscription' ? 'subscription' : access === 'free-tier' ? 'free' : 'paid';
}

/** One row's detail: the model's token price, and nothing else. Which of the
 * Gateway's providers serves it, and on what terms, is the Gateway's own
 * decision (the cheapest available) and not the user's concern. */
export function gatewayModelDetail(model: GatewayModel): string {
  return model.price ? gatewayPriceLabel(model.price) : '';
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
let cached: { baseUrl: string; at: number; list: GatewayModelList } | undefined;

/** The last list this machine received, kept on disk so /model opens at once
 * and refreshes in place instead of waiting on the Gateway. */
function diskCachePath(): string {
  return join(stateDirectory(), 'cache', 'gateway-models.json');
}

/** The last list received from `baseUrl`, however old, or undefined. */
export async function savedGatewayModels(options: { config?: Conf } = {}): Promise<GatewayModelList | undefined> {
  const { baseUrl } = gatewayConnection(options.config ?? new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
  try {
    const saved = JSON.parse(await readFile(diskCachePath(), 'utf8')) as { baseUrl?: string; list?: GatewayModelList };
    return saved.baseUrl === baseUrl && Array.isArray(saved.list?.models) ? saved.list : undefined;
  } catch {
    // fail-open-ok: no saved list (first use, or unreadable) means the picker waits for the Gateway, as before.
    return undefined;
  }
}

async function saveGatewayModels(baseUrl: string, list: GatewayModelList): Promise<void> {
  const file = diskCachePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ baseUrl, at: Date.now(), list }), { mode: 0o600 });
}

/** Words that mean "let the Gateway choose" rather than a model id. */
export function isAutomaticModelWord(value: string): boolean {
  return /^(auto|automatic|default|gateway)$/i.test(value.trim());
}

export async function gatewayModels(
  options: { config?: Conf; fetchImpl?: typeof fetch; fresh?: boolean } = {},
): Promise<GatewayModelList> {
  const { baseUrl, apiKey } = gatewayConnection(options.config ?? new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
  if (!options.fresh && cached && cached.baseUrl === baseUrl && Date.now() - cached.at < TTL_MS) return cached.list;
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/api/clikcode/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
  });
  const body = await response.json().catch(() => undefined) as { data?: GatewayModelList; error?: unknown } | undefined;
  if (!response.ok || !body?.data || !Array.isArray(body.data.models)) {
    // A Gateway that predates model choice answers 404.
    const reason = typeof body?.error === 'string' ? body.error : response.status === 404 ? 'this Gateway does not offer a model choice yet' : `HTTP ${response.status}`;
    throw Object.assign(new Error(`ClikDeploy Gateway models: ${reason}`), { statusCode: response.status });
  }
  cached = { baseUrl, at: Date.now(), list: body.data };
  // fail-open-ok: a list that cannot be saved still answers this request; only the next instant open is lost.
  await saveGatewayModels(baseUrl, body.data).catch(() => undefined);
  return body.data;
}

/** Test seam. */
export function resetGatewayModelCache(): void {
  cached = undefined;
}
