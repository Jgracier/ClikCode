/** What a slash command is given to work with: the session's harness, the
 * custom commands in scope, and the extras the grammar needs to route. */

import { isClikCodeAgent } from '../../session/route.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessSession } from '../../session/model.js';
import { localHarnessCapabilityManifest, localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { sessionNativeCommands } from '../../turn/runtime.js';
import { allLocalHarnesses, harnessCanRunTurns, harnessTierRank } from '../../runtime/lazy-bridge.js';
import { type SlashExtras, type SlashRouteContext } from './registry.js';
import { discoverCustomCommands, type CustomCommand } from '../../session/custom-commands.js';

/** Shared slash-command grammar for a future TTY client and the headless CLI. */
export function sessionHarness(session: HarnessSession | undefined): AiLocalHarnessDefinition | undefined {
  return !isClikCodeAgent(session) && session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
}

export function customCommandsFor(session: HarnessSession, harness: AiLocalHarnessDefinition | undefined): CustomCommand[] {
  // ClikCode's own agent (Gateway, Local) reads Claude Code's CLAUDE.md and
  // .claude/skills, so it reads Claude's command directories too, expanded here.
  const source = isClikCodeAgent(session) ? localHarnessForCommand('claude') : harness;
  return discoverCustomCommands(source, { workspace: session.workspace ?? process.cwd(), ...CUSTOM_COMMAND_ROOTS });
}

/** Test seam: redirect `~` and ClikCode's own command directories. */
const CUSTOM_COMMAND_ROOTS: { home?: string; clikcodeDirs?: readonly string[] } = {};

export function slashExtrasFor(session: HarnessSession, harness: AiLocalHarnessDefinition | undefined): SlashExtras {
  const managers = harness ? localHarnessCapabilityManifest(harness).managers ?? {} : {};
  return {
    managers: Object.entries(managers).map(([name, manager]) => ({ name, label: manager?.label ?? name })),
    native: isClikCodeAgent(session) ? [] : sessionNativeCommands(session.id),
    custom: customCommandsFor(session, harness),
    harnesses: allLocalHarnesses().filter((item) => harnessCanRunTurns(item))
      .map((item, index) => ({ item, index })).sort((a, b) => harnessTierRank(a.item) - harnessTierRank(b.item) || a.index - b.index)
      .map(({ item }) => ({ command: item.command, displayName: item.displayName })),
  };
}

export function slashRouteContextFor(
  session: HarnessSession, harness: AiLocalHarnessDefinition | undefined, pathExists?: (path: string) => boolean,
): SlashRouteContext {
  const extras = slashExtrasFor(session, harness);
  return {
    ...(harness ? { harness } : {}),
    harnessCommands: (extras.harnesses ?? []).map((item) => item.command),
    managerNames: (extras.managers ?? []).map((item) => item.name),
    nativeCommands: (extras.native ?? []).map((item) => item.name.replace(/^\//, '').toLowerCase()),
    customCommands: (extras.custom ?? []).map((item) => item.name),
    ...(pathExists ? { pathExists } : {}),
  };
}
