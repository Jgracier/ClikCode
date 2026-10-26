/** The merged Hosted AI list: every target's rows in one list, best first, searchable by name and by where it runs. */
import { clikdeploy } from './clikdeploy.js';
import { thisComputer } from './this-computer.js';
import type { HostedAdapter, HostedList, HostedRow, HostedTarget } from './types.js';

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
  return { rows: ordered(rows), unavailable };
}

export function hostedAdapter(target: HostedTarget, adapters: readonly HostedAdapter[] = HOSTED_ADAPTERS): HostedAdapter {
  const adapter = adapters.find((item) => item.target === target);
  if (!adapter) throw new Error(`unknown hosted target "${target}"`);
  return adapter;
}
