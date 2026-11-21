/** The activity file a headless agent's tool servers share (`clikcode agent run` makes it and passes its path to every MCP server it
 * starts as CLIKCODE_AGENT_ACTIVITY, with the call budget as CLIKCODE_AGENT_MAX_CALLS). A server appends `+` when a call starts and `.`
 * when it returns, so the runner can tell an agent that is working (calls coming, or one in flight such as a captcha solve or a texted
 * code) from one that has stalled, and every server can refuse calls past the one budget they share. Any MCP server may join: it only
 * appends to the file. */
import { appendFile, readFile } from 'node:fs/promises';

export const ACTIVITY_ENV = 'CLIKCODE_AGENT_ACTIVITY';
export const MAX_CALLS_ENV = 'CLIKCODE_AGENT_MAX_CALLS';

export interface Activity { started: number; finished: number; inFlight: boolean }

export function parseActivity(text: string): Activity {
  let started = 0, finished = 0;
  for (const ch of text) { if (ch === '+') started++; else if (ch === '.') finished++; }
  return { started, finished, inFlight: started > finished };
}

export async function readActivity(file: string): Promise<Activity> {
  return parseActivity(await readFile(file, 'utf8').catch(() => ''));
}

export async function markActivity(file: string | undefined, mark: '+' | '.'): Promise<void> {
  if (file) await appendFile(file, mark).catch(() => undefined);
}
