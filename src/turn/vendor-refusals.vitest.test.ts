/** Every harness's own wording for a spent plan, a throttle and a lost
 * sign-in, read verbatim from the installed CLIs on 2026-09-30 (ACP
 * JSON-RPC message plus data, stderr, or result text, as each one sends it). A
 * spent plan moves the turn to another account, so each must land in its
 * class -- and a warning or an outage must not. */
import { describe, expect, it } from 'vitest';
import { classifyAccountFailure } from './failover.js';

const kind = (text: string) => classifyAccountFailure(new Error(text));

const QUOTA = [
  // Kiro (ACP, v2)
  'The monthly usage limit has been reached',
  'Kiro rate limit reached: Monthly request limit reached',
  // OpenCode / Kilo (ACP -32603 "Internal error: <msg>")
  'Internal error: Quota exceeded. Check your plan and billing details.',
  'Internal error: Free usage exceeded, subscribe to Go',
  'Internal error: FreeUsageLimitError',
  'Internal error: PROMOTION_MODEL_LIMIT_REACHED',
  // Amp (stream-json result.error)
  'Out of Credits Add credits to keep using Amp.',
  'No Usage Available Your included Megawatt usage is at its monthly limit, and no paid credits are available.',
  // Pi (errorMessage)
  'You have hit your ChatGPT usage limit (plus plan). Try again in ~12 min.',
  // Aider (stdout: the raw provider line wins over aider's own gloss)
  'litellm.RateLimitError: You exceeded your current quota, please check your plan and billing details.\nThe API provider has rate limited you. Try again later or check your quotas.',
  'Insufficient credits with the API provider. Please add credits.',
  // OpenClaw (assistant text)
  '⚠️ openai (gpt-5) returned a billing error — check your account for subscription or usage limits.',
  '⚠️ anthropic/claude request failed (provider billing issue, HTTP 402). Check anthropic billing and try again.',
  // Deep Agents (ACP data.details)
  "Internal error: Error code: 429 - {'error': {'code': 'insufficient_quota'}}",
  // Devin (ACP)
  'Quota exhausted.',
  "You've reached your monthly usage limit.",
  'monthly acu limit reached',
  'Your usage quota has been exhausted',
  'Usage paused: An admin paused usage on your account.',
  'Purchase on-demand usage or turn on auto-reload, or wait for your quota to reset.',
  // Junie (agent message text)
  'Junie: Insufficient account balance. All tokens in your account have been spent.',
  'JetBrains AI: The AI quota for this account has been used up.',
  // Cline (ACP -32603)
  'Internal error: insufficient_credits',
  'Internal error: Not enough credits to complete this request',
  'Cline Credits depleted',
  // Mistral Vibe (ACP -32603)
  'LLM backend error [mistral]\n  status: 402 Payment Required',
];

const THROTTLE = [
  'Too many requests have been sent recently, please wait and try again later',
  'Rate limit exceeded. Please wait a moment before trying again.',
  'Internal error: Rate Limited',
  '⚠️ The model request was rate-limited. Please try again in a few minutes.',
  'The model provider is rate-limiting requests. Try again in a moment.',
  'Conversation run failed for id=1: litellm.RateLimitError: RateLimitError: OpenAIException - slow down',
  'Rate limited: retry in 30s',
  'Rate limit exceeded for mistral (model: devstral).',
];

const AUTH = [
  'Authentication failed. Your credentials may be invalid or expired.',
  'Invalid or missing API key. Run \'amp login\' to authenticate.',
  'API key required. Please run `amp login` first.',
  'No Amp API key found. Run `amp login` first.',
  'No API key for provider: anthropic',
  'The API provider is not able to authenticate you. Check your API key.\nlitellm.AuthenticationError: Incorrect API key provided',
  'Internal error: Error code: 401 - {\'type\': \'authentication_error\'}',
  'No credentials are configured for provider "openai"',
  'No credentials found for provider \'anthropic\'. Please set the ANTHROPIC_API_KEY environment variable.',
  'Not signed in to ChatGPT. Run /auth to sign in.',
  'Your session is no longer authenticated. Run /login to re-authenticate.',
  'Devin needs authentication',
  'Authorization with the AI service failed.',
  'Token is invalid or expired. Logging out...',
  'Your connection with OpenHands Cloud has expired.',
  'Missing API key for mistral provider.',
  'Sign in to MiniMax to use Agent features. Run `mcode login`, then retry.',
  'Internal error: No Cline account auth token found',
  'Internal error: PAID_MODEL_AUTH_REQUIRED',
];

const INELIGIBLE = [
  'No active JetBrains AI subscription was found for this account.',
  'No profiles available. Your administrator has not granted you access to Kiro.',
];

// Not a refusal of this account: no switch, no sign-in.
const OTHER = [
  'Low Credit Balance Your Amp credit balance is low.',
  'Provider is overloaded',
  'Model Provider Overloaded Try again in a few seconds.',
  'Encountered unexpectedly high load when processing the request, please try again.',
  'Internal error',
  'Permission denied',
  'The run reached its cost limit',
];

describe('vendor refusals', () => {
  it.each(QUOTA)('spent plan: %s', (text) => expect(kind(text)).toBe('quota-exhausted'));
  it.each(THROTTLE)('throttled: %s', (text) => expect(kind(text)).toBe('temporarily-throttled'));
  it.each(AUTH)('sign-in: %s', (text) => expect(kind(text)).toBe('authentication-required'));
  it.each(INELIGIBLE)('not eligible: %s', (text) => expect(kind(text)).toBe('account-ineligible'));
  it.each(OTHER)('not a refusal: %s', (text) => expect(kind(text)).toBe('other'));
});
