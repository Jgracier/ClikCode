/** One MCP entry, spelled the way each harness demands.
 *
 * Four grammars exist, every one read off a real CLI. Getting this wrong
 * writes a server entry that looks installed and never connects, which is why
 * each case below is the literal argv the vendor's own --help documents.
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

  it('names every part with a flag where the CLI takes nothing positionally, pre-joining where wanted', () => {
    // auggie mcp add <name> [-c path] [--args "a b"] [-t http -u url].
    // Passing a list where a string is wanted registers only the first arg,
    // and the server then fails at connect time rather than at add time.
    expect(argv('auggie', local)).toBe('mcp add figma -c npx --args -y figma-mcp');
    expect(argv('auggie', remote)).toBe('mcp add sentry -t http -u https://mcp.sentry.dev/mcp');
  });

  it('carries a scope flag where the CLI would otherwise write into the cwd', () => {
    // cmdc defaults -s to "local", which is project-local -- wrong for a
    // server ClikCode installs once per account profile. Verified on disk:
    // the positional doubles as the stdio command and trailing args land as
    // args, giving {command: "npx", args: ["-y", "..."]}.
    expect(argv('command', local)).toBe('mcp add -s user figma npx -y figma-mcp');
    expect(argv('command', remote)).toBe('mcp add -s user -t http sentry https://mcp.sentry.dev/mcp');
  });

  it('reuses the plain positional shape for Qwen, which spells it identically to Claude', () => {
    expect(argv('qwen', local)).toBe('mcp add figma npx -y figma-mcp');
    expect(argv('qwen', remote)).toBe('mcp add -t http sentry https://mcp.sentry.dev/mcp');
  });

  it('leaves Cursor out, because it has every mcp subcommand except add', () => {
    // mcp login/list/list-tools/enable/disable, and no add: it reads servers
    // from .cursor/mcp.json and `enable` only approves one already written.
    // A guessed add would write nothing and report success.
    expect(mcpAddArgv(grammarOf('cursor'), local)).toBeUndefined();
  });

  it('offers nothing for a harness with no recorded grammar', () => {
    // Never guessed: a wrong argv writes a broken entry.
    expect(mcpAddArgv(grammarOf('opencode'), local)).toBeUndefined();
    expect(mcpAddArgv(grammarOf('aider'), local)).toBeUndefined();
    expect(mcpAddArgv(grammarOf('kimi'), local)).toBeUndefined();
    // Hermes DOES have `mcp add`, with a complete non-interactive flag set
    // (--url / --command / --args). It is still excluded, and measuring why
    // is the point: it connects to the server before saving and, when that
    // fails, asks "Save config anyway? [y/N]". Run with stdin closed it
    // EXITS 0 having written nothing -- so ClikCode would report a server
    // installed that is absent. A false success is worse than no support.
    expect(mcpAddArgv(grammarOf('hermes'), local)).toBeUndefined();
  });

  it('knows a URL from an executable', () => {
    expect(isRemoteTarget('https://example.com/mcp')).toBe(true);
    expect(isRemoteTarget('npx')).toBe(false);
    expect(isRemoteTarget('/usr/local/bin/server')).toBe(false);
  });
});
