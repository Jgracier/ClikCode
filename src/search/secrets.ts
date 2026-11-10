/** Credentials taken out of anything search shows: a snippet, a block of a
 * conversation, a live step. A chat is full of pasted keys and tokens, and
 * what search returns goes to a model (and from a vendor agent, to its
 * vendor), so every string leaves through `maskSecrets`.
 *
 * Patterns, not entropy: a 40-character git hash is what a coding chat is
 * full of and must stay readable. Each pattern is a shape a credential has
 * on its own (a vendor prefix, a JWT, a PEM block), or a value that a
 * key-ish name assigns. */

import { SECRET_SHAPES } from '../runtime/secret-shapes.js';

const MASK = '[secret]';

/** `Authorization: Bearer <token>`, `Basic <b64>`. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/g;

/** A value a key-ish name assigns: `API_KEY=…`, `"token": "…"`,
 * `X-Brain-Key: …`, `--password …`. The name stays, so the reader still
 * knows what was there. */
const ASSIGNED = /((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|auth|credential|private[_-]?key|[\w-]*-key)["']?\s*(?:[:=]|\s)\s*["']?)([^\s"'`,;)]{8,})/gi;

/** Words that follow a key-ish name and are not a value. */
const NOT_A_VALUE = /^(?:is|are|was|the|and|for|with|from|that|this|should|would|could|will|must|into|when|which|where|here|there|true|false|null|undefined|required|optional|string|number|boolean|object|missing|invalid|expired|present|provided|example|placeholder|refresh|header|value|field|file|path|name|type|env|environment|variable|\[secret\])$/i;

export function maskSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const pattern of SECRET_SHAPES) out = out.replace(pattern, MASK);
  out = out.replace(AUTH_SCHEME, (_match, scheme: string, gap: string) => `${scheme}${gap}${MASK}`);
  out = out.replace(ASSIGNED, (match, name: string, value: string) => {
    // Prose ("the token is…") and code identifiers (`token: tokenFor(x)`)
    // are not values. A credential has digits or mixed case and no call.
    if (NOT_A_VALUE.test(value) || value.includes('(') || !/\d/.test(value) || value.includes(MASK)) return match;
    return `${name}${MASK}`;
  });
  return out;
}
