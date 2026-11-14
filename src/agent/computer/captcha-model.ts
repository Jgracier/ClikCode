/** The one-shot vision ask that answers a captcha puzzle: a picture of the challenge goes to
 * the account's own ClikDeploy Gateway model (the same OpenAI-compatible `/v1/chat/completions`
 * the agent loop uses), and only its answer comes back. No third-party solver service, no key to
 * keep: the connection is the one `gateway login` already made, and nothing but the puzzle's
 * pixels leave this machine. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { ImageInput, ModelClient } from '../model-client.js';

export const CAPTCHA_MODEL_PROMPT = [
  'You are shown a screenshot of one web human-verification challenge (reCAPTCHA or hCaptcha image tiles).',
  'Answer with JSON only, no other text.',
  'For an image grid: {"tiles": [numbers]} where each number is a tile index counting from 0 in reading order (left to right, top to bottom) whose picture matches the challenge instruction written above the grid. An empty list means no tile matches.',
  'If you cannot read the challenge at all: {"unreadable": true}.',
].join(' ');

export type CaptchaAnswer = { tiles: number[] } | { unreadable: true };

/** Why no answer came back; the caller reports it without retrying. */
export type CaptchaAskError = 'no-vision-model' | 'gateway-off' | 'no-answer' | 'bad-answer' | 'unreachable';
export type CaptchaAsk = { ok: true; answer: CaptchaAnswer } | { ok: false; error: CaptchaAskError };

/** The first model on the account's Gateway list that takes images. Cached for the same minute as the list itself. */
let cachedVision: { id?: string; at: number } | undefined;
const VISION_TTL_MS = 60_000;

/** A client factory seam so tests can supply a fake step(). */
export type ModelClientOf = () => Promise<ModelClient>;

async function gatewayModelClientOnce(): Promise<ModelClient> {
  const { gatewayConnection, gatewayModelClient } = await import('../models/for-session.js');
  const Conf = (await import('conf')).default;
  const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  const { baseUrl, apiKey } = gatewayConnection(config);
  return gatewayModelClient({ baseUrl, apiKey, vision: true });
}

function parseAnswer(text: string): CaptchaAsk {
  // The answer is JSON, possibly fenced by a chatty model.
  const found = /\{[^{}]*\}/s.exec(text);
  if (!found) return { ok: false, error: 'bad-answer' };
  try {
    const value = JSON.parse(found[0]) as { unreadable?: unknown; tiles?: unknown };
    if (value.unreadable === true) return { ok: true, answer: { unreadable: true } };
    if (Array.isArray(value.tiles)) {
      const tiles = (value.tiles as unknown[]).filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0);
      return { ok: true, answer: { tiles } };
    }
    return { ok: false, error: 'bad-answer' };
  } catch { return { ok: false, error: 'bad-answer' }; }
}

/** One ask: the puzzle picture plus the strict prompt, answered as JSON. Never throws. */
export async function askCaptchaModel(image: ImageInput, options: { signal?: AbortSignal; modelClientOf?: ModelClientOf; now?: () => number } = {}): Promise<CaptchaAsk> {
  const now = options.now ?? Date.now;
  let client: ModelClient;
  try {
    if (options.modelClientOf) client = await options.modelClientOf();
    else {
      if (!cachedVision || now() - cachedVision.at > VISION_TTL_MS) {
        const { gatewayModels } = await import('../../gateway/models.js');
        const list = await gatewayModels();
        const seen = list.models.find(model => model.vision === true)?.id;
        cachedVision = { ...(seen ? { id: seen } : {}), at: now() };
      }
      if (!cachedVision.id) return { ok: false, error: 'no-vision-model' };
      client = await gatewayModelClientOnce();
    }
  } catch (error) {
    quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    return { ok: false, error: 'gateway-off' };
  }
  try {
    const result = await client.step({
      system: CAPTCHA_MODEL_PROMPT,
      items: [{ type: 'text', role: 'user', text: 'Which tiles match? Answer as JSON.', images: [image] }],
      tools: [], toolChoice: 'none', maxOutputTokens: 200,
      ...(options.signal ? { signal: options.signal } : {}),
      onTextDelta: () => undefined,
    });
    if (!result.text.trim()) return { ok: false, error: 'no-answer' };
    return parseAnswer(result.text);
  } catch (error) {
    quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    return { ok: false, error: 'unreachable' };
  }
}
