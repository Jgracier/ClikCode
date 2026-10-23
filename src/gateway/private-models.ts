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
