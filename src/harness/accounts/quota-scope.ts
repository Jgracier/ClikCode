/** A model's independently metered family, the `scope` usage-reading.ts's
 * quota rules take. Node only: it reads the catalog. */
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import type { AiHarnessAccount } from '../definition.js';
import { vendorWindows } from './usage-reading.js';

/** The independently metered model family a model belongs to, as the
 * catalog's `quotaScopes` names them (Antigravity's pools). */
export function quotaScopeForModel(account: AiHarnessAccount, model: string | undefined): string | undefined {
  if (!model) return undefined;
  let scopes: Readonly<Record<string, readonly string[]>> | undefined;
  try { scopes = localHarnessForProvider(account.provider)?.quotaScopes; } catch { scopes = undefined; } // fail-open-ok: no catalog, no scopes: the refusal holds the whole account
  if (!scopes) return undefined;
  const id = model.toLowerCase();
  const family = Object.entries(scopes).find(([, words]) => words.some((word) => id.includes(word)))?.[0];
  if (!family) return undefined;
  // Some Antigravity models share one vendor pool and reset instant. Its
  // usage response names every family in that pool (for example Claude and
  // GPT-OSS); preserve that grouping when recording a model refusal.
  const pool = vendorWindows(account).find((window) => window.name.toLowerCase()
    .split(/[\/,+\s]+/).includes(family));
  if (pool) return pool.name.toLowerCase().split(/[\/,+\s]+/).filter(Boolean).sort().join('+');
  return family;
}

