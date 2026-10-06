/** OpenRouter's published model scores, cached for a day. The host reads
 * them off the swarm tool and picks a model. Swarm does not fetch them
 * again on every call. */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../session/store/files.js';
import { stateDirectory } from '../session/store/paths.js';

export interface ModelScore {
  intelligence?: number;
  coding?: number;
  agentic?: number;
  /** USD per million input tokens. Absent when OpenRouter did not publish one. */
  promptPerM?: number;
  /** USD per million output tokens. */
  completionPerM?: number;
}

export interface ScoreCache {
  fetchedAt: number;
  /** Bumped when the cached shape changes, so an older table is refreshed. */
  version?: number;
  byKey: Record<string, ModelScore>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 2;

function cachePath(): string {
  return join(stateDirectory(), 'swarm', 'openrouter-scores.json');
}

/** Digits and letters only, so `claude-sonnet-4.5` and `anthropic/claude-sonnet-4-5` meet. */
export function scoreKey(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** OpenRouter names the indexes `intelligence_index`. A short name is accepted too. */
function keep(raw: unknown): ModelScore | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const next: ModelScore = {};
  const intelligence = finite(row.intelligence_index ?? row.intelligence);
  const coding = finite(row.coding_index ?? row.coding);
  const agentic = finite(row.agentic_index ?? row.agentic);
  if (intelligence !== undefined) next.intelligence = intelligence;
  if (coding !== undefined) next.coding = coding;
  if (agentic !== undefined) next.agentic = agentic;
  return next.intelligence === undefined && next.coding === undefined && next.agentic === undefined ? undefined : next;
}

function publishedCost(score: ModelScore): number {
  if (score.promptPerM === undefined && score.completionPerM === undefined) return -1;
  return (score.promptPerM ?? 0) + (score.completionPerM ?? 0);
}

/** The first spelling wins, unless a later row publishes a higher price.
 * A `:batch` twin is cheaper and must not hide what the harness charges. */
function remember(into: Record<string, ModelScore>, id: string, score: ModelScore): void {
  const key = scoreKey(id);
  if (key.length < 4) return;
  const prior = into[key];
  if (!prior || publishedCost(score) > publishedCost(prior)) into[key] = score;
}

/** OpenRouter prices are USD per token, as strings. `-1` means the price is not fixed. */
function perMillion(value: unknown): number | undefined {
  const amount = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  return Math.round(amount * 1_000_000 * 100) / 100;
}

function priceOf(raw: unknown): Pick<ModelScore, 'promptPerM' | 'completionPerM'> {
  if (!raw || typeof raw !== 'object') return {};
  const row = raw as Record<string, unknown>;
  const promptPerM = perMillion(row.prompt);
  const completionPerM = perMillion(row.completion);
  return {
    ...(promptPerM !== undefined ? { promptPerM } : {}),
    ...(completionPerM !== undefined ? { completionPerM } : {}),
  };
}

/** Indexes every model that has at least one Artificial Analysis number. */
export function scoresFromOpenRouter(body: string): Record<string, ModelScore> {
  const into: Record<string, ModelScore> = {};
  let rows: unknown;
  try {
    rows = (JSON.parse(body) as { data?: unknown }).data;
  } catch {
    return into;
  }
  if (!Array.isArray(rows)) return into;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as { id?: unknown; canonical_slug?: unknown; pricing?: unknown; benchmarks?: { artificial_analysis?: unknown } };
    const indexes = keep(record.benchmarks?.artificial_analysis);
    if (!indexes) continue;
    const score = { ...indexes, ...priceOf(record.pricing) };
    if (typeof record.id === 'string') {
      remember(into, record.id, score);
      const slash = record.id.lastIndexOf('/');
      if (slash >= 0) remember(into, record.id.slice(slash + 1), score);
    }
    if (typeof record.canonical_slug === 'string') {
      const stripped = record.canonical_slug.replace(/-\d{8}$/, '');
      remember(into, stripped, score);
      const slugSlash = stripped.lastIndexOf('/');
      if (slugSlash >= 0) remember(into, stripped.slice(slugSlash + 1), score);
    }
  }
  return into;
}

export function lookupScore(cache: ScoreCache | undefined, modelId: string | undefined): ModelScore | undefined {
  if (!cache || !modelId) return undefined;
  return cache.byKey[scoreKey(modelId)];
}

async function readCache(): Promise<ScoreCache | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), 'utf8')) as ScoreCache;
    if (!parsed || typeof parsed.fetchedAt !== 'number' || !parsed.byKey) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** The cached table. A table older than a day is refreshed. A failed refresh
 * keeps the previous table, or an empty one when there has never been one. */
export async function loadScoreCache(now = Date.now(), fetchBody?: () => Promise<string>): Promise<ScoreCache> {
  const cached = await readCache();
  if (cached?.version === CACHE_VERSION && now - cached.fetchedAt < DAY_MS) return cached;
  try {
    const body = fetchBody
      ? await fetchBody()
      : await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8_000) }).then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      });
    const next: ScoreCache = { version: CACHE_VERSION, fetchedAt: now, byKey: scoresFromOpenRouter(body) };
    await atomicWriteFile(cachePath(), JSON.stringify(next));
    return next;
  } catch {
    return cached ?? { fetchedAt: 0, byKey: {} };
  }
}
