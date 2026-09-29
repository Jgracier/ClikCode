/** The agent's system prompt and tool list, read once per machine instead of
 * once per server start.
 *
 * Every ClikCode Local session opens with the same few thousand tokens --
 * system prompt plus tool schemas -- and a server starts cold whenever
 * ClikCode does (it stops with the last lease). Reading them costs 50 s on a
 * 4B model and minutes on a 27B one before the first word. llama-server can
 * write a slot's state to disk and read it back in milliseconds, so the
 * state after exactly that prefix is saved once and restored into a fresh
 * server, and the first request reads only the user's message.
 *
 * The saved state must end exactly where the first user message begins:
 * hybrid (recurrent) models cannot rewind, so a state holding anything past
 * the shared prefix is useless to a different conversation. Measured on this
 * engine's catalog (b11194, CPU): Qwen3.5 4B 54.7 s -> 5.4 s to the first
 * answer, 187 MB file, 37 ms restore.
 *
 * Not for sliding-window models (gpt-oss, Gemma): llama-server discards a
 * restored sliding-window state and reads everything again. --swa-full makes
 * it work but halved gpt-oss's generation speed at 15K tokens, which costs
 * more over a conversation than the start saves. llama.cpp PR #26004 may
 * lift this.
 * In a b11194 CPU check, a restored 2,390-token hybrid-model state already
 * reused all 2,390 tokens when the next prompt merely extended it. PR #26004
 * helped a different case: when the next prompt branched before the saved
 * end, b11194 reread 1,117 tokens while the patched server reused 990. The
 * fork is not required for this shared prefix, which ends before the user's
 * message and is extended by ordinary turns.
 *
 * Every failure here only costs the time it would have cost anyway: the
 * request that follows reads whatever the server does not already hold. */

import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { httpJson } from './launch.js';

/** Shorter prefixes are read faster than a restore is worth managing. */
const MIN_PREFIX_TOKENS = 1024;
/** Tokens given back from the shared prefix so the last one cannot be a
 * piece that merges differently with the text of a real message. */
const BOUNDARY_SLACK = 4;
/** Saved prefixes kept per server configuration, newest used first; one
 * is a few hundred MB. */
const KEEP_FILES = 4;
/** Beside each saved state: its tokens, for finding what a new prefix shares. */
const TOKENS_SUFFIX = '.tokens.json';
/** Reading a long prefix on a slow CPU takes minutes. */
const PREFILL_TIMEOUT_MS = 30 * 60_000;

export interface PrefixRequest {
  messages: readonly { role: string; content: unknown }[];
  tools?: readonly unknown[];
}

interface SlotInfo { id: number; is_processing?: boolean; id_task?: number }

const caches = new Map<string, PrefixCache>();

/** The one PrefixCache for a server: a turn builds a new model client, and
 * what the last turn made sure of must not be read again. */
export function prefixCacheFor(port: number, dir: string): PrefixCache {
  const key = `${port}:${dir}`;
  let cache = caches.get(key);
  if (!cache) caches.set(key, cache = new PrefixCache(port, dir));
  return cache;
}

/** One per server a process talks to: the prefixes it already made sure of,
 * and whether the server can do this at all. */
export class PrefixCache {
  private readonly done = new Set<string>();
  private unsupported = false;
  /** One at a time: parallel sub-agents would otherwise pick the same
   * unused slot. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly port: number, private readonly dir: string) {}

  /** Make sure the server holds this request's system+tools prefix before
   * the request is sent: restored from disk into a fresh server, or read
   * once and saved. */
  prepare(request: PrefixRequest, signal?: AbortSignal): Promise<void> {
    const run = this.queue.then(() => this.prepareNow(request, signal));
    this.queue = run.catch(() => {});
    return run;
  }

  private async prepareNow(request: PrefixRequest, signal?: AbortSignal): Promise<void> {
    if (this.unsupported || request.messages[0]?.role !== 'system') return;
    const prefix = await this.prefixTokens(request);
    if (!prefix) return;
    const key = keyOf(prefix);
    if (this.done.has(key)) return;
    const saved = await this.savedPrefixes();

    // Without an unused slot there is nothing to restore or save into
    // safely: another session's conversation may be in it. The read below
    // is then instant when a slot already holds the prefix.
    const slot = await this.unusedSlot();
    if (slot !== undefined) {
      let held = 0;
      // The longest saved state this prefix extends: itself, or a layer it
      // shares with other folders' prefixes.
      const base = saved.has(key) ? { key, length: prefix.length } : longestBase(prefix, saved);
      if (base && await this.restore(slot, base.key)) {
        if (base.key === key) { this.done.add(key); return; }
        held = base.length;
      }
      // A miss that shares a long run with another saved prefix (the tools
      // and fixed instructions, before a folder's own instructions) saves
      // that run as its own layer, so the next folder reads only its tail.
      const shared = sharedLength(prefix, saved) - BOUNDARY_SLACK;
      if (shared > held && shared >= MIN_PREFIX_TOKENS && shared < prefix.length) {
        const layer = prefix.slice(0, shared);
        if (!await this.read(layer, slot, signal)) return;
        await this.save(slot, keyOf(layer), layer);
      }
    }
    if (!await this.read(prefix, slot, signal)) return;
    this.done.add(key);
    if (slot !== undefined && !saved.has(key)) await this.save(slot, key, prefix);
  }

  private async restore(slot: number, key: string): Promise<boolean> {
    const restored = await httpJson(this.port, 'POST', `/slots/${slot}?action=restore`, { filename: `${key}.bin` }, 60_000);
    if (restored.status !== 200) return false;
    const now = new Date();
    await utimes(join(this.dir, `${key}.bin`), now, now).catch(() => {});
    return true;
  }

  /** Reads tokens into the slot, reusing whatever prefix of them it holds. */
  private async read(tokens: number[], slot: number | undefined, signal?: AbortSignal): Promise<boolean> {
    const read = await abortable(httpJson(this.port, 'POST', '/completion', {
      prompt: tokens, n_predict: 0, cache_prompt: true, ...(slot !== undefined ? { id_slot: slot } : {}),
    }, PREFILL_TIMEOUT_MS), signal);
    return read.status === 200;
  }

  private async save(slot: number, key: string, tokens: number[]): Promise<void> {
    const written = await httpJson(this.port, 'POST', `/slots/${slot}?action=save`, { filename: `${key}.bin` }, 120_000);
    // 501/400: started without --slot-save-path (an older ClikCode's server).
    if (written.status !== 200) { this.unsupported = written.status === 501 || written.status === 400; return; }
    // The tokens beside the state: what a later prefix shares with it.
    await writeFile(join(this.dir, `${key}${TOKENS_SUFFIX}`), JSON.stringify(tokens)).catch(() => {});
    await this.prune();
  }

  /** Saved states by key, with their tokens when recorded (a file from an
   * older ClikCode has none and can only be restored whole). */
  private async savedPrefixes(): Promise<Map<string, number[] | undefined>> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const saved = new Map<string, number[] | undefined>();
    for (const name of names) {
      if (!name.endsWith('.bin')) continue;
      const key = name.slice(0, -'.bin'.length);
      const tokens = await readFile(join(this.dir, `${key}${TOKENS_SUFFIX}`), 'utf8')
        .then((raw) => JSON.parse(raw) as unknown, () => undefined);
      saved.set(key, Array.isArray(tokens) && tokens.every((token) => typeof token === 'number') ? tokens as number[] : undefined);
    }
    return saved;
  }

  /** The longest token prefix two renders of this request share when only
   * the user's message differs, less a little slack; undefined when the
   * server cannot render or tokenize, or the prefix is too short. */
  private async prefixTokens(request: PrefixRequest): Promise<number[] | undefined> {
    const tokens = async (user: string): Promise<number[] | undefined> => {
      const messages = [request.messages[0], { role: 'user', content: user }];
      const rendered = await httpJson(this.port, 'POST', '/apply-template', { messages, ...(request.tools?.length ? { tools: request.tools } : {}) });
      const prompt = (rendered.json as { prompt?: unknown } | undefined)?.prompt;
      if (rendered.status !== 200 || typeof prompt !== 'string') return undefined;
      const tokenized = await httpJson(this.port, 'POST', '/tokenize', { content: prompt, add_special: true, parse_special: true });
      const list = (tokenized.json as { tokens?: unknown } | undefined)?.tokens;
      return Array.isArray(list) && list.every((token) => typeof token === 'number') ? list as number[] : undefined;
    };
    const [first, second] = await Promise.all([tokens('Alpha'), tokens('Zulu')]);
    if (!first || !second) { this.unsupported = true; return undefined; }
    let shared = 0;
    while (shared < first.length && first[shared] === second[shared]) shared++;
    const length = shared - BOUNDARY_SLACK;
    return length >= MIN_PREFIX_TOKENS ? first.slice(0, length) : undefined;
  }

  /** A slot no request has used since the server started: the only kind a
   * restore cannot take from another session. */
  private async unusedSlot(): Promise<number | undefined> {
    const slots = await httpJson(this.port, 'GET', '/slots');
    if (slots.status !== 200 || !Array.isArray(slots.json)) return undefined;
    return (slots.json as SlotInfo[]).find((slot) => !slot.is_processing && slot.id_task === undefined)?.id;
  }

  private async prune(): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const states = names.filter((name) => name.endsWith('.bin'));
    const dated = await Promise.all(states.map(async (name) => ({ name, at: (await stat(join(this.dir, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
    const kept = new Set(dated.sort((left, right) => right.at - left.at).slice(0, KEEP_FILES).map((state) => state.name.slice(0, -'.bin'.length)));
    for (const name of names) {
      const key = name.endsWith('.bin') ? name.slice(0, -'.bin'.length) : name.endsWith(TOKENS_SUFFIX) ? name.slice(0, -TOKENS_SUFFIX.length) : undefined;
      if (key !== undefined && !kept.has(key)) await rm(join(this.dir, name), { force: true });
    }
  }
}

function keyOf(tokens: readonly number[]): string {
  return createHash('sha256').update(JSON.stringify(tokens)).digest('hex').slice(0, 32);
}

function commonLength(left: readonly number[], right: readonly number[]): number {
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return shared;
}

/** The longest saved state that is a prefix of these tokens. */
function longestBase(prefix: readonly number[], saved: ReadonlyMap<string, number[] | undefined>): { key: string; length: number } | undefined {
  let best: { key: string; length: number } | undefined;
  for (const [key, tokens] of saved) {
    if (tokens && tokens.length > (best?.length ?? 0) && commonLength(prefix, tokens) === tokens.length) best = { key, length: tokens.length };
  }
  return best;
}

/** The most tokens this prefix shares with any saved one. */
function sharedLength(prefix: readonly number[], saved: ReadonlyMap<string, number[] | undefined>): number {
  let most = 0;
  for (const tokens of saved.values()) if (tokens) most = Math.max(most, commonLength(prefix, tokens));
  return most;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' }));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' }));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Where a server configuration keeps its saved prefixes. A state depends on
 * the weights and the cache type, so each (model, cache type) gets its own. */
export function prefixCacheDir(modelServerDir: string, cacheType: string): string {
  return join(modelServerDir, 'prefix-cache', cacheType);
}
