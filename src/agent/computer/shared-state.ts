/** State that must outlive a reload of the computer tools' code (see hot-tools.ts): a chat's tab, the
 * secrets being scrubbed, a running handoff. A reloaded copy of a module finds the same object here. */
export function sharedState<T>(key: string, make: () => T): T {
  const holder = globalThis as unknown as Record<string, unknown>;
  const name = `__clikcode_${key}`;
  return (holder[name] ??= make()) as T;
}
