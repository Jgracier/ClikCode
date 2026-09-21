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
import { captureNativeHarnessOutput } from './transport/native/command.js';
import { nativeProfileEnvironment } from './transport/profile-environment.js';
import { localHarnessCapabilityManifest } from '../runtime/lazy-bridge.js';
import { allLocalHarnesses } from '../runtime/lazy-bridge.js';
import { inspectNativeHarness } from './transport/native/inspect.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from './definition.js';

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

/** How one harness spells `mcp add`, as the catalog records it. */
type McpAddGrammar = {
  argv: readonly string[];
  shape: 'positional' | 'url-or-doubledash' | 'doubledash-local';
  transportPrefix?: readonly string[];
};

/** What the catalog says about this harness, or undefined when it records no
 * `mcp add` at all. */
export function mcpAddGrammar(harness: AiLocalHarnessDefinition): McpAddGrammar | undefined {
  return localHarnessCapabilityManifest(harness)?.managers?.mcp?.add;
}

/** The argv that registers `entry` under `add`.
 *
 * Takes the grammar rather than looking it up, so the part that has to be
 * exactly right is a pure function of its inputs and can be tested without a
 * catalog runtime behind it. */
export function mcpAddArgv(
  add: McpAddGrammar | undefined, entry: McpServerEntry,
): readonly string[] | undefined {
  if (!add) return undefined;
  const remote = isRemoteTarget(entry.target);
  if (add.shape === 'url-or-doubledash') {
    // Codex: a URL is a flag, a command is everything after `--`. Passing a
    // command positionally here is accepted and then read as a URL.
    return remote
      ? [...add.argv, entry.name, '--url', entry.target]
      : [...add.argv, entry.name, '--', entry.target, ...(entry.args ?? [])];
  }
  if (add.shape === 'doubledash-local') {
    // Copilot, Amp and Cline take a URL positionally but insist on `--`
    // before a local command, so its arguments are not read as their own.
    const transport = add.transportPrefix && remote ? [...add.transportPrefix, 'http'] : [];
    return remote
      ? [...add.argv, ...transport, entry.name, entry.target]
      : [...add.argv, entry.name, '--', entry.target, ...(entry.args ?? [])];
  }
  const transport = add.transportPrefix && remote ? [...add.transportPrefix, 'http'] : [];
  return [...add.argv, ...transport, entry.name, entry.target, ...(entry.args ?? [])];
}

/** Every harness that can take this entry -- installed, and with an `mcp add`
 * grammar recorded. A harness with an MCP manager but no recorded grammar is
 * deliberately not guessed at: a wrong argv writes a broken server entry. */
export async function harnessesAcceptingMcp(): Promise<AiLocalHarnessDefinition[]> {
  const candidates = allLocalHarnesses().filter((harness) => mcpAddGrammar(harness));
  const installed = await Promise.all(candidates.map(async (harness) => {
    const inspection = await inspectNativeHarness(harness, 800).catch(() => undefined);
    return inspection?.installed ? harness : undefined;
  }));
  return installed.filter((harness): harness is AiLocalHarnessDefinition => harness !== undefined);
}

interface McpInstallResult { harness: string; account?: string; ok: boolean; detail?: string }

/** Registers `entry` with one harness, under one account's own profile.
 *
 * Failures are reported, never thrown: one harness refusing a server is not a
 * reason for the other eighteen to go without it. */
async function installMcpServer(
  harness: AiLocalHarnessDefinition, entry: McpServerEntry, account?: AiHarnessAccount,
): Promise<McpInstallResult> {
  const argv = mcpAddArgv(mcpAddGrammar(harness), entry);
  const label = { harness: harness.command, ...(account?.label ? { account: account.label } : {}) };
  if (!argv) return { ...label, ok: false, detail: 'no mcp add grammar recorded' };
  try {
    await captureNativeHarnessOutput(harness, argv, nativeProfileEnvironment(account?.nativeProfile), 20_000);
    return { ...label, ok: true };
  } catch (error) {
    return { ...label, ok: false, detail: error instanceof Error ? error.message.split('\n')[0] : 'failed' };
  }
}

/** Registers `entry` everywhere it can go: every installed harness with a
 * recorded grammar, once per account that has its own isolated profile.
 *
 * One account per harness where none is isolated, because a harness without
 * profile isolation has a single configuration and writing it twice would
 * just repeat the same work.
 */
export async function installMcpServerEverywhere(
  entry: McpServerEntry, accounts: readonly AiHarnessAccount[],
): Promise<McpInstallResult[]> {
  const harnesses = await harnessesAcceptingMcp();
  const results: McpInstallResult[] = [];
  for (const harness of harnesses) {
    const profiles = harness.profileEnv
      ? accounts.filter((account) => account.provider === harness.provider && account.nativeProfile)
      : [];
    const targets: Array<AiHarnessAccount | undefined> = profiles.length ? profiles : [undefined];
    for (const account of targets) {
      // Sequential on purpose: these write vendor config files, and two
      // processes rewriting one file at once is how a config is lost.
      results.push(await installMcpServer(harness, entry, account));
    }
  }
  return results;
}
