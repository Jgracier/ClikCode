/** Why an ACP agent gave up a prompt it then ended as `cancelled` with
 * nothing said, read where the catalog says it writes it
 * (`acp.silentRefusalLog`). Junie answers a JetBrains account with no AI plan
 * that way; ClikCode could only guess "its sign-in is not usable", and a
 * fresh sign-in changed nothing. Undefined when there is nothing to read. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expandAuthPath } from '../accounts/auth-files.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';

/** Only a log written during this turn speaks for it. */
const RECENT_MS = 10 * 60_000;

export function refusalFromLog(text: string, pattern: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(pattern, 'g'))];
  const raw = matches.at(-1)?.[1];
  if (!raw) return undefined;
  const said = raw.replace(/\\n/g, ' ').replace(/\\(["\\/])/g, '$1').replace(/\s+/g, ' ').trim();
  return said || undefined;
}

export async function silentRefusalReason(
  command: string, environment: Readonly<Record<string, string>>, now = Date.now(),
): Promise<string | undefined> {
  const spec = localHarnessForCommand(command)?.acp?.silentRefusalLog;
  if (!spec) return undefined;
  try {
    const dir = expandAuthPath(spec.dir, { ...process.env, ...environment });
    const logs = (await readdir(dir)).filter((name) => /^log-.*\.log$/.test(name));
    const dated = await Promise.all(logs.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs })));
    const newest = dated.sort((left, right) => right.at - left.at)[0];
    if (!newest || now - newest.at > RECENT_MS) return undefined;
    return refusalFromLog(await readFile(join(dir, newest.name), 'utf8'), spec.pattern);
  } catch { return undefined; } // fail-open-ok: the generic explanation still stands
}
