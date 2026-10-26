/** Cleanup for session/new used only to read metadata. */
import { rm } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { AiLocalHarnessDefinition } from '../definition.js';

export async function discoveryCleanup(harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>): Promise<((id: string, cwd: string) => Promise<void>) | undefined> {
  // Runtime import: the store registry also exposes ACP transcript readers.
  const { nativeSessionStore } = await import('../../session/discovery/registry.js');
  const store = nativeSessionStore(harness);
  if (store?.remove) return (id, cwd) => store.remove!(id, cwd, environment);
  const root = store?.root(environment);
  if (!store?.locate || !root) return undefined;
  return async (id, cwd) => {
    const found = await store.locate!(root, id, cwd, environment);
    if (!found) return;
    const within = relative(resolve(root), resolve(found.path));
    if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Probe session is outside its vendor store');
    await rm(found.path, { recursive: true, force: true });
  };
}
