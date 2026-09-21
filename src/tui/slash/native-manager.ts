/** The vendor's own session manager, listed for `/sessions`. */

import { open } from 'node:fs/promises';
import { captureNativeHarnessOutput } from '../../harness/transport/native/command.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { localHarnessCapabilityManifest } from '../../runtime/lazy-bridge.js';
import { turnEnvironment } from '../../turn/runtime.js';
import { sessionHarness } from './context.js';

export async function nativeManagerListing(state: HarnessState, session: HarnessSession, name: string): Promise<{ label: string; text: string }> {
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider first.');
  const manager = (localHarnessCapabilityManifest(harness).managers as Record<string, { label: string; listArgv?: readonly string[] } | undefined> | undefined)?.[name];
  if (!manager) throw new Error(`${harness.displayName} does not publish a ${name} manager.`);
  if (!manager.listArgv) throw new Error(`${harness.displayName} manages ${manager.label} only in its own interactive UI; open it from the interactive ClikCode session.`);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const text = await captureNativeHarnessOutput(harness, manager.listArgv, turnEnvironment(harness, account), 15_000, session.workspace);
  return { label: manager.label, text: text.trim() || 'No entries.' };
}
