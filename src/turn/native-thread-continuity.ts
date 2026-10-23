/** Check a resumable vendor thread at the point where ClikCode chooses it.
 * Claude and Qwen use parentUuid JSONL. Other stores have different formats
 * and must be left to their own resume/error handling. */
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { locateNativeSessionFile } from '../session/discovery/registry.js';
import { nativeProfileEnvironment } from '../harness/transport/profile-environment.js';
import { ParentChainIndex } from './parent-chain.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';

interface CheckedChain {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  anchor: Buffer;
  index: ParentChainIndex;
  holds: boolean;
}

const checked = new Map<string, CheckedChain>();
const ANCHOR_BYTES = 64;
const MAX_CACHED_CHAINS = 4;

async function tail(path: string, size: number): Promise<Buffer> {
  const length = Math.min(size, ANCHOR_BYTES);
  const bytes = Buffer.alloc(length);
  const handle = await open(path, 'r');
  try {
    let read = 0;
    while (read < length) {
      const result = await handle.read(bytes, read, length - read, size - length + read);
      if (!result.bytesRead) throw new Error('native thread changed while checking its tail');
      read += result.bytesRead;
    }
  }
  finally { await handle.close(); }
  return bytes;
}

async function checkFile(path: string): Promise<boolean> {
  const before = await stat(path);
  const previous = checked.get(path);
  if (previous && previous.dev === before.dev && previous.ino === before.ino
    && previous.size === before.size && previous.mtimeMs === before.mtimeMs) return previous.holds;
  // A larger file is usually append-only. Confirm the old end is untouched
  // before using its parent map; a replacement or rewrite starts from zero.
  const appended = previous && previous.dev === before.dev && previous.ino === before.ino
    && before.size > previous.size && (await tail(path, previous.size)).equals(previous.anchor);
  const index = appended ? previous.index : new ParentChainIndex();
  const start = appended ? previous.size : 0;
  if (before.size > start) {
    const stream = createReadStream(path, { start, end: before.size - 1, encoding: 'utf8' });
    for await (const chunk of stream) index.append(chunk);
  }
  // A partial final line may be a vendor write in progress. Check it for this
  // call, but do not cache the index: the rest may arrive on the next read.
  const partial = index.hasPending;
  if (partial) index.finish();
  const holds = index.holds();
  const after = await stat(path);
  if (!partial && after.dev === before.dev && after.ino === before.ino
    && after.size === before.size && after.mtimeMs === before.mtimeMs) {
    checked.delete(path);
    checked.set(path, { dev: before.dev, ino: before.ino, size: before.size,
      mtimeMs: before.mtimeMs, anchor: await tail(path, before.size), index, holds });
    if (checked.size > MAX_CACHED_CHAINS) checked.delete(checked.keys().next().value!);
  } else checked.delete(path);
  return holds;
}

export async function nativeThreadHoldsConversation(
  session: HarnessSession, harness: AiLocalHarnessDefinition, account: AiHarnessAccount,
): Promise<boolean> {
  if (!session.nativeSessionId || session.nativeSessionPreallocated) return true;
  if (harness.command !== 'claude' && harness.command !== 'qwen') return true;
  if (!session.workspace) return false;
  const file = await locateNativeSessionFile(
    harness, session.nativeSessionId, session.workspace, nativeProfileEnvironment(account.nativeProfile),
  ).catch(() => undefined);
  if (!file?.path.endsWith('.jsonl')) return false;
  return await checkFile(file.path).catch(() => {
    checked.delete(file.path);
    return false;
  });
}
