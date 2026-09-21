/** Structural clone and compare: the two questions the merge and the write
 * path ask about plain data, in one place so they cannot disagree. */



/** Clones containers and shares the (immutable) strings inside them. The cost
 * follows the number of objects, not the number of transcript bytes, which is
 * what makes a per-write baseline affordable. Keys holding `undefined` are
 * dropped, matching what JSON persistence would do. */
export function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneData(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = cloneData(item);
    }
    return result as T;
  }
  return value;
}

/** JSON-equivalence without serializing: `{ a: undefined }` equals `{}`. Shared
 * strings compare by pointer, so an untouched transcript costs almost nothing. */
export function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const a = left as unknown[];
    const b = right as unknown[];
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (!sameData(a[index], b[index])) return false;
    return true;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  let defined = 0;
  for (const key of Object.keys(a)) {
    if (a[key] === undefined) continue;
    defined += 1;
    if (!sameData(a[key], b[key])) return false;
  }
  let otherDefined = 0;
  for (const key of Object.keys(b)) if (b[key] !== undefined) otherDefined += 1;
  return defined === otherDefined;
}
