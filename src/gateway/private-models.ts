/** ClikDeploy's authenticated model deployment flow for private Hugging Face models. */
import Conf from 'conf';
import { gatewayConnection } from '../agent/models/for-session.js';
import { CLIKCODE_USER_AGENT } from '../version.js';

export interface DeployableModel {
  sourceId: string;
  modelId: string;
  displayName: string;
  parameterCount?: number;
  gated: boolean;
  modality?: string;
}

export interface PrivateModelQuote {
  manifest: { displayName: string; quantizations: Array<{ label: string }> };
  quant: { label: string } | null;
  runtime: { name: string };
  vram: { totalGb: number };
  sku: { displayName: string };
  pricePerHour: number;
  /** Estimated decode speed on the chosen GPU. */
  throughput?: { decodeTokensPerSec?: number; usability?: string };
  /** The window the model will serve, in tokens. */
  servingContext?: { tokens?: number };
  /** What the planner wants said about the choice: a larger version passed over, an estimated size, a gated model. */
  warnings?: string[];
}

/** The quote as lines a narrow screen can wrap: what runs, on which GPU, what it costs, and what the planner flagged. */
export function quoteSummary(model: Pick<DeployableModel, 'modelId' | 'displayName'>, quote: PrivateModelQuote): { title: string; body: string } {
  const gb = (n: number): string => `${Math.ceil(n)} GB`;
  const model_ = [quote.quant?.label, quote.runtime?.name, quote.vram?.totalGb ? `needs about ${gb(quote.vram.totalGb)} of GPU memory` : undefined].filter(Boolean).join(' · ');
  const lines = [
    `GPU: ${quote.sku.displayName}`,
    `Price: $${quote.pricePerHour.toFixed(2)} per hour while it runs; nothing once it is stopped`,
    ...(model_ ? [`Model: ${model_}`] : []),
    ...(quote.throughput?.decodeTokensPerSec ? [`Speed: about ${Math.round(quote.throughput.decodeTokensPerSec)} tokens per second (estimate)`] : []),
    ...(quote.servingContext?.tokens ? [`Context: ${quote.servingContext.tokens.toLocaleString('en-US')} tokens`] : []),
    ...(quote.warnings ?? []).map((warning) => `Note: ${warning}`),
  ];
  return { title: `${model.displayName || model.modelId} on ClikDeploy`, body: lines.join('\n') };
}

async function request<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const { baseUrl, apiKey } = gatewayConnection(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      'user-agent': CLIKCODE_USER_AGENT,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => undefined) as {
    data?: T;
    error?: string | { message?: string };
    message?: string;
  } | undefined;
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message ?? payload?.message;
    throw new Error(message || `ClikDeploy model request failed (HTTP ${response.status})`);
  }
  if (!payload || !('data' in payload)) throw new Error('ClikDeploy returned an invalid model response.');
  return payload.data as T;
}

/** List popular models or search ClikDeploy's Hugging Face catalog. */
export async function searchDeployableModels(query = ''): Promise<DeployableModel[]> {
  const params = new URLSearchParams({ q: query, source: 'huggingface' });
  return request<DeployableModel[]>(`/api/models/search?${params}`);
}

/** Ask ClikDeploy's planner for a compatible runtime, GPU, and hourly price. */
export async function quotePrivateModel(modelId: string): Promise<PrivateModelQuote> {
  const params = new URLSearchParams({ source: 'huggingface', modelId });
  return request<PrivateModelQuote>(`/api/models/resolve?${params}`);
}

/** Create through the shared planner. Omitting gpuType lets ClikDeploy select compute. */
export async function deployPrivateModel(model: DeployableModel, quote: PrivateModelQuote): Promise<{ id: string; modelId: string; status: string; gatewayModelId: string }> {
  const deployment = await request<{ id: string; modelId: string; status: string }>('/api/models/deployments', {
    method: 'POST',
    body: {
      sourceId: model.sourceId,
      modelId: model.modelId,
      ...(quote.quant?.label ? { quantLabel: quote.quant.label } : {}),
    },
  });
  if (typeof deployment?.id !== 'string' || !deployment.id.trim()) {
    throw new Error('ClikDeploy returned a deployment without an ID.');
  }
  return { ...deployment, gatewayModelId: `private-deployment:${deployment.id}` };
}
