/** The shapes a credential has on its own, wherever it appears: a vendor
 * prefix, a JWT, a PEM private key. One list, so what search masks
 * (search/secrets.ts) and what the log masks (runtime/redact.ts) cannot drift
 * apart -- each catching a key the other let through. Patterns, not entropy:
 * a 40-character git hash must stay readable. */
export const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // OpenAI, Anthropic, OpenRouter and most `sk-` style keys.
  /\b(?:sk|pk|rk)-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g,
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
