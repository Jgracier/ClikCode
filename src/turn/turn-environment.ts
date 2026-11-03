/** Environment supplied to a vendor turn. */
import { homedir } from 'node:os';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/** `path`, or `path-<time>` when something is already there: an earlier set-aside copy must not make the next one fail. */
function freeName(path: string): string {
  return lstatSync(path, { throwIfNoEntry: false }) ? `${path}-${Date.now()}` : path;
}

/** The user's own tools keep their sign-in and state in these folders of the real home, and read
 * them through `~`. The ClikDeploy CLI keeps its sign-in in `~/.config/clikdeploy/auth.json` and
 * `~/.clikdeploy/api-key` and has no variable for either, so under a redirected HOME an agent that ran
 * `clikdeploy` was signed out ("auth_required"), and
 * `~/.clikcode` was a stale copy of ClikCode's state (an Antigravity turn read a 433-byte index from
 * 2026-10-06 and a one-account list, 2026-11-03). Everything else under `.config` and the other dot
 * folders stays the vendor's own: they hold each account's sign-in, which is what the redirect isolates. */
const USER_TOOL_DIRECTORIES = ['.clikdeploy', '.clikcode', '.config/clikdeploy'] as const;

/** A profile that is the vendor's HOME holds its config and sign-in (dot entries), not the user's
 * files: the user's own top-level folders -- projects, Documents -- are links to the real ones.
 * Without them an agent told to work in `~/projects/x` made a second copy inside the profile
 * (a 3.1 GB ClikDeploy checkout under a Kiro account, 2026-10-18). Once per profile per process;
 * an entry the profile already has is left as it is. */
export function linkUserDirectories(profileHome: string, realHome: string): void {
  if (linked.has(profileHome)) return;
  // A profile may be selected before its directory is created. Remembering
  // that failed attempt meant later turns never linked the user's folders.
  if (!existsSync(profileHome)) return;
  let entries: string[];
  try { entries = readdirSync(realHome); } catch { return; }
  let failed = false;
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const real = join(realHome, name);
    try {
      if (!lstatSync(real).isDirectory()) continue;
      if (lstatSync(join(profileHome, name), { throwIfNoEntry: false })) continue;
      symlinkSync(real, join(profileHome, name));
    } catch { failed = true; }
  }
  for (const name of USER_TOOL_DIRECTORIES) {
    const real = join(realHome, name);
    const mine = join(profileHome, name);
    try {
      if (!lstatSync(real, { throwIfNoEntry: false })?.isDirectory()) continue;
      const have = lstatSync(mine, { throwIfNoEntry: false });
      if (have?.isSymbolicLink()) continue;
      mkdirSync(dirname(mine), { recursive: true });
      // A copy the profile grew on its own is set aside, not deleted: it may be all there is of a nested run.
      if (have) renameSync(mine, freeName(`${mine}.before-link`));
      symlinkSync(real, mine);
    } catch { failed = true; }
  }
  if (!failed) linked.add(profileHome);
}
