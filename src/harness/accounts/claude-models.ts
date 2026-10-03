/** Claude Code's own model table, read from the installed binary.
 *
 * ClikCode used to carry this as a constant -- `opus: 'Opus 5'` -- and so the
 * picker went on saying Opus 5 after Claude Code shipped Opus 5.5. No TTL
 * could have fixed that: it was never a cache, it was a guess compiled in.
 *
 * Claude Code has no scriptable `models` command (`claude models` is a
 * prompt), but its bundle carries the table it resolves aliases with:
 *
 *     latest_per_family:{fable:"claude-fable-5-1",opus:"claude-opus-5-5",…}
 *     {id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5",…}
 *
 * That is the vendor's own answer to "what does `opus` mean in this build",
 * so it is read rather than reconstructed. And it is a fact about a FILE: the
 * same binary always carries the same table, so it is remembered against the
 * binary's path, mtime and size -- indefinitely while those hold, and not for
 * one moment after an update changes them. The same rule version-memo.ts
 * follows, for the same reason: a TTL here would be wrong both ways.
 */
import { open } from 'node:fs/promises';
import { jsonMemo } from '../../session/store/json-memo.js';
import { binaryFingerprint, sameFingerprint, type BinaryFingerprint } from '../transport/native/version-memo.js';
import { resolveBinaryPath } from '../transport/native/binary.js';

export interface ClaudeModelTable {
  /** Alias -> the model id it resolves to in this build. */
  aliases: Record<string, string>;
  /** Model id -> the name Claude Code itself shows for it. */
  displayNames: Record<string, string>;
}

const LATEST = /latest_per_family:\{([^}]*)\}/;
const ALIAS_ENTRY = /([a-z]+):"(claude-[a-z0-9-]+)"/g;
const MODEL_ENTRY = /\{id:"(claude-[a-z0-9-]+)",family:"[a-z]+",display_name:"([^"]{1,40})"/g;

/** The table, from a slice of the bundle's text. Pure, so it is tested on the
 * shapes seen in real builds rather than on a 230 MB file. */
export function parseClaudeModelTable(text: string, into: ClaudeModelTable = { aliases: {}, displayNames: {} }): ClaudeModelTable {
  const latest = LATEST.exec(text);
  if (latest) for (const [, alias, id] of latest[1]!.matchAll(ALIAS_ENTRY)) into.aliases[alias!] = id!;
  for (const [, id, name] of text.matchAll(MODEL_ENTRY)) into.displayNames[id!] ??= name!;
  return into;
}

/** Scanned in chunks: the bundle is hundreds of megabytes, and holding it as
 * one string is a memory spike for a table that is a few hundred bytes. The
 * overlap is far longer than any entry, so nothing straddles a boundary
 * unseen. Paid once per Claude Code release, then remembered. */
async function scanBinary(path: string): Promise<ClaudeModelTable | undefined> {
  const CHUNK = 8 * 1024 * 1024;
  const OVERLAP = 64 * 1024;
  const table: ClaudeModelTable = { aliases: {}, displayNames: {} };
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK + OVERLAP);
    let carried = 0;
    for (let position = 0; ; ) {
      const { bytesRead } = await handle.read(buffer, carried, CHUNK, position);
      if (!bytesRead) break;
      const length = carried + bytesRead;
      parseClaudeModelTable(buffer.toString('latin1', 0, length), table);
      position += bytesRead;
      carried = Math.min(OVERLAP, length);
      buffer.copy(buffer, 0, length - carried, length);
    }
  } finally {
    await handle.close();
  }
  return Object.keys(table.aliases).length ? table : undefined;
}

interface MemoFile { v: 1; fingerprint: BinaryFingerprint; table: ClaudeModelTable }

/** One entry: the table of the last binary scanned. Read straight from disk
 * whenever the binary in hand is not the one already held, so a scan another
 * process just did is picked up rather than repeated. */
const memo = jsonMemo<MemoFile | undefined>('cache/claude-models.json', () => undefined, (parsed) => {
  const file = parsed as MemoFile;
  return file.v === 1 ? file : undefined;
});

let current: { fingerprint: BinaryFingerprint; table: ClaudeModelTable } | undefined;
let pending: Promise<ClaudeModelTable | undefined> | undefined;

/** The table for the Claude Code that is installed right now, or undefined
 * when it cannot be read -- in which case the caller shows bare aliases,
 * which are always correct, rather than labels that may not be. */
export async function claudeModelTable(binary = 'claude'): Promise<ClaudeModelTable | undefined> {
  const fingerprint = await binaryFingerprint(await resolveBinaryPath(binary));
  if (!fingerprint) return undefined;
  if (current && sameFingerprint(current.fingerprint, fingerprint)) return current.table;
  const remembered = await memo.read();
  if (remembered && sameFingerprint(remembered.fingerprint, fingerprint)) {
    current = { fingerprint, table: remembered.table };
    return remembered.table;
  }
  // One scan per build however many pickers ask at once.
  pending ??= scanBinary(fingerprint.path).then(async (table) => {
    if (table) {
      current = { fingerprint, table };
      await memo.write({ v: 1, fingerprint, table });
    }
    return table;
  }).catch(() => undefined).finally(() => { pending = undefined; });
  return pending;
}

/** What this build calls a model, from whatever has been read so far.
 * Synchronous on purpose: renderers label a model on every frame and must not
 * wait on a file. Before the first read it answers undefined, and the caller
 * shows the model as it is named -- never a remembered label that may belong
 * to a build that is no longer installed. */
export function claudeModelLabel(model: string): string | undefined {
  const table = current?.table;
  if (!table) return undefined;
  const id = table.aliases[model] ?? model;
  return table.displayNames[id];
}

/** The aliases this build resolves, in the order Claude Code lists them. */
export function claudeModelAliases(table: ClaudeModelTable | undefined): string[] {
  return table ? Object.keys(table.aliases) : [];
}
