/** Display only. The exact authorization URL must still be opened or copied. */
export function shortenLoginUrl(url: string, maxLength = 56): string {
  if (url.length <= maxLength) return url;
  let shown: string;
  try { const parsed = new URL(url); shown = `${parsed.origin}/…`; } catch { return `${url.slice(0, maxLength - 1)}…`; }
  return shown.length <= maxLength ? shown : `${shown.slice(0, maxLength - 1)}…`;
}

/** The port of a loopback OAuth callback, when the provider exposes one. */
export function loginCallbackPort(url: string): number | undefined {
  try {
    const auth = new URL(url);
    const redirect = auth.searchParams.get('redirect_uri') ?? auth.searchParams.get('redirect_url')
      ?? auth.searchParams.get('callback_url');
    const callback = redirect ? new URL(redirect) : auth;
    if (callback.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)) return undefined;
    const port = Number(callback.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch { return undefined; }
}

export function loginPortForwardHint(url: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const port = loginCallbackPort(url);
  if (!port) return undefined;
  return environment.CLIKDEPLOY_REMOTE_TERMINAL === '1'
    ? `Consent callback port ${port} · tap this link in ClikDeploy to forward automatically`
    : `Consent callback port ${port} · over SSH forward with ssh -L ${port}:127.0.0.1:${port} <host>`;
}

/** The names a CLI opens a browser through: a sign-in records what they were asked to open, a probe makes them do nothing. */
export const BROWSER_OPENERS = ['xdg-open', 'open', 'gio', 'sensible-browser', 'x-www-browser', 'www-browser'] as const;
