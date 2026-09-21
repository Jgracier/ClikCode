/** One MCP entry, spelled the way each harness demands.
 *
 * Two grammars exist, both read from real CLIs: most take the target as a
 * positional, while Codex needs --url for a remote server and `--` before a
 * local command. Getting this wrong writes a server entry that looks
 * installed and never connects.
 */
import { describe, expect, it } from 'vitest';
import { mcpAddArgv, isRemoteTarget } from './mcp-registry';
import { allLocalHarnesses, localHarnessCapabilityManifest } from '@clikcode/router/ai-local-harness';

const grammarOf = (command: string) => {
  const harness = allLocalHarnesses().find((item) => item.command === command)!;
  return (localHarnessCapabilityManifest(harness) as { managers?: { mcp?: { add?: never } } }).managers?.mcp?.add;
};

const local = { name: 'figma', target: 'npx', args: ['-y', 'figma-mcp'] };
const remote = { name: 'sentry', target: 'https://mcp.sentry.dev/mcp' };
const argv = (command: string, entry: Parameters<typeof mcpAddArgv>[1]): string =>
  (mcpAddArgv(grammarOf(command), entry) ?? []).join(' ');

describe('spelling "add this MCP server"', () => {
  it('passes a local command positionally where the CLI takes it that way', () => {
    expect(argv('claude', local)).toBe('mcp add figma npx -y figma-mcp');
    expect(argv('gemini', local)).toBe('mcp add figma npx -y figma-mcp');
    expect(argv('grok', local)).toBe('mcp add figma npx -y figma-mcp');
  });

  it('states the transport for a URL where the CLI wants one', () => {
    expect(argv('claude', remote)).toBe('mcp add --transport http sentry https://mcp.sentry.dev/mcp');
    expect(argv('gemini', remote)).toBe('mcp add --transport http sentry https://mcp.sentry.dev/mcp');
    // Grok infers stdio-vs-URL from the value itself and takes no flag.
    expect(argv('grok', remote)).toBe('mcp add sentry https://mcp.sentry.dev/mcp');
  });

  it('uses Codex\'s own shape, which no positional form can express', () => {
    // `codex mcp add <NAME> (--url <URL> | -- <COMMAND>...)`: passing a
    // command positionally here is accepted and then read as a URL.
    expect(argv('codex', remote)).toBe('mcp add sentry --url https://mcp.sentry.dev/mcp');
    expect(argv('codex', local)).toBe('mcp add figma -- npx -y figma-mcp');
  });

  it('puts a local command behind -- where the CLI insists on it', () => {
    // Copilot, Amp and Cline take a URL positionally but need the separator
    // before a command, or its arguments are read as their own.
    expect(argv('copilot', local)).toBe('mcp add figma -- npx -y figma-mcp');
    expect(argv('amp', local)).toBe('mcp add figma -- npx -y figma-mcp');
    expect(argv('cline', local)).toBe('mcp add --yes figma -- npx -y figma-mcp');
  });

  it('passes a URL positionally for those same three, with a transport where wanted', () => {
    expect(argv('copilot', remote)).toBe('mcp add --transport http sentry https://mcp.sentry.dev/mcp');
    expect(argv('cline', remote)).toBe('mcp add --yes --transport http sentry https://mcp.sentry.dev/mcp');
    // Amp auto-detects the transport from the URL and takes no flag.
    expect(argv('amp', remote)).toBe('mcp add sentry https://mcp.sentry.dev/mcp');
  });

  it('spells the transport the way each CLI names it', () => {
    // Antigravity calls it --type, Droid calls it --type, Claude --transport.
    expect(argv('antigravity', remote)).toBe('mcp add --type http sentry https://mcp.sentry.dev/mcp');
    expect(argv('droid', remote)).toBe('mcp add --type http sentry https://mcp.sentry.dev/mcp');
  });

  it('offers nothing for a harness with no recorded grammar', () => {
    // Never guessed: a wrong argv writes a broken entry.
    expect(mcpAddArgv(grammarOf('opencode'), local)).toBeUndefined();
    expect(mcpAddArgv(grammarOf('aider'), local)).toBeUndefined();
    // Kimi has no mcp subcommand at all; Hermes has one but it prompts.
    expect(mcpAddArgv(grammarOf('kimi'), local)).toBeUndefined();
    expect(mcpAddArgv(grammarOf('hermes'), local)).toBeUndefined();
  });

  it('knows a URL from an executable', () => {
    expect(isRemoteTarget('https://example.com/mcp')).toBe(true);
    expect(isRemoteTarget('npx')).toBe(false);
    expect(isRemoteTarget('/usr/local/bin/server')).toBe(false);
  });
});
