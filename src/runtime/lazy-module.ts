/** A dependency loaded at its first use rather than when the CLI starts: a
 * command that never needs it (`--version`, a vendor turn that never parses a
 * skill) pays nothing for its module graph. Synchronous, so it fits call sites
 * that are not async; the packages named here all ship a CommonJS build. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function lazyModule<T>(name: string): () => T {
  let loaded: T | undefined;
  return () => (loaded ??= require(name) as T);
}
