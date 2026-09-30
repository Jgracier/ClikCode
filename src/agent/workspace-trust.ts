/** Which workspaces the user has said may run their own hooks.
 *
 * A project's `.claude/settings*.json` can declare commands that run on
 * every turn with no approval -- anyone who can put a file in a repository
 * could run code on this machine the moment it is opened. So, like Claude
 * Code's workspace trust, a project's hooks run only once the user has said
 * yes for that folder. The record lives in the state directory, which the
 * agent can neither read nor write (security.ts), so a model cannot trust a
 * workspace on the user's behalf. */
import fs from 'node:fs/promises';
import path from 'node:path';

const TRUST_FILE = 'trusted-workspaces.json';

async function canonical(dir: string): Promise<string> {
  const absolute = path.resolve(dir);
  return fs.realpath(absolute).catch(() => absolute);
}

async function readTrusted(stateDir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(stateDir, TRUST_FILE), 'utf8')) as { workspaces?: unknown };
    return Array.isArray(parsed.workspaces) ? parsed.workspaces.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    // fail-open-ok: no record (or an unreadable one) trusts nothing, the safe answer.
    return [];
  }
}

/** True when `cwd` is a trusted folder or inside one. */
export async function isWorkspaceTrusted(stateDir: string, cwd: string): Promise<boolean> {
  const target = await canonical(cwd);
  return (await readTrusted(stateDir)).some((root) => {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export async function trustWorkspace(stateDir: string, cwd: string): Promise<void> {
  const target = await canonical(cwd);
  const trusted = await readTrusted(stateDir);
  if (trusted.includes(target)) return;
  const file = path.join(stateDir, TRUST_FILE);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify({ workspaces: [...trusted, target] }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}
