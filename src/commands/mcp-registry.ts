/**
 * One MCP server, added once, installed into every harness that has MCP.
 *
 * ClikCode does not host these servers and does not proxy them: the harness
 * process connects to an MCP server itself, so the only way to give a harness
 * a tool is to write it into that harness's own configuration. What ClikCode
 * can remove is the repetition -- the same server registered by hand in
 * nineteen places, once per harness, and again per isolated account profile.
 *
 * The write goes through each harness's own `mcp add`, not through its config
 * file. A config format is a private detail a vendor may change between
 * releases; `mcp add` is the documented surface, and it is what validates the
 * entry. Two grammars exist, both read from real CLIs: most take the target
 * as a positional (`mcp add <name> <commandOrUrl> [args...]`, identical across
 * Claude, Gemini and Grok), while Codex requires `--url <url>` for a remote
 * server or `-- <command> [args...]` for a local one.
 */
import { captureNativeHarnessOutput } from './native-harness.js';
import { localHarnessCapabilityManifest, nativeProfileEnvironment } from './native-harness-protocol.js';
import { allLocalHarnesses } from './harness-runtime.js';
import { inspectNativeHarness } from './native-harness.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from './types.js';

/** What a user asked ClikCode to make available, in the one shape both
 * grammars can be produced from. */
export interface McpServerEntry {
  name: string;
  /** A URL for a remote server, or the executable for a local one. */
  target: string;
  /** Arguments for a local server; meaningless for a URL. */
  args?: readonly string[];
}

export function isRemoteTarget(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/** The argv this harness needs to register `entry`, or undefined when it has
 * no `mcp add` at all. */
export function mcpAddArgv(
  harness: AiLocalHarnessDefinition, entry: McpServerEntry,
): readonly string[] | undefined {
  const add = localHarnessCapabilityManifest(harness)?.managers?.mcp?.add;
  if (!add) return undefined;
  const remote = isRemoteTarget(entry.target);
  if (add.shape === 'url-or-doubledash') {
    // Codex: a URL is a flag, a command is everything after `--`. Passing a
    // command positionally here is accepted and then read as a URL.
    return remote
      ? [...add.argv, entry.name, '--url', entry.target]
      : [...add.argv, entry.name, '--', entry.target, ...(entry.args ?? [])];
  }
  const transport = add.transportPrefix && remote ? [...add.transportPrefix, 'http'] : [];
  return [...add.argv, ...transport, entry.name, entry.target, ...(entry.args ?? [])];
}

/** Every harness that can take this entry -- installed, and with an `mcp add`
 * grammar recorded. A harness with an MCP manager but no recorded grammar is
 * deliberately not guessed at: a wrong argv writes a broken server entry. */
export async function harnessesAcceptingMcp(): Promise<AiLocalHarnessDefinition[]> {
  const candidates = allLocalHarnesses().filter(
    (harness) => localHarnessCapabilityManifest(harness)?.managers?.mcp?.add,
  );
  const installed = await Promise.all(candidates.map(async (harness) => {
    const inspection = await inspectNativeHarness(harness, 800).catch(() => undefined);
    return inspection?.installed ? harness : undefined;
  }));
  return installed.filter((harness): harness is AiLocalHarnessDefinition => harness !== undefined);
}

export interface McpInstallResult { harness: string; account?: string; ok: boolean; detail?: string }

/** Registers `entry` with one harness, under one account's own profile.
 *
 * Failures are reported, never thrown: one harness refusing a server is not a
 * reason for the other eighteen to go without it. */
export async function installMcpServer(
  harness: AiLocalHarnessDefinition, entry: McpServerEntry, account?: AiHarnessAccount,
): Promise<McpInstallResult> {
  const argv = mcpAddArgv(harness, entry);
  const label = { harness: harness.command, ...(account?.label ? { account: account.label } : {}) };
  if (!argv) return { ...label, ok: false, detail: 'no mcp add grammar recorded' };
  try {
    await captureNativeHarnessOutput(harness, argv, nativeProfileEnvironment(account?.nativeProfile), 20_000);
    return { ...label, ok: true };
  } catch (error) {
    return { ...label, ok: false, detail: error instanceof Error ? error.message.split('\n')[0] : 'failed' };
  }
}
