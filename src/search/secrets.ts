/** Credentials taken out of anything search shows: a snippet, a block of a
 * conversation, a live step. A chat is full of pasted keys and tokens, and
 * what search returns goes to a model (and from a vendor agent, to its
 * vendor), so every string leaves through `maskSecrets`.
 *
 * Patterns, not entropy: a 40-character git hash is what a coding chat is
 * full of and must stay readable. Each pattern is a shape a credential has
 * on its own (a vendor prefix, a JWT, a PEM block), or a value that a
 * key-ish name assigns. */

const MASK = '[secret]';

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/** Shapes that are a credential wherever they appear. */
const STANDALONE: readonly RegExp[] = [
  // OpenAI, Anthropic, OpenRouter and most `sk-` style keys.
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens.
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  // Slack, Stripe, Google, AWS, Hugging Face, npm, GitLab.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  // A JWT: three base64url parts, the first an encoded `{"`.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

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
  let out = text.replace(PRIVATE_KEY, MASK);
  for (const pattern of STANDALONE) out = out.replace(pattern, MASK);
  out = out.replace(AUTH_SCHEME, (_match, scheme: string, gap: string) => `${scheme}${gap}${MASK}`);
  out = out.replace(ASSIGNED, (match, name: string, value: string) => {
    // Prose ("the token is…") and code identifiers (`token: tokenFor(x)`)
    // are not values. A credential has digits or mixed case and no call.
    if (NOT_A_VALUE.test(value) || value.includes('(') || !/\d/.test(value) || value.includes(MASK)) return match;
    return `${name}${MASK}`;
  });
  return out;
}
