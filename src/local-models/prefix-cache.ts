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
 * Conversations are saved the same way. A request's messages, up to the
 * end of its last message, render as a prefix of every later request --
 * except where a template re-renders earlier turns once a new user message
 * follows them (Qwen drops the reasoning of finished turns), so the stable
 * point is found the same way as the shared prefix: the tokens a render of
 * the messages shares with one that adds a user message. Reading up to that
 * point is work the request does anyway; saving it costs a fraction of a
 * second. A fresh server restores the longest saved state a request
 * extends, so reopening a long chat reads only what came after it. Saves
 * are spaced by what this machine reads in CHECKPOINT_SECONDS: a resume
 * never rereads more than that, and a GPU that reads fast rarely saves.
 *
 * Every failure here only costs the time it would have cost anyway: the
 * request that follows reads whatever the server does not already hold. */

import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat, statfs, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { httpJson } from './launch.js';

/** Shorter prefixes are read faster than a restore is worth managing. */
const MIN_PREFIX_TOKENS = 1024;
/** Tokens given back from the shared prefix so the last one cannot be a
 * piece that merges differently with the text of a real message. */
const BOUNDARY_SLACK = 4;
/** Saved system+tools prefixes kept per server configuration, newest used
 * first; one is a few hundred MB. */
const KEEP_FILES = 4;
/** Conversation states are bounded by bytes: one grows with its chat. */
const CONVERSATION_BYTES = 4 * 1024 ** 3;
/** ...and never more than this share of the disk's free space. */
const CONVERSATION_DISK_SHARE = 0.1;
/** The longest reread a resumed chat should pay, in seconds of this
 * machine's measured prompt reading. */
const CHECKPOINT_SECONDS = 15;
/** Used when the machine's prompt speed has not been measured yet. */
const DEFAULT_CHECKPOINT_TOKENS = 2048;
/** Beside each saved state: its tokens, for finding what a new prefix shares. */
const TOKENS_SUFFIX = '.tokens.json';
/** Reading a long prefix on a slow CPU takes minutes. */
const PREFILL_TIMEOUT_MS = 30 * 60_000;

export interface PrefixRequest {
  messages: readonly { role: string; content: unknown }[];
  tools?: readonly unknown[];
}

interface SlotInfo { id: number; is_processing?: boolean; id_task?: number }

/** A saved state: the shared system+tools prefix (or a layer of it), or a
 * point in one conversation. */
type Kind = 'prefix' | 'conversation';
interface Saved { tokens?: number[]; kind: Kind }

export interface PrefixCacheOptions {
  /** This server's measured prompt reading, tokens per second. */
  promptPerSecond?: number;
  /** Overrides the disk budget for conversation states (tests). */
  conversationBytes?: number;
}

const caches = new Map<string, PrefixCache>();

/** The one PrefixCache for a server: a turn builds a new model client, and
 * what the last turn made sure of must not be read again. */
export function prefixCacheFor(port: number, dir: string, options: PrefixCacheOptions = {}): PrefixCache {
  const key = `${port}:${dir}`;
  let cache = caches.get(key);
  if (!cache) caches.set(key, cache = new PrefixCache(port, dir, options));
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

  /** Parsed sidecars by file name; a key's tokens never change. */
  private readonly sidecars = new Map<string, Saved>();
  private readonly checkpointTokens: number;

  constructor(private readonly port: number, private readonly dir: string, private readonly options: PrefixCacheOptions = {}) {
    this.checkpointTokens = options.promptPerSecond && options.promptPerSecond > 0
      ? Math.max(MIN_PREFIX_TOKENS, Math.round(options.promptPerSecond * CHECKPOINT_SECONDS))
      : DEFAULT_CHECKPOINT_TOKENS;
  }

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
    const conversation = await this.stableTokens(request.messages, request.tools);
    const saved = await this.savedStates();

    // Without an unused slot there is nothing to restore into safely:
    // another session's conversation may be in it. The server already holds
    // what it has served, and the reads below reuse it.
    const slot = await this.unusedSlot();
    if (slot !== undefined) {
      // The longest saved state this request extends: this conversation so
      // far, this folder's prefix, or a layer shared with other folders.
      const target = conversation && conversation.length > prefix.length ? conversation : prefix;
      const extended = longestBase(target, saved);
      const base = (!extended || extended.length < prefix.length) && saved.has(key) ? { key, length: prefix.length } : extended;
      const held = base && await this.restore(slot, base.key) ? base.length : 0;
      if (held < prefix.length) {
        // A miss that shares a long run with another saved prefix (the tools
        // and fixed instructions, before a folder's own instructions) saves
        // that run as its own layer, so the next folder reads only its tail.
        const shared = sharedLength(prefix, saved) - BOUNDARY_SLACK;
        if (shared > held && shared >= MIN_PREFIX_TOKENS && shared < prefix.length) {
          const layer = prefix.slice(0, shared);
          if (await this.read(layer, slot, signal) === undefined) return;
          await this.save(slot, layer, 'prefix');
        }
        if (await this.read(prefix, slot, signal) === undefined) return;
        if (!saved.has(key)) await this.save(slot, prefix, 'prefix');
      }
      this.done.add(key);
    } else if (!this.done.has(key)) {
      if (await this.read(prefix, undefined, signal) === undefined) return;
      this.done.add(key);
    }
    if (conversation) await this.checkpoint(conversation, slot, signal);
  }

  /** Save this conversation's stable point once it has grown past the last
   * saved state it extends by more than a resume should reread. */
  private async checkpoint(conversation: number[], slot: number | undefined, signal?: AbortSignal): Promise<void> {
    // Read again: the prefix may have been saved a moment ago.
    const saved = await this.savedStates();
    const covered = longestBase(conversation, saved)?.length ?? 0;
    if (conversation.length - covered < this.checkpointTokens) return;
    // Reads what the request would read, into the slot holding the chat
    // (the server picks it by shared prefix), and says which slot that was.
    const used = await this.read(conversation, slot, signal);
    if (used === undefined || !await this.save(used, conversation, 'conversation')) return;
    // The chat's earlier points are superseded by this one.
    for (const [key, state] of saved) {
      if (state.kind === 'conversation' && state.tokens && commonLength(conversation, state.tokens) === state.tokens.length) await this.remove(key);
    }
  }

  private async restore(slot: number, key: string): Promise<boolean> {
    const restored = await httpJson(this.port, 'POST', `/slots/${slot}?action=restore`, { filename: `${key}.bin` }, 60_000);
    if (restored.status !== 200) return false;
    const now = new Date();
    await utimes(join(this.dir, `${key}.bin`), now, now).catch(() => {});
    return true;
  }

  /** Reads tokens into a slot, reusing whatever prefix of them it holds;
   * the slot the server used, or undefined when the read failed. */
  private async read(tokens: number[], slot: number | undefined, signal?: AbortSignal): Promise<number | undefined> {
    const read = await abortable(httpJson(this.port, 'POST', '/completion', {
      prompt: tokens, n_predict: 0, cache_prompt: true, ...(slot !== undefined ? { id_slot: slot } : {}),
    }, PREFILL_TIMEOUT_MS), signal);
    if (read.status !== 200) return undefined;
    const used = (read.json as { id_slot?: unknown } | undefined)?.id_slot;
    return typeof used === 'number' ? used : slot;
  }

  private async save(slot: number, tokens: number[], kind: Kind): Promise<boolean> {
    const key = keyOf(tokens);
    const written = await httpJson(this.port, 'POST', `/slots/${slot}?action=save`, { filename: `${key}.bin` }, 120_000);
    // 501/400: started without --slot-save-path (an older ClikCode's server).
    if (written.status !== 200) { this.unsupported = written.status === 501 || written.status === 400; return false; }
    // Another session's request between the read and the save would leave
    // the slot holding something else: a state is kept only if it is ours.
    const count = (written.json as { n_saved?: unknown } | undefined)?.n_saved;
    if (typeof count === 'number' && count !== tokens.length) { await this.remove(key); return false; }
    // The tokens beside the state: what a later request shares with it.
    await writeFile(join(this.dir, `${key}${TOKENS_SUFFIX}`), JSON.stringify({ kind, tokens })).catch(() => {});
    await this.prune();
    return true;
  }

  private async remove(key: string): Promise<void> {
    this.sidecars.delete(`${key}${TOKENS_SUFFIX}`);
    await rm(join(this.dir, `${key}.bin`), { force: true });
    await rm(join(this.dir, `${key}${TOKENS_SUFFIX}`), { force: true });
  }

  /** Saved states by key, with their tokens when recorded (a file from an
   * older ClikCode has none and can only be restored whole). */
  private async savedStates(): Promise<Map<string, Saved>> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const saved = new Map<string, Saved>();
    for (const name of names) {
      if (!name.endsWith('.bin')) continue;
      const key = name.slice(0, -'.bin'.length);
      saved.set(key, await this.sidecar(`${key}${TOKENS_SUFFIX}`));
    }
    return saved;
  }

  private async sidecar(name: string): Promise<Saved> {
    const known = this.sidecars.get(name);
    if (known) return known;
    const raw = await readFile(join(this.dir, name), 'utf8').then((text) => JSON.parse(text) as unknown, () => undefined);
    // An array is the first format: a prefix's tokens alone.
    const body = Array.isArray(raw) ? { kind: 'prefix', tokens: raw } : raw as { kind?: unknown; tokens?: unknown } | undefined;
    const tokens = Array.isArray(body?.tokens) && body.tokens.every((token) => typeof token === 'number') ? body.tokens as number[] : undefined;
    const parsed: Saved = { kind: body?.kind === 'conversation' ? 'conversation' : 'prefix', ...(tokens ? { tokens } : {}) };
    if (tokens) this.sidecars.set(name, parsed);
    return parsed;
  }

  /** The tokens of these messages that every later request in the same
   * conversation starts with: what a render of them shares with one that
   * adds a user message, less the slack. */
  private async stableTokens(messages: PrefixRequest['messages'], tools: PrefixRequest['tools']): Promise<number[] | undefined> {
    if (messages.length < 2) return undefined;
    const [now, later] = await Promise.all([
      this.render(messages, tools),
      this.render([...messages, { role: 'user', content: 'Alpha' }], tools),
    ]);
    if (!now || !later) return undefined;
    const length = commonLength(now, later) - BOUNDARY_SLACK;
    return length >= MIN_PREFIX_TOKENS ? now.slice(0, length) : undefined;
  }

  private async render(messages: PrefixRequest['messages'], tools: PrefixRequest['tools']): Promise<number[] | undefined> {
    const rendered = await httpJson(this.port, 'POST', '/apply-template', { messages, ...(tools?.length ? { tools } : {}) });
    const prompt = (rendered.json as { prompt?: unknown } | undefined)?.prompt;
    if (rendered.status !== 200 || typeof prompt !== 'string') return undefined;
    const tokenized = await httpJson(this.port, 'POST', '/tokenize', { content: prompt, add_special: true, parse_special: true });
    const list = (tokenized.json as { tokens?: unknown } | undefined)?.tokens;
    return Array.isArray(list) && list.every((token) => typeof token === 'number') ? list as number[] : undefined;
  }

  /** The longest token prefix two renders of this request share when only
   * the user's message differs, less a little slack; undefined when the
   * server cannot render or tokenize, or the prefix is too short. */
  private async prefixTokens(request: PrefixRequest): Promise<number[] | undefined> {
    const tokens = (user: string): Promise<number[] | undefined> => this.render([request.messages[0]!, { role: 'user', content: user }], request.tools);
    const [first, second] = await Promise.all([tokens('Alpha'), tokens('Zulu')]);
    if (!first || !second) { this.unsupported = true; return undefined; }
    const length = commonLength(first, second) - BOUNDARY_SLACK;
    return length >= MIN_PREFIX_TOKENS ? first.slice(0, length) : undefined;
  }

  /** A slot no request has used since the server started: the only kind a
   * restore cannot take from another session. */
  private async unusedSlot(): Promise<number | undefined> {
    const slots = await httpJson(this.port, 'GET', '/slots');
    if (slots.status !== 200 || !Array.isArray(slots.json)) return undefined;
    return (slots.json as SlotInfo[]).find((slot) => !slot.is_processing && slot.id_task === undefined)?.id;
  }

  /** Prefixes: the newest few. Conversation states: the newest that fit
   * the byte budget. Newest means last saved or restored. */
  private async prune(): Promise<void> {
    const saved = await this.savedStates();
    const dated = await Promise.all([...saved].map(async ([key, state]) => {
      const info = await stat(join(this.dir, `${key}.bin`)).catch(() => undefined);
      return { key, kind: state.kind, at: info?.mtimeMs ?? 0, bytes: info?.size ?? 0 };
    }));
    dated.sort((left, right) => right.at - left.at);
    const budget = await this.conversationBudget();
    let prefixes = 0, bytes = 0;
    for (const state of dated) {
      const keep = state.kind === 'prefix' ? ++prefixes <= KEEP_FILES : (bytes += state.bytes) <= budget;
      if (!keep) await this.remove(state.key);
    }
    // Sidecars whose state is gone.
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (name.endsWith(TOKENS_SUFFIX) && !saved.has(name.slice(0, -TOKENS_SUFFIX.length))) await rm(join(this.dir, name), { force: true });
    }
  }

  private async conversationBudget(): Promise<number> {
    if (this.options.conversationBytes !== undefined) return this.options.conversationBytes;
    const disk = await statfs(this.dir).catch(() => undefined);
    return disk ? Math.min(CONVERSATION_BYTES, disk.bavail * disk.bsize * CONVERSATION_DISK_SHARE) : CONVERSATION_BYTES;
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
function longestBase(prefix: readonly number[], saved: ReadonlyMap<string, Saved>): { key: string; length: number } | undefined {
  let best: { key: string; length: number } | undefined;
  for (const [key, { tokens }] of saved) {
    if (tokens && tokens.length > (best?.length ?? 0) && commonLength(prefix, tokens) === tokens.length) best = { key, length: tokens.length };
  }
  return best;
}

/** The most tokens this prefix shares with any saved prefix. */
function sharedLength(prefix: readonly number[], saved: ReadonlyMap<string, Saved>): number {
  let most = 0;
  for (const { tokens, kind } of saved.values()) if (tokens && kind === 'prefix') most = Math.max(most, commonLength(prefix, tokens));
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
