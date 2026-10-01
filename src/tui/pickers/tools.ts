/** Tools & integrations: the harness's own managers (MCP servers, skills,
 * plugins, hooks, …) and recording an MCP server for whichever harness is chosen.
 *
 * The managers were reachable only by typing `/mcp`, `/plugins` and so on --
 * left out of the `/` palette on purpose, since the vendor owns them -- and a
 * manager with a list command only ever printed the list, never offering the
 * vendor's own screen for changing it. Here each is one row: its list, and
 * its manager when it has one. */

import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import { recordSharedMcpServer } from '../../harness/mcp-registry.js';
import { runNativeHarnessCommand } from '../../harness/transport/native/command.js';
import { localHarnessCapabilityManifest } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { turnEnvironment } from '../../turn/turn-environment.js';
import { nativeManagerListing } from '../slash/native-manager.js';
import { TerminalHarnessPrompter } from '../prompter.js';
import { chooseOption } from './choose.js';

type Manager = { label: string; listArgv?: readonly string[]; manageArgv?: readonly string[] };

export function harnessManagers(harness: AiLocalHarnessDefinition): [string, Manager][] {
  const managers = localHarnessCapabilityManifest(harness).managers as Record<string, Manager | undefined> | undefined;
  return Object.entries(managers ?? {}).filter((entry): entry is [string, Manager] => Boolean(entry[1]));
}

export async function interactiveToolsPicker(rl: HarnessPrompter, id: string, harness: AiLocalHarnessDefinition): Promise<void> {
  const managers = harnessManagers(harness);
  const choice = await chooseOption(rl, 'Tools & integrations', [
    ...managers.map(([name, manager]) => ({
      label: manager.label,
      detail: `· ${[manager.listArgv ? 'list' : '', manager.manageArgv ? `open ${harness.displayName}'s manager` : ''].filter(Boolean).join(' · ')}`,
      value: name,
    })),
    { label: 'Add an MCP server', detail: '· recorded once, installed into a harness when you choose it', value: '__mcp_everywhere__' },
  ]);
  if (!choice) return;
  if (choice === '__mcp_everywhere__') return addMcpEverywhere(rl);
  const manager = managers.find(([name]) => name === choice)?.[1];
  if (!manager) return;
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  // Both, when the vendor has both: see what is there, then change it.
  const action = manager.listArgv && manager.manageArgv
    ? await chooseOption(rl, manager.label, [
      { label: `Show ${manager.label.toLowerCase()}`, value: 'list' },
      { label: `Open ${harness.displayName}'s manager`, value: 'manage' },
    ])
    : manager.listArgv ? 'list' : 'manage';
  if (action === 'list') {
    const listing = await nativeManagerListing(state, session, choice);
    rl.panel?.(listing.label, listing.text);
  } else if (action === 'manage' && manager.manageArgv && rl instanceof TerminalHarnessPrompter) {
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    await rl.suspend();
    try { await runNativeHarnessCommand(harness, manager.manageArgv, turnEnvironment(harness, account)); } finally { rl.resume(); }
  }
}

async function addMcpEverywhere(rl: HarnessPrompter): Promise<void> {
  const name = (await rl.question('Server name › ')).trim();
  if (!name) return;
  const line = (await rl.question('Command to run, or URL › ')).trim();
  if (!line) return;
  const [target, ...args] = line.split(/\s+/);
  await recordSharedMcpServer({ name, target: target!, ...(args.length ? { args } : {}) });
  rl.panel?.(`MCP server ${name}`, `${name} is recorded. A harness receives it the first time you choose that provider, if the name is not already there.`);
}
