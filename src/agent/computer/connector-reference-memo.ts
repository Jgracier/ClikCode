/** Which vendors the browser reference search (connector-reference-live.ts) found nothing for, lately. A parked vendor comes round again
 * every time ClikDeploy hands it out, and the search takes a browser and up to two minutes each time; a site with no description file
 * yesterday has none today. A miss is remembered for a week, for the homepage it was searched on: a new homepage is searched again. */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { objectOrEmpty, updateJsonFile } from '../../session/store/json-file.js';

export const REFERENCE_MISS_TTL_MS = 7 * 86_400_000;
export interface ReferenceMiss { at: string; homepage: string; docsUrls: string[] }

const memoPath = (stateDir: string): string => join(stateDir, 'computer', 'reference-search.json');
const asMiss = (value: unknown): ReferenceMiss | undefined => {
  const v = value as Partial<ReferenceMiss> | undefined;
  return v && typeof v.at === 'string' && typeof v.homepage === 'string' && Array.isArray(v.docsUrls) ? { at: v.at, homepage: v.homepage, docsUrls: v.docsUrls.filter((u): u is string => typeof u === 'string') } : undefined;
};

/** The search that found nothing for `id` on this homepage within the week, if there was one. */
export async function recentMiss(stateDir: string, id: string, homepage: string, now = Date.now()): Promise<ReferenceMiss | undefined> {
  let all: Record<string, unknown>;
  try { all = objectOrEmpty(await readFile(memoPath(stateDir), 'utf8')); } catch { return undefined; }
  const miss = asMiss(all[id]);
  return miss && miss.homepage === homepage && now - Date.parse(miss.at) < REFERENCE_MISS_TTL_MS ? miss : undefined;
}

/** Writes down how a search went: a miss is kept, a reference found clears the vendor, and entries past their week are dropped. */
export async function rememberSearch(stateDir: string, id: string, homepage: string, found: { applied: boolean; docsUrls: string[] }, now = Date.now()): Promise<void> {
  await updateJsonFile(memoPath(stateDir), objectOrEmpty, current => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) { const miss = asMiss(value); if (miss && now - Date.parse(miss.at) < REFERENCE_MISS_TTL_MS) next[key] = miss; }
    if (found.applied) delete next[id];
    else next[id] = { at: new Date(now).toISOString(), homepage, docsUrls: found.docsUrls.slice(0, 6) } satisfies ReferenceMiss;
    return next;
  });
}
