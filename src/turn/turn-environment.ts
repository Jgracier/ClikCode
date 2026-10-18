/** Environment supplied to a vendor turn. */
import { homedir } from 'node:os';
import { existsSync, lstatSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AiHarnessAccount, AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../harness/definition.js';
import { nativeAccountEnvironment } from '../harness/transport/profile-environment.js';
import { homeRedirectEnvironment } from '../runtime/lazy-bridge.js';

/** Profile isolation plus, for HOME-rooted profiles, the user's real git/npm/
 * gh/docker configuration so a turn can still commit, push and install. */
export function turnEnvironment(
  harness: AiLocalHarnessDefinition,
  account: AiHarnessAccount | undefined,
  permissionMode?: AiHarnessPermissionMode,
): Record<string, string> {
  const environment = homeRedirectEnvironment(harness, nativeAccountEnvironment(harness, account), { home: homedir(), exists: existsSync });
  if (environment.HOME && environment.HOME !== homedir()) linkUserDirectories(environment.HOME, homedir());
  // A vendor that carries its tool-approval policy in the environment rather
  // than in argv -- Goose, whose only other routes are `goose configure` and
  // an in-session /mode. Omitting it is not neutral: an unset GOOSE_MODE
  // auto-approves every tool call, so the mode has to be stated on every turn
  // and not merely offered in the picker. Management commands pass no mode and
  // get none, which is right: they run no tools.
  const permission = permissionMode ? harness.permissionEnv?.[permissionMode] : undefined;
  // A turn (it has a permission mode) also gets the features the catalog says
  // this vendor keeps off by default -- Claude Code's task-list tools.
  const turn = permissionMode ? harness.turnEnv : undefined;
  return { ...environment, ...(turn ?? {}), ...(permission ?? {}) };
}

const linked = new Set<string>();

/** A profile that is the vendor's HOME holds its config and sign-in (dot entries), not the user's
 * files: the user's own top-level folders -- projects, Documents -- are links to the real ones.
 * Without them an agent told to work in `~/projects/x` made a second copy inside the profile
 * (a 3.1 GB ClikDeploy checkout under a Kiro account, 2026-10-18). Once per profile per process;
 * an entry the profile already has is left as it is. */
export function linkUserDirectories(profileHome: string, realHome: string): void {
  if (linked.has(profileHome)) return;
  linked.add(profileHome);
  let entries: string[];
  try { entries = readdirSync(realHome); } catch { return; }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const real = join(realHome, name);
    try {
      if (!lstatSync(real).isDirectory()) continue;
      if (lstatSync(join(profileHome, name), { throwIfNoEntry: false })) continue;
      symlinkSync(real, join(profileHome, name));
    } catch { /* fail-open-ok: a folder not linked is only the old behaviour. */ }
  }
}
