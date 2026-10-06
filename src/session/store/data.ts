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

/** Three-way merge of one record's fields: a field this process changed since
 * `baseline` takes `working`'s value (or stays deleted), every other field
 * comes from `disk`. Fields are taken whole: merging whole records let one
 * stale field in a long-lived snapshot revert another process's update to the
 * same record, and merging inside a field could pair one writer's half with
 * the other's. */
export function mergeFields<T extends object>(baseline: T | undefined, working: T, disk: T | undefined): T {
  if (!disk) return working;
  const before = (baseline ?? {}) as Record<string, unknown>;
  const after = (working ?? {}) as Record<string, unknown>;
  const result = { ...(disk as Record<string, unknown>) };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (sameData(before[key], after[key])) continue;
    if (after[key] === undefined) delete result[key];
    else result[key] = after[key];
  }
  return result as T;
}

export function hidden<T extends object>(target: T, key: PropertyKey, value: unknown): T {
  // Non-enumerable so it never reaches JSON.stringify, spreads, equality
  // checks, or any panel that prints state.
  Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
  return target;
}
