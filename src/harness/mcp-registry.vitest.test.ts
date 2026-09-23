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
  return (localHarnessCapabilityManifest(harness) as {
    managers?: { mcp?: { add?: { confirmStdin?: string } } };
  }).managers?.mcp?.add;
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

  it('takes a remote server for the harnesses that can only accept one', () => {
    // Verified against the real CLI: `opencode mcp add <name> --url <url>`
    // wrote {"type":"remote","url":...} into its own opencode.jsonc.
    expect(argv('opencode', remote)).toBe('mcp add sentry --url https://mcp.sentry.dev/mcp');
    expect(argv('kilo', remote)).toBe('mcp add sentry --url https://mcp.sentry.dev/mcp');
  });

  it('declines a LOCAL server for those same harnesses rather than half-writing one', () => {
    // They have no flag for a local command at all: an extra positional is
    // refused and they fall back to an interactive picker, which a headless
    // install cannot answer. The caller turns this into a stated reason.
    expect(mcpAddArgv(grammarOf('opencode'), local)).toBeUndefined();
    expect(mcpAddArgv(grammarOf('kilo'), local)).toBeUndefined();
  });

  it('states the transport for a LOCAL server where the CLI demands one', () => {
    // openhands makes --transport mandatory, so omitting it for stdio fails
    // outright. Verified on disk: this exact argv wrote
    // {command:"npx", args:["-y","figma-mcp"]} into its own mcp.json.
    expect(argv('openhands', local)).toBe('mcp add --transport stdio figma npx -y figma-mcp');
    expect(argv('openhands', remote)).toBe('mcp add --transport http sentry https://mcp.sentry.dev/mcp');
  });

  it('repeats the arg flag as --arg=VALUE where a bare value would be read as a flag', () => {
    // `--arg -y` makes Vibe's parser read -y as a flag of its own and fail
    // with "expected one argument" -- found by running it. --no-login rides
    // only on the remote form, which is the only one Vibe accepts it with.
    expect(argv('vibe', local)).toBe('mcp add figma --transport stdio --command npx --arg=-y --arg=figma-mcp');
    expect(argv('vibe', remote)).toBe('mcp add sentry --transport http --url https://mcp.sentry.dev/mcp --no-login');
  });

  it('puts even the NAME behind a flag, and args in a JSON list, where the CLI wants that', () => {
    // kiro-cli mcp add --name N --command C --args '["-y","x"]' | --url U.
    // A JSON list is unambiguous for arguments containing dashes, which is
    // why Kiro documents it alongside the repeated form. Read off its own
    // --help; NOT round-tripped to disk, because `mcp add` refuses to run at
    // all until the CLI is logged in -- and its login check comes BEFORE
    // argument validation, so even a bogus flag reports only "not logged in".
    // Safe to declare anyway: a wrong argv there fails LOUDLY rather than
    // writing nothing and reporting success, which is why hermes is excluded
    // and this is not.
    expect(argv('kiro', local)).toBe('mcp add --scope global --force --name figma --command npx --args ["-y","figma-mcp"]');
    expect(argv('kiro', remote)).toBe('mcp add --scope global --force --name sentry --url https://mcp.sentry.dev/mcp');
  });

  it('answers the prompt Hermes asks before saving', () => {
    // Hermes connects to the server first and asks "Save config anyway?
    // [y/N]" when that fails. With stdin ignored the prompt read EOF and took
    // No, which is why `mcp add` exited 0 having written nothing -- a server
    // reported installed that was absent. Verified with the real CLI: piping
    // y saves it, and `hermes mcp list` shows it (disabled, which is honest
    // for a server that would not connect). A reachable one never asks.
    expect(argv('hermes', local)).toBe('mcp add figma --command npx --args -y figma-mcp');
    expect(grammarOf('hermes')!.confirmStdin).toBe('y\n');
  });

  it('asks nothing of the harnesses that do not prompt', () => {
    for (const command of ['claude', 'codex', 'qwen', 'auggie', 'vibe']) {
      expect(grammarOf(command)?.confirmStdin, command).toBeUndefined();
    }
  });

  it('offers nothing for a harness with no recorded grammar', () => {
    // Never guessed: a wrong argv writes a broken entry.
    expect(mcpAddArgv(grammarOf('aider'), local)).toBeUndefined();
    // aider and pi have no MCP surface at all -- zero mentions in --help.
    expect(mcpAddArgv(grammarOf('pi'), local)).toBeUndefined();
  });

  it('knows a URL from an executable', () => {
    expect(isRemoteTarget('https://example.com/mcp')).toBe(true);
    expect(isRemoteTarget('npx')).toBe(false);
    expect(isRemoteTarget('/usr/local/bin/server')).toBe(false);
  });
});
