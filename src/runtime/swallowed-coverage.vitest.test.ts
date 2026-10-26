/** Failures that are swallowed on purpose are written down (runtime/lifecycle-log.ts swallowed/quiet).
 * This keeps it so: a new `.catch(() => undefined)` or an empty `catch {}` is a failure nobody will
 * ever see, and the test says where to put the area name instead. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/** Code that cannot import the logger: strings run in another process or thread, and the logger's own imports. */
const EXEMPT = new Set([
  'local-models/lifecycle.ts', 'agent/computer/tailnet-handoff.ts', 'worker/stuck-watchdog.ts',
  'runtime/lifecycle-log.ts', 'runtime/redact.ts', 'session/store/paths.ts', 'agent/computer/secret-scrubber.ts', 'agent/computer/shared-state.ts',
]);

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.(?:vitest\.)?test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('swallowed failures', () => {
  const found: string[] = [];
  for (const path of sources(SRC)) {
    const name = relative(SRC, path);
    if (EXEMPT.has(name)) continue;
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) return;
      if (/\.catch\(\(\) => undefined\)/.test(line)) found.push(`${name}:${index + 1}  .catch(() => undefined)  ->  .catch(quiet('${name.replace(/\.tsx?$/, '')}'))`);
      if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(line)) found.push(`${name}:${index + 1}  empty catch  ->  catch (error) { swallowed('${name.replace(/\.tsx?$/, '')}', error); }`);
    });
  }
  it('are all written down: none is dropped without a trace', () => {
    expect(found).toEqual([]);
  });
});
