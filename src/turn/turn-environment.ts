/** Environment supplied to a vendor turn. */
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
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
