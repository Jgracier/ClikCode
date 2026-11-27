/** Parse OAuth CLI replies without granting consent or choosing a platform. */
/** RFC 9457 problem documents carry a URI-valued type, never an authorization result. */
const PROBLEM_TYPE = /^(?:https?:\/\/|about:blank$)/i;
const URL_KEYS = ['authorizationUrl', 'authorization_url', 'authorizeUrl', 'url'];

function jsonOf(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  try { return JSON.parse(text.slice(start)); } catch { return undefined; }
}

/** Whether the CLI printed an error document (problem+json, or `success: false` / `status: error`), whose URLs are not an answer. */
function isErrorDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.success === false || v.status === 'error' || (typeof v.type === 'string' && PROBLEM_TYPE.test(v.type)) || typeof v.error === 'string' || (typeof v.status === 'number' && v.status >= 400);
}

/** Why an authorization URL is not one to open, or undefined. It must be https (plain http only on this computer's loopback) and,
 * when it names a redirect_uri, send the answer to an origin the platform owns; a bare address from a line of CLI output must be
 * an OAuth request (client_id and redirect_uri) at all, so a docs or status link printed beside it is never taken for it. */
export function authorizationProblem(raw: string, ownsCallback: (url: URL) => boolean, options: { strict?: boolean } = {}): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return 'it is not an address'; }
  const loopback = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return `it is not https (${url.protocol}//${url.host})`;
  const redirect = url.searchParams.get('redirect_uri');
  if (options.strict && (!url.searchParams.get('client_id') || !redirect)) return `${url.host}${url.pathname} is not an OAuth authorization request (no client_id and redirect_uri)`;
  if (redirect) {
    let back: URL;
    try { back = new URL(redirect); } catch { return 'its redirect_uri is not an address'; }
    if (!ownsCallback(back)) return `it sends the authorization to ${back.host}, which is not the platform's callback`;
  }
  return undefined;
}

/** The authorization URL out of an OAuth CLI reply (JSON or a plain line). An error document
 * has none. From plain text only an https OAuth request whose redirect_uri the platform owns is taken. */
export function authorizationUrl(text: string, ownsCallback: (url: URL) => boolean): string | undefined {
  const json = jsonOf(text);
  if (json !== undefined) {
    if (isErrorDocument(json)) return undefined;
    const walk = (value: unknown): string | undefined => {
      if (value && typeof value === 'object' && !isErrorDocument(value)) {
        const record = value as Record<string, unknown>;
        for (const key of URL_KEYS) { const v = record[key]; if (typeof v === 'string' && /^https?:\/\//.test(v) && !authorizationProblem(v, ownsCallback)) return v; }
        for (const v of Object.values(record)) { const found = walk(v); if (found) return found; }
      }
      return undefined;
    };
    const found = walk(json);
    if (found) return found;
  }
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) { const url = m[0].replace(/[.,;)]+$/, ''); if (!authorizationProblem(url, ownsCallback, { strict: true })) return url; }
  return undefined;
}

/** Why the platform would not start the connection, in its own words: the error document's message (or detail), else the last lines printed. */
export function startFailure(text: string): string {
  const json = jsonOf(text) as Record<string, unknown> | undefined;
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.split('\n')[0]!.trim() : undefined);
  const said = json && typeof json === 'object' ? pick(json.message) ?? pick(json.detail) ?? pick(json.error) ?? pick(json.title) : undefined;
  return said ?? text.trim().split('\n').slice(-3).join(' ').slice(0, 200);
}

