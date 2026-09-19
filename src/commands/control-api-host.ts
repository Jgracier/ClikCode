/**
 * Host-header allowlist for ClikCode's optional loopback control API.
 *
 * Binding to 127.0.0.1 does not stop DNS rebinding: a web page on
 * attacker.example can re-point its own hostname at 127.0.0.1 and have the
 * victim's browser issue same-origin requests to the control API. Those
 * requests still carry `Host: attacker.example:<port>`, so refusing every Host
 * that is not a literal loopback authority on OUR port closes the hole —
 * including for unauthenticated routes such as GET /v1/health.
 *
 * Pure and dependency-free so ai.ts can call it at the top of the request
 * handler and tests can cover it exhaustively.
 */

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * True only when `hostHeader` is exactly `127.0.0.1:<port>`, `localhost:<port>`
 * or `[::1]:<port>` (hostname case-insensitive). A missing header, a repeated
 * header, a missing/other/non-canonical port, userinfo, paths, whitespace,
 * trailing dots and any non-loopback name are all rejected.
 */
export function isAllowedLoopbackHost(hostHeader: string | readonly string[] | undefined | null, port: number): boolean {
  if (typeof hostHeader !== 'string') return false;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  // Anchored, no trimming: `[::1]` is matched as a bracketed literal so the
  // last-colon split below cannot be confused by IPv6 colons.
  const match = /^(\[[0-9a-fA-F:]+\]|[^:\[\]\s/@]+):([0-9]{1,5})$/.exec(hostHeader);
  if (!match) return false;
  const hostname = match[1]!.toLowerCase();
  const portText = match[2]!;
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  // Canonical decimal only: "08080" or "+80" must not alias the real port.
  return portText === String(port);
}
