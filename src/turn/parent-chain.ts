/** Whether a vendor transcript's live parentUuid chain is structurally sound.
 *
 * Claude Code (and the same line format) resumes by walking parentUuid from
 * the last real message back to a root. A compaction boundary is a valid
 * root: its summary replaces earlier turns. Other branches may also remain
 * in the file. A missing parent, cycle or unreadable chain makes it invalid. */

interface ChainRecord {
  uuid?: unknown;
  parentUuid?: unknown;
  type?: unknown;
  isSidechain?: unknown;
}

/** Keeps only parent links, so an appended tail can be checked without parsing
 * the whole transcript again. A worker owns one conversation; the cache stays
 * in that worker and never substitutes for the file after a rewrite. */
export class ParentChainIndex {
  private readonly parents = new Map<string, unknown>();
  private pending = '';
  private chained = false;
  private lastMessage: string | undefined;

  get hasPending(): boolean { return this.pending.length > 0; }

  append(chunk: string): void {
    const lines = (this.pending + chunk).split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.add(line);
  }

  /** JSONL may omit the final newline. The last complete record still counts. */
  finish(): void {
    if (this.pending) this.add(this.pending);
    this.pending = '';
  }

  private add(line: string): void {
    if (!line.includes('"uuid"')) return;
    let entry: ChainRecord;
    try { entry = JSON.parse(line) as ChainRecord; } catch { return; }
    if (typeof entry.uuid !== 'string') return;
    if ('parentUuid' in entry) this.chained = true;
    this.parents.set(entry.uuid, entry.parentUuid);
    if (entry.isSidechain !== true && (entry.type === 'user' || entry.type === 'assistant')) this.lastMessage = entry.uuid;
  }

  holds(): boolean {
    if (!this.chained || !this.lastMessage) return false;
  const seen = new Set<string>();
    let current = this.lastMessage;
    while (current) {
      if (seen.has(current)) return false;
      seen.add(current);
      if (!this.parents.has(current)) return false;
      const parent = this.parents.get(current);
      if (parent === null) return true;
      if (typeof parent !== 'string') return false;
      current = parent;
  }
  return false;
  }
}

export function parentChainHolds(jsonl: string): boolean {
  const index = new ParentChainIndex();
  index.append(jsonl);
  index.finish();
  return index.holds();
}
