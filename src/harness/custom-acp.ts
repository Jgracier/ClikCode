/** User-added Agent Client Protocol harnesses.
 *
 * The built-in catalog cannot grow every time a new agent publishes an ACP
 * command. This file is the list the user keeps (`custom-acp.json` in the
 * ClikCode state directory). The running process rereads it whenever the
 * file changes, so a CLI add and the VS Code provider list see the same set.
 */

import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AiCustomAcpHarnessInput, AiLocalHarnessDefinition } from './definition.js';
import { atomicWriteFile } from '../session/store/files.js';
import { stateDirectory } from '../session/store/paths.js';



export interface CustomAcpCatalog {
  customAcpHarness(definition: AiCustomAcpHarnessInput): unknown;
  registerCustomHarnesses(definitions: readonly AiLocalHarnessDefinition[]): unknown;
}

interface CatalogShape extends CustomAcpCatalog {
  AI_LOCAL_HARNESSES: readonly { command: string; provider: string }[];
}

/** The catalog bundle, not the router package: the CLI build rejects a runtime
 * import of `@clikcode/router`. Source tests resolve `src/harness/` -> `dist/`;
 * the bundled CLI sits beside `harness-catalog.cjs`. */
function catalogBundle(): CatalogShape {
  const require = createRequire(import.meta.url);
  try { return require('../../dist/harness-catalog.cjs') as CatalogShape; } catch { /* bundled */ }
  return require('./harness-catalog.cjs') as CatalogShape;
}

export function customAcpConfigPath(): string {
  return join(stateDirectory(), 'custom-acp.json');
}

/** Parse the on-disk list. A damaged file is empty rather than fatal: one
 * bad edit must not stop every later catalog read. */
export function parseCustomAcpConfig(text: string): AiCustomAcpHarnessInput[] {
  let parsed: { harnesses?: unknown };
  try { parsed = JSON.parse(text) as { harnesses?: unknown }; } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.harnesses)) return [];
  const records: AiCustomAcpHarnessInput[] = [];
  for (const entry of parsed.harnesses) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.command !== 'string' || typeof record.binary !== 'string') continue;
    const argv = Array.isArray(record.argv) ? record.argv.filter((arg): arg is string => typeof arg === 'string') : [];
    records.push({
      command: record.command,
      binary: record.binary,
      argv,
      ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
      ...(typeof record.provider === 'string' ? { provider: record.provider } : {}),
    });
  }
  return records;
}

function storedShape(records: readonly AiCustomAcpHarnessInput[]): string {
  return `${JSON.stringify({ harnesses: records }, null, 2)}\n`;
}

/** Refuse a name or provider the built-in catalog already owns. */
export function assertCustomAcpAvailable(definition: AiCustomAcpHarnessInput): AiLocalHarnessDefinition {
  const catalog = catalogBundle();
  const built = catalog.customAcpHarness(definition) as AiLocalHarnessDefinition;
  const taken = catalog.AI_LOCAL_HARNESSES.some((item) => item.command === built.command || item.provider === built.provider);
  if (taken) throw new Error(`"${built.command}" is already a built-in harness`);
  return built;
}

export async function writeCustomAcpConfig(records: readonly AiCustomAcpHarnessInput[]): Promise<void> {
  await atomicWriteFile(customAcpConfigPath(), storedShape(records));
  loadedSignature = undefined;
  lastCheck = undefined;
}

export async function readCustomAcpConfig(): Promise<AiCustomAcpHarnessInput[]> {
  try {
    return parseCustomAcpConfig(readFileSync(customAcpConfigPath(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

export async function addCustomAcpHarness(definition: AiCustomAcpHarnessInput): Promise<AiLocalHarnessDefinition> {
  const built = assertCustomAcpAvailable(definition);
  const records = await readCustomAcpConfig();
  for (const item of records) {
    let existing: AiLocalHarnessDefinition;
    try { existing = catalogBundle().customAcpHarness(item) as AiLocalHarnessDefinition; }
    catch { continue; }
    if (existing.command !== built.command && existing.provider === built.provider) {
      throw new Error(`provider "${built.provider}" is already used by custom ACP harness "${existing.command}"`);
    }
  }
  const next = records.filter((item) => {
    try { return (catalogBundle().customAcpHarness(item) as AiLocalHarnessDefinition).command !== built.command; } catch { return true; }
  });
  next.push({
    command: built.command, binary: built.binary, argv: [...(built.acp?.argv ?? [])],
    displayName: built.displayName, provider: built.provider,
  });
  await writeCustomAcpConfig(next);
  return built;
}

export async function removeCustomAcpHarness(command: string): Promise<boolean> {
  const wanted = command.trim().replace(/^\//, '').toLowerCase();
  const records = await readCustomAcpConfig();
  const next = records.filter((item) => {
    try { return (catalogBundle().customAcpHarness(item) as AiLocalHarnessDefinition).command !== wanted; }
    catch { return item.command.trim().replace(/^\//, '').toLowerCase() !== wanted; }
  });
  if (next.length === records.length) return false;
  await writeCustomAcpConfig(next);
  return true;
}

let loadedSignature: string | undefined;

/** The file is looked at no more often than this. Every catalog lookup
 * comes through here -- several a frame while an answer streams -- and each
 * was a stat, and for the usual missing file a thrown ENOENT error built and
 * caught. Another process's add (VS Code's provider list) shows within it;
 * this process's own add shows at once (writeCustomAcpConfig). */
const CHECK_MS = 1000;
let lastCheck: { path: string; at: number } | undefined;

/** Test isolation: the next catalog read loads the file again. */
export function resetCustomAcpLoadForTests(): void {
  loadedSignature = undefined;
  lastCheck = undefined;
}

/** Reread the file when it changed and register the result on `catalog`.
 * Called from the one catalog bundle the process actually uses. */
export function reloadCustomAcpHarnesses(catalog: CustomAcpCatalog): void {
  const path = customAcpConfigPath();
  const now = Date.now();
  if (lastCheck?.path === path && now - lastCheck.at < CHECK_MS) return;
  lastCheck = { path, at: now };
  let signature: string;
  let text: string;
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) {
      if (loadedSignature !== undefined && loadedSignature !== 'missing') catalog.registerCustomHarnesses([]);
      loadedSignature = 'missing';
      return;
    }
    signature = `${stat.mtimeMs}:${stat.size}`;
    if (signature === loadedSignature) return;
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  let records: AiCustomAcpHarnessInput[];
  try { records = parseCustomAcpConfig(text); } catch { return; }
  const definitions: AiLocalHarnessDefinition[] = [];
  for (const record of records) {
    try { definitions.push(catalog.customAcpHarness(record) as AiLocalHarnessDefinition); } catch { /* a row the add command would have refused */ }
  }
  catalog.registerCustomHarnesses(definitions);
  loadedSignature = signature;
}
