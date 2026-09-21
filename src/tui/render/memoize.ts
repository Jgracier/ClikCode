/** A bounded cache keyed by the text that produced the value. Rendering the
 * same line every frame is the common case. */



/** Least-recently-USED, not least-recently-added: a Map iterates in insertion
 * order, so re-inserting on every hit keeps the entries a repaint actually
 * touches (the forty messages on screen) and evicts the ones it does not. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();
  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  has(key: K): boolean { return this.entries.has(key); }
  get size(): number { return this.entries.size; }
}

/** A repaint re-lays-out every message on screen. Keying on the exact source
 * text turns the settled messages into cache hits. Text that is still being
 * streamed must NOT come through here -- every delta is a brand new key holding
 * the whole answer so far, which filled the cache with dead prefixes and
 * evicted the settled messages it exists for; see createStreamingBlockParser
 * and renderInlineMarkdownLive. Results are immutable by contract. */
export function memoizeByText<T>(compute: (text: string) => T, limit = 256): (text: string) => T {
  const cache = new LruCache<string, { value: T }>(limit);
  return (text) => {
    const hit = cache.get(text);
    if (hit) return hit.value;
    const value = compute(text);
    cache.set(text, { value });
    return value;
  };
}
