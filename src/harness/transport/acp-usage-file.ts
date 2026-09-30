/** A session's running usage read from the file the agent keeps it in, for
 * an agent whose ACP stream carries none.
 *
 * Cline's ACP server drops its own `usage` events (its forwarder maps
 * `case "usage": return []`) and answers session/prompt with a stop reason
 * alone, yet it writes the session's totals to
 * `~/.cline/data/sessions/<id>/<id>.json` as `metadata.usage`
 * (`{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 * totalCost}`). Checked against Cline 3.0.65. */

import { readFile } from 'node:fs/promises';
import { expandAuthPath } from '../accounts/auth-files.js';
import { asRecord } from '../protocol/json-lines.js';
import { countsOf, type TurnUsage } from '../protocol/turn-usage.js';

export interface AcpUsageFile { path: string; field: readonly string[] }

/** The session's usage totals so far, or undefined when the file or the
 * field is not there (a session the agent has not written yet). */
export async function readAcpUsageFile(
  declaration: AcpUsageFile, sessionId: string, environment: Readonly<Record<string, string | undefined>>,
): Promise<TurnUsage | undefined> {
  // A session id is a file name here: nothing that could leave the directory.
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId) || sessionId.startsWith('.')) return undefined;
  const path = expandAuthPath(declaration.path.replaceAll('{id}', sessionId), { ...process.env, ...environment });
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } // fail-open-ok: no file yet is no usage, not an error
  for (const key of declaration.field) value = asRecord(value)?.[key];
  const usage = asRecord(value);
  if (!usage) return undefined;
  const totals = countsOf(usage);
  const cost = [usage.totalCost, usage.cost].find((candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate));
  if (cost !== undefined) totals.costUsd = cost;
  return Object.keys(totals).length ? totals : undefined;
}
