/** The merged Hosted AI list: every target's rows in one list, best first, searchable by name and by where it runs. */
import { discoveryRefresh } from '../local-models/discover.js';
import { clikdeploy } from './clikdeploy.js';
import { thisComputer } from './this-computer.js';
import { quiet } from '../runtime/lifecycle-log.js';
import type { HostedAdapter, HostedList, HostedPlan, HostedRow, HostedTarget } from './types.js';

export * from './types.js';

export const HOSTED_ADAPTERS: readonly HostedAdapter[] = [thisComputer, clikdeploy];

/** Words in a search that choose where a model runs instead of naming one. */
const TARGET_WORDS: Readonly<Record<string, HostedTarget>> = {
  local: 'this-computer', offline: 'this-computer', computer: 'this-computer', here: 'this-computer',
  cloud: 'clikdeploy', gpu: 'clikdeploy', clikdeploy: 'clikdeploy', hosted: 'clikdeploy',
};

/** A search split into where to look and what to look for: `local qwen` is qwen, on this computer. */
export function parseHostedQuery(query: string): { targets: ReadonlySet<HostedTarget>; text: string } {
  const targets = new Set<HostedTarget>();
  const rest: string[] = [];
  for (const word of query.trim().split(/\s+/).filter(Boolean)) {
    const target = TARGET_WORDS[word.toLowerCase()];
    if (target) targets.add(target); else rest.push(word);
  }
  return { targets, text: rest.join(' ') };
}

/** Rows the user can run on this computer first (recommended before the rest), then every other target's, each as it ranked. */
function ordered(rows: HostedRow[]): HostedRow[] {
  const rank = (row: HostedRow): number => (row.target === 'this-computer' ? (row.recommended ? 0 : 1) : 2);
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map((item) => item.row);
}

/** What every wanted target can run for `query`. A target that cannot answer (offline, signed out, not reachable)
 * does not hide the others: it is named in `unavailable`. */
export async function hostedList(query: string, adapters: readonly HostedAdapter[] = HOSTED_ADAPTERS, signal?: AbortSignal): Promise<HostedList> {
  const { targets, text } = parseHostedQuery(query);
  const wanted = adapters.filter((adapter) => !targets.size || targets.has(adapter.target));
  const answers = await Promise.allSettled(wanted.map((adapter) => adapter.list(text, signal)));
  const rows: HostedRow[] = [];
  const unavailable: HostedList['unavailable'] = [];
  answers.forEach((answer, index) => {
    if (answer.status === 'fulfilled') rows.push(...answer.value);
    else unavailable.push({ target: wanted[index]!.target, message: answer.reason instanceof Error ? answer.reason.message : String(answer.reason) });
  });
  // A model that fits this computer is priced for ClikDeploy from the repo it comes from (hostedPlan), so the same repo listed again by
  // ClikDeploy's search is the one model twice: it stays where it fits this computer.
  const local = new Set(rows.flatMap((row) => (row.target === 'this-computer' && row.repo ? [row.repo] : [])));
  const merged = rows.filter((row) => !(row.target === 'clikdeploy' && local.has(row.id)));
  return { rows: ordered(merged), unavailable, ...(discoveryRefresh() ? { refreshing: true as const } : {}) };
}

/** How long to wait for ClikDeploy's price for a model that already fits this computer. A model that does not fit is waited for: its price
 * is the whole answer. */
const ALTERNATIVE_MS = 6_000;

/** What choosing `row` takes, said before anything is spent or downloaded.
 *
 * A model that fits this computer comes with the same model on ClikDeploy (`alternative`) when its planner can price it -- it takes the
 * repo the local weights come from -- so the choice is "here, or there, at this price". Signed out, offline, gated or slow, there is no
 * alternative and the model is simply run here, as before. A model that does not fit this computer has only its ClikDeploy estimate. */
export async function hostedPlan(row: HostedRow, adapters: readonly HostedAdapter[] = HOSTED_ADAPTERS): Promise<HostedPlan> {
  const plan = await hostedAdapter(row.target, adapters).plan(row);
  const cloud = adapters.find((adapter) => adapter.target === 'clikdeploy');
  if (row.target !== 'this-computer' || !row.repo || !cloud) return plan;
  const cloudRow: HostedRow = { target: 'clikdeploy', id: row.repo, label: row.label, detail: '' };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ALTERNATIVE_MS);
  try {
    return { ...plan, alternative: { row: cloudRow, plan: await cloud.plan(cloudRow, deadline.signal) } };
  } catch (error) {
    quiet('hosted-models')(error);
    return plan;
  } finally { clearTimeout(timer); }
}

export function hostedAdapter(target: HostedTarget, adapters: readonly HostedAdapter[] = HOSTED_ADAPTERS): HostedAdapter {
  const adapter = adapters.find((item) => item.target === target);
  if (!adapter) throw new Error(`unknown hosted target "${target}"`);
  return adapter;
}
