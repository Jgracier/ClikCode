/** Short human labels: a compacted path, and which provider a session is on. */

import { homedir } from 'node:os';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import type { HarnessSession } from '../../session/model.js';

export function compactPath(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function sessionProviderLabel(session: HarnessSession): string {
  if (session.route === 'gateway') return 'Gateway';
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  return harness?.displayName ?? session.provider ?? 'Not selected';
}
