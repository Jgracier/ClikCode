/** Asking a vendor what an account has left, one probe per harness: its own
 * credential file, or its real API with the account's own token. */

import { spawnPortable as spawn, terminatePortable } from '../transport/spawn.js';
import { grokUsageReading } from './grok-usage.js';
import { ampUsageProbe, auggieUsageProbe, clineUsageReading, commandCodeUsageReading, copilotUsageReading, cursorUsageReading, kiloUsageProbe, kimiUsageReading, kiroUsageReading } from './cli-usage-probes.js';
import { captureNativeHarnessOutput } from '../transport/native/command.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { CLIKCODE_VERSION } from '../../version.js';
import type { NativeUsageProbe } from '../definition.js';
import type { HarnessSession } from '../../session/model.js';
import { UsageReading, UsageWindow, claudeRateLimitReading, claudeUsageCommandReading, usageReading, usageWindow, usageWindowName } from './usage-reading.js';

/** Claude Code's `/usage` probe: measured at ~3.8s (see
 * CLAUDE_USAGE_PROBE_ARGV), with room for a slow start. */
const NATIVE_USAGE_PROBE_TIMEOUT_MS = 20_000;

/** Per-harness live usage probe. Each vendor CLI exposes quota/cost through a different
 * surface (or none at all); adding a harness here is the only step needed to light up
 * its usage footer, everything else (caching, dispatch, rendering) is shared. */

/** The executable the catalog declares for a harness (`harness.binary`), never a
 * name assumed from the command: forks and renamed installs differ. */
function harnessBinary(command: string, fallback: string = command): string {
  try {
    return localHarnessForCommand(command)?.binary ?? fallback;
  } catch {
    // fail-open-ok: the catalog runtime is unavailable; the documented default binary name is the best remaining answer.
    return fallback;
  }
}

/** A probe that failed produced no value, so there is nothing here to go
 * stale -- this is a backoff on a failing call, not a cached reading. Without
 * it an offline or broken probe is re-run on every repaint, and for a harness
 * whose probe is a real turn that is expensive as well as useless. */
export const NATIVE_USAGE_FAILURE_TTL_MS = 60_000;

/** Usage is a percentage of a quota window, or it is nothing.
 *
 * OpenCode's probe used to return a token count and a dollar figure here
 * ("10K tok · $0.42"), which is a different quantity wearing the same label:
 * it says how much a conversation cost, not how much of an allowance is left.
 * Two harnesses reporting in two units cannot be compared in an account
 * picker, and a number that never approaches a limit cannot drive failover.
 * A harness that publishes no window publishes no usage.
 */
async function codexUsageReading(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<UsageReading | undefined> {
  const binary = harnessBinary('codex');
  const response = await new Promise<Record<string, unknown> | undefined>((resolveUsage) => {
    const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...environment },
    });
    let buffer = '';
    let settled = false;
    let initialized = false;
    const finish = (value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminatePortable(child);
      resolveUsage(value);
    };
    const send = (message: Record<string, unknown>): void => {
      if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: unknown };
          if (message.id === 1 && message.result && typeof message.result === 'object') {
            if (initialized) return;
            initialized = true;
            // The rate-limits read answers only after the initialize handshake has
            // settled; give the transport a moment before asking, and leave stdin
            // open so the response can come back.
            const ask = setTimeout(() => send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } }), 250);
            ask.unref();
          } else if (message.id === 2 && message.result && typeof message.result === 'object') {
            return finish(message.result as Record<string, unknown>);
          }
        } catch { /* Ignore logs and unrelated notifications. */ }
      }
    });
    child.once('error', () => finish());
    child.once('exit', () => finish());
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'clikcode', version: CLIKCODE_VERSION } } });
    send({ method: 'initialized', params: {} });
    const timer = setTimeout(() => finish(), 8_000);
    timer.unref();
  });
  return codexRateLimitsReading(response?.rateLimits);
}

/** Claude Code's quota, asked of Claude Code, for one specific account: its
 * own `/usage`, run in print mode. That is a local command -- no model call,
 * cost 0 and zero tokens, measured at ~3.8s -- so, unlike the one-token turn
 * this used to run, it may run on any refresh and the composer is not blank
 * until something asks. `--no-session-persistence`: a probe is not a chat.
 * `--strict-mcp-config` with no `--mcp-config`: start NO MCP server. Without
 * it every probe booted each configured server (8 node processes, ~650MB
 * transient on the user's setup) only to print a local command; measured in
 * a sandbox with one marker server, 4.0s -> 1.2s, same /usage text.
 * It runs under this account's own CLAUDE_CONFIG_DIR, so the figure is that
 * account's. Every turn then keeps it current from the rate-limit data the
 * turn itself carries (claudeStreamReading, or the ACP adapter's
 * `_claude/rateLimit`). */
export const CLAUDE_USAGE_PROBE_ARGV: readonly string[] = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];

async function claudeUsageReading(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<UsageReading | undefined> {
  const harness = localHarnessForCommand('claude');
  if (!harness) return undefined;
  try {
    const output = await captureNativeHarnessOutput(harness, CLAUDE_USAGE_PROBE_ARGV, environment, NATIVE_USAGE_PROBE_TIMEOUT_MS);
    const result = (JSON.parse(output) as { result?: unknown }).result;
    return typeof result === 'string' ? claudeUsageCommandReading(result) : undefined;
  } catch { return undefined; } // fail-open-ok: no figure beats a wrong one
}

/** Claude Code reports both quota windows on its own stream-json output, on
 * every turn (confirmed live):
 *
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
 *     "unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":...},
 *                       "seven_day":{"utilization":0.04,"resetsAt":...}}}}
 *
 * This is the only source for Claude Code's quota. It used to be a faster
 * second path beside an authenticated call to the vendor's own usage
 * endpoint; that call is gone, and not only on principle -- the endpoint is a
 * per-ACCOUNT budget, and several open chats polling it exhausted it between
 * them, which is what put "usage rate limited" in the status bar.
 * Utilization here is a 0..1 fraction, where the endpoint used 0..100. */
export function claudeStreamReading(lineText: string): UsageReading | undefined {
  if (!lineText.includes('rate_limit_event')) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(lineText); } catch {
    // fail-open-ok: one unparseable line on an optional decoration path. The
    // turn's own output is read elsewhere and is unaffected.
    return undefined;
  }
  const record = parsed as { type?: unknown; rate_limit_info?: unknown };
  if (record.type !== 'rate_limit_event') return undefined;
  return claudeRateLimitReading(record.rate_limit_info);
}

/** Codex pushes account/rateLimits/updated on its app-server connection during
 * a turn, unprompted (confirmed live). Reading it there replaces codexUsageProbe
 * spawning an ENTIRE SECOND `codex app-server` process -- handshake, a 250ms
 * settle, one request, teardown -- on every refresh, per account, per terminal.
 * usedPercent here is already a percent, unlike Claude's 0..1 fraction. */
export function codexRateLimitsReading(rateLimits: unknown): UsageReading | undefined {
  type Window = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown; resetsInSeconds?: unknown };
  const windows = rateLimits && typeof rateLimits === 'object' ? rateLimits as { primary?: Window; secondary?: Window } : undefined;
  const part = (window?: Window): UsageWindow | undefined => {
    if (typeof window?.usedPercent !== 'number' || typeof window.windowDurationMins !== 'number') return undefined;
    const resetsAt = window.resetsAt ?? (typeof window.resetsInSeconds === 'number' ? Date.now() + window.resetsInSeconds * 1000 : undefined);
    return usageWindow(usageWindowName(window.windowDurationMins), window.usedPercent, resetsAt);
  };
  return usageReading([part(windows?.primary), part(windows?.secondary)]);
}

type NativeUsageReadingProbe = (session: HarnessSession, environment: Readonly<Record<string, string>>) => Promise<UsageReading | undefined>;

/** A probe whose harness publishes only a balance label, no windows. */
const labelOnly = (probe: NativeUsageProbe): NativeUsageReadingProbe => async (session, environment) => {
  const label = await probe(session, environment);
  return label === undefined ? undefined : { windows: [], label };
};

export const NATIVE_USAGE_PROBES: Readonly<Partial<Record<string, NativeUsageReadingProbe>>> = {
  codex: codexUsageReading,
  claude: claudeUsageReading,
  auggie: labelOnly(auggieUsageProbe),
  // Free: an ACP extension call, not a turn (grok-usage.ts).
  grok: grokUsageReading,
  // Free reads of the harness's own usage surface (cli-usage-probes.ts).
  copilot: copilotUsageReading,
  kimi: kimiUsageReading,
  amp: labelOnly(ampUsageProbe),
  kilo: labelOnly(kiloUsageProbe),
  cline: clineUsageReading,
  cursor: cursorUsageReading,
  kiro: kiroUsageReading,
  command: commandCodeUsageReading,
};
