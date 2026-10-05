/** The first user message of threads kept as rows in a vendor's SQLite
 * database, read-only (NativeSessionStore.openings). */

import { stat } from 'node:fs/promises';

type Db = { prepare(sql: string): { get(...values: unknown[]): unknown }; close(): void };

/** Runs `query` (one `?`: the thread id; one column, `text`) for each id
 * against the database at `file`. A missing or unreadable database, or a
 * query this build of the vendor cannot answer, yields nothing. `text` turns
 * the column into the message. */
export async function sqliteOpenings(
  file: string, nativeIds: readonly string[], query: string, text: (value: string) => string | undefined,
): Promise<Map<string, string>> {
  const openings = new Map<string, string>();
  if (!nativeIds.length || !await stat(file).then(() => true, () => false)) return openings;
  let db: Db | undefined;
  try {
    const sqlite = await import('node:sqlite') as unknown as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Db };
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const statement = db.prepare(query);
    for (const id of nativeIds) {
      const row = statement.get(id) as { text?: unknown } | undefined;
      const opening = typeof row?.text === 'string' ? text(row.text) : undefined;
      if (opening) openings.set(id, opening);
    }
  } catch {
    // fail-open-ok: telling ClikCode's own threads apart is a filter on a
    // list; a vendor database it cannot read leaves the list as it was.
  } finally {
    db?.close();
  }
  return openings;
}

/** The text of a JSON message part: `{"type":"text","text":...}`, or a list
 * of them (the first text part). */
export function jsonPartText(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    const parts = Array.isArray(parsed) ? parsed : [parsed];
    const part = parts.find((item) => (item as { type?: unknown })?.type === 'text' && typeof (item as { text?: unknown }).text === 'string');
    return (part as { text: string } | undefined)?.text;
  } catch {
    return undefined;
  }
}
