/** Asking a vendor what an account has left, one probe per harness: its own
 * credential file, or its real API with the account's own token. */

import { spawnPortable as spawn, terminatePortable } from '../transport/spawn.js';
import { auggieUsageLabel } from '../auggie-usage.js';
import { captureNativeHarnessOutput } from '../transport/native.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { CLI_VERSION } from '../../cli/program.js';
import type { HarnessSession, NativeUsageProbe } from '../types.js';
import { UsageReading, UsageWindow, usageReading, usageWindow, usageWindowName } from './usage-reading.js';

/** The Claude probe runs a real (tiny) turn, so it waits on the model, not on
 * a local file: measured at ~1.7s to the rate_limit_event, with room for a
 * slow link. The other probes read locally and use a tighter 8s. */
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
export async function codexUsageProbe(session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  return (await codexUsageReading(session, environment))?.label;
}

export async function codexUsageReading(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<UsageReading | undefined> {
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
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'clikcode', version: CLI_VERSION } } });
    send({ method: 'initialized', params: {} });
    const timer = setTimeout(() => finish(), 8_000);
    timer.unref();
  });
  return codexRateLimitsReading(response?.rateLimits);
}

/** Claude Code's quota, asked of Claude Code, for one specific account.
 *
 * The CLI exposes no usage flag or subcommand (checked: `claude --help` lists
 * agents/attach/auth/auto-mode/doctor/gateway/import/install/logs/mcp/plugin
 * and nothing for usage). What it does do is report both windows on the turn
 * stream, so the probe is the smallest possible turn -- and because it runs
 * under this account's own CLAUDE_CONFIG_DIR, the figure is that account's,
 * not whichever one happens to own ~/.claude.
 *
 * Measured against the live CLI: `system` at +0.6s, `assistant` and
 * `rate_limit_event` together at +1.7s. The event lands after the model has
 * already answered, so stopping early saves nothing -- the child is killed
 * once the figure is in hand purely to avoid waiting on teardown.
 *
 * This costs a token round-trip to measure a token budget, which is why only
 * an explicit request runs it: opening the account picker, or `/usage`. Every
 * ordinary paint reads what the last real turn already reported.
 */
export async function claudeUsageProbe(session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  return (await claudeUsageReading(session, environment))?.label;
}

export async function claudeUsageReading(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<UsageReading | undefined> {
  const binary = harnessBinary('claude');
  return new Promise<UsageReading | undefined>((resolveUsage) => {
    const child = spawn(binary, ['-p', 'hi', '--verbose', '--output-format', 'stream-json'], {
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...environment },
    });
    let buffer = '';
    let settled = false;
    const finish = (value?: UsageReading): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminatePortable(child);
      resolveUsage(value);
    };
    const timer = setTimeout(() => finish(), NATIVE_USAGE_PROBE_TIMEOUT_MS);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const reading = claudeStreamReading(line);
        if (reading?.label) { finish(reading); return; }
        newline = buffer.indexOf('\n');
      }
    });
    // fail-open-ok: a probe that cannot run reports no figure. Usage is
    // decoration and must never block or fail a turn.
    child.once('error', () => finish());
    child.once('exit', () => finish());
  });
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
  const record = parsed as {
    type?: unknown;
    rate_limit_info?: { unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown; resets_at?: unknown } | undefined> };
  };
  if (record.type !== 'rate_limit_event') return undefined;
  const windows = record.rate_limit_info?.unifiedWindows;
  if (!windows) return undefined;
  const window = (name: string, value?: { utilization?: unknown; resetsAt?: unknown; resets_at?: unknown }): UsageWindow | undefined =>
    usageWindow(name, typeof value?.utilization === 'number' ? value.utilization * 100 : undefined, value?.resetsAt ?? value?.resets_at);
  return usageReading([window('5h', windows.five_hour), window('weekly', windows.seven_day)]);
}

export function claudeStreamUsage(lineText: string): string | undefined {
  return claudeStreamReading(lineText)?.label;
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

/** Label form, for callers that still pass a string to recordDerivedUsage. The
 * structured reading behind the label is remembered briefly so that path keeps
 * `usedPct`/`resetsAt` too; passing codexRateLimitsReading() directly is better. */
export const recentReadingByLabel = new Map<string, UsageReading>();

export function codexRateLimitsLabel(rateLimits: unknown): string | undefined {
  const reading = codexRateLimitsReading(rateLimits);
  if (reading?.label) {
    recentReadingByLabel.delete(reading.label);
    recentReadingByLabel.set(reading.label, reading);
    if (recentReadingByLabel.size > 8) recentReadingByLabel.delete(recentReadingByLabel.keys().next().value as string);
  }
  return reading?.label;
}

/** Auggie publishes an account balance; ClikCode reads it from the harness
 * rather than from Augment's API, the same rule every other usage source
 * follows here. */
export async function auggieUsageProbe(_session: HarnessSession, environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  const harness = localHarnessForCommand('auggie');
  if (!harness) return undefined;
  try {
    return auggieUsageLabel(await captureNativeHarnessOutput(harness, ['account', 'status', '--json'], environment, NATIVE_USAGE_PROBE_TIMEOUT_MS));
  } catch { return undefined; } // fail-open-ok: no figure beats a wrong one
}

export const NATIVE_USAGE_PROBES: Readonly<Partial<Record<string, NativeUsageProbe>>> = {
  codex: codexUsageProbe,
  claude: claudeUsageProbe,
  auggie: auggieUsageProbe,
};

export type NativeUsageReadingProbe = (session: HarnessSession, environment: Readonly<Record<string, string>>) => Promise<UsageReading | undefined>;

/** Structured probes for the harnesses whose label probe above is the built-in
 * one. A probe registered only in NATIVE_USAGE_PROBES still works; it simply
 * yields a label without windows. */
export const NATIVE_USAGE_READING_PROBES: Readonly<Partial<Record<string, { label: NativeUsageProbe; reading: NativeUsageReadingProbe }>>> = {
  codex: { label: codexUsageProbe, reading: codexUsageReading },
  claude: { label: claudeUsageProbe, reading: claudeUsageReading },
};
