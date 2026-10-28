/** `clikcode gateway finetune`: teach a model from the user's own data on ClikDeploy, on a GPU (billed), or on a CPU: their own
 * connected machine first (no charge), else a rented one (billed). The weights are stored with ClikDeploy and are the user's.
 *
 * It uploads the dataset, asks ClikDeploy for a quote, and only with --yes starts the job at that price and follows it to its end:
 * the one quote is the most it can cost, and the job carries it as its spend ceiling. */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type Conf from 'conf';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { emitResult } from '../../cli/structured-output.js';
import { harnessCommand } from '../../session/state/paths.js';
import { quiet } from '../../runtime/lifecycle-log.js';
import { CLIKCODE_USER_AGENT } from '../../version.js';

export interface FineTuneOptions {
  /** The base model: a Hugging Face repo id, e.g. Qwen/Qwen2.5-0.5B-Instruct. */
  base?: string;
  hardware?: string;
  epochs?: string;
  name?: string;
  /** Start the job at the quoted price; without it the quote is shown and nothing is started. */
  yes?: boolean;
  /** Do not wait for the job to finish. */
  wait?: boolean;
}

export interface FineTuneDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Where progress lines go while the job runs (stderr: stdout is the result). */
  progress?: (line: string) => void;
}

/** Largest dataset the upload takes (ClikDeploy's own limit is 50 MB). */
const MAX_DATASET_BYTES = 50 * 1024 * 1024;
const POLL_MS = 15_000;
const FINISHED = new Set(['COMPLETE', 'ERROR', 'CANCELLED']);

interface Envelope<T> { success?: boolean; data?: T; error?: unknown }

function reasonOf(body: Envelope<unknown> | undefined, status: number): string {
  const error = body?.error;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  return `HTTP ${status}`;
}

export async function aiGatewayFineTune(config: Conf, datasetPath: string, options: FineTuneOptions = {}, deps: FineTuneDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const progress = deps.progress ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const apiUrl = getApiUrl(config);
  const apiKey = getApiKeyForUrl(config, apiUrl);
  if (!apiKey) throw new Error(`Not signed in to ClikDeploy Gateway. Run \`${harnessCommand()} gateway login\`.`);
  if (!options.base) throw new Error('Name the base model with --base, e.g. --base Qwen/Qwen2.5-0.5B-Instruct.');
  const hardware = options.hardware ?? 'gpu';
  if (hardware !== 'gpu' && hardware !== 'cpu') throw new Error('--hardware must be gpu or cpu');
  const epochs = options.epochs === undefined ? undefined : Number(options.epochs);
  if (epochs !== undefined && (!Number.isInteger(epochs) || epochs < 1 || epochs > 10)) throw new Error('--epochs must be a whole number from 1 to 10');

  const info = await stat(datasetPath).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`No dataset file at ${datasetPath}.`);
  if (info.size > MAX_DATASET_BYTES) throw new Error('The dataset is over 50 MB: upload it to your ClikDeploy data pool and name it there.');

  const auth = { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': CLIKCODE_USER_AGENT };
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetchImpl(new URL(path, apiUrl), { ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });
    const body = await response.json().catch(quiet('commands/ai/finetune')) as Envelope<T> | undefined;
    if (!response.ok || body?.success === false || body?.data === undefined) throw new Error(`ClikDeploy fine-tune: ${reasonOf(body, response.status)}`);
    return body.data;
  };
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const form = new FormData();
  form.set('file', new Blob([await readFile(datasetPath)]), basename(datasetPath));
  form.set('name', options.name ? `${options.name} (data)` : basename(datasetPath));
  const dataset = await call<{ id: string; rowCount?: number; tokenCount?: number; format?: string }>('/api/datasets', { method: 'POST', body: form });

  const hyperparams = epochs === undefined ? undefined : { epochs };
  const request = { baseModelId: options.base, datasetId: dataset.id, hardware, ...(hyperparams ? { hyperparams } : {}) };
  const quote = await call<{ summary: string; hardware: string; costHigh: number; hoursLow: number; hoursHigh: number; warnings?: string[]; costHighMicroUsd: string; suggestedCeilingMicroUsd: string; sku?: { displayName?: string } }>('/api/training/quote', json(request));
  const shown = {
    dataset: { id: dataset.id, rows: dataset.rowCount, tokens: dataset.tokenCount, format: dataset.format },
    quote: { hardware: quote.hardware, machine: quote.sku?.displayName, summary: quote.summary, mostItCanCostUsd: quote.costHigh, warnings: quote.warnings ?? [] },
  };
  if (!options.yes) {
    emitResult({ ...shown, started: false, next: `Run it again with --yes to start at this price (the job stops at ${quote.costHigh > 0 ? `about $${(Number(quote.suggestedCeilingMicroUsd) / 1e6).toFixed(2)}` : 'its ceiling'}).` });
    return;
  }

  const job = await call<{ id: string; status: string }>('/api/training/jobs', json({
    ...request, name: options.name, placement: 'capacity',
    acceptedQuoteMicroUsd: quote.costHighMicroUsd, spendCeilingMicroUsd: quote.suggestedCeilingMicroUsd,
  }));
  progress(`fine-tune ${job.id} started (${quote.summary})`);
  if (options.wait === false) {
    emitResult({ ...shown, started: true, job: { id: job.id, status: job.status } });
    return;
  }
  let last = '';
  for (;;) {
    const now = await call<{ id: string; status: string; statusDetail?: string; progressPct?: number; spendMicroUsd?: string | number; outputPath?: string; loss?: number }>(`/api/training/jobs/${encodeURIComponent(job.id)}`);
    const line = `${now.status}${now.statusDetail ? ` · ${now.statusDetail}` : ''}`;
    if (line !== last) { progress(line); last = line; }
    if (FINISHED.has(now.status)) {
      emitResult({ ...shown, started: true, job: { id: now.id, status: now.status, detail: now.statusDetail, loss: now.loss, spentUsd: Number(now.spendMicroUsd ?? 0) / 1e6, weights: now.status === 'COMPLETE' ? 'stored with ClikDeploy; they are yours to keep (storage is billed hourly)' : undefined } });
      if (now.status !== 'COMPLETE') process.exitCode = 1;
      return;
    }
    await sleep(POLL_MS);
  }
}
