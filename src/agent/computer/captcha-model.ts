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
  'The picture may be noisy or partially obscured on purpose: look past the noise and answer with the tiles that match.',
  'If the picture is truly unreadable: {"unreadable": true}.',
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

async function gatewayModelClientOnce(model?: string): Promise<ModelClient> {
  const { gatewayConnection, gatewayModelClient } = await import('../models/for-session.js');
  const Conf = (await import('conf')).default;
  const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  const { baseUrl, apiKey } = gatewayConnection(config);
  // The picked vision model is named explicitly: `auto` can land on a text-only provider that refuses the picture.
  return gatewayModelClient({ baseUrl, apiKey, vision: true, ...(model ? { model } : {}) });
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

/** Vision models that judge one outlined captcha square well, best first. Measured 2026-11-14 on live reCAPTCHA
 * grids with hand-checked answers: these matched every square on 3x3 and 4x4 grids, where others over- or
 * under-picked. Up to three that the account's Gateway lists are asked and vote; any vision model is the fallback. */
export const TILE_MODELS = ['gpt-4.1-mini', 'gemini-3-flash', 'claude-sonnet-5-5', 'gemini-2.5-pro', 'qwen3-vl-235b-a22b'];
const VOTERS = 3;
let cachedTileModels: { ids: string[]; at: number } | undefined;

async function tileModelIds(now: () => number): Promise<string[]> {
  if (cachedTileModels && now() - cachedTileModels.at <= VISION_TTL_MS) return cachedTileModels.ids;
  const { gatewayModels } = await import('../../gateway/models.js');
  const vision = (await gatewayModels()).models.filter(model => model.vision === true).map(model => model.id);
  const preferred = TILE_MODELS.filter(name => vision.includes(name)).slice(0, VOTERS);
  const ids = preferred.length ? preferred : vision.slice(0, 1);
  cachedTileModels = { ids, at: now() };
  return ids;
}

/** One square asked about: the whole challenge with that square outlined in red, the task, and the grid size. */
export interface TileQuestion { image: ImageInput; instruction: string; target: string; size: number }

export function tileQuestionText(question: Pick<TileQuestion, 'instruction' | 'target' | 'size'>): string {
  const whole = question.size >= 4
    ? 'The squares together form one photo, so count the square if even a small part of it shows the object.'
    : 'Each square is a separate photo.';
  return `This is an image-selection test: "${question.instruction}". One square is outlined in red. Does the red-outlined square contain any part of ${question.target}? ${whole} Answer one word: yes or no.`;
}

async function askOne(client: ModelClient, question: TileQuestion, signal?: AbortSignal): Promise<boolean | undefined> {
  try {
    const result = await client.step({
      system: 'You answer image-selection questions with one word: yes or no.',
      items: [{ type: 'text', role: 'user', text: tileQuestionText(question), images: [question.image] }],
      tools: [], toolChoice: 'none', maxOutputTokens: 300,
      ...(signal ? { signal } : {}),
      onTextDelta: () => undefined,
    });
    if (/\byes\b/i.test(result.text)) return true;
    if (/\bno\b/i.test(result.text)) return false;
    return undefined;
  } catch (error) {
    quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** Does the outlined square hold any part of the target? The picked models answer in parallel and the majority of
 * those that answered decides (a tie or no answer at all is "no"). One square at a time, outlined in the whole
 * picture, reads far better than asking for a list of indices: the model sees the context and judges one place.
 * `modelClientsOf` is the test seam. Never throws. */
export async function askTileMatch(question: TileQuestion, options: { signal?: AbortSignal; modelClientsOf?: () => Promise<ModelClient[]>; now?: () => number } = {}): Promise<boolean | undefined> {
  const now = options.now ?? Date.now;
  let clients: ModelClient[];
  try {
    clients = options.modelClientsOf ? await options.modelClientsOf() : await Promise.all((await tileModelIds(now)).map(id => gatewayModelClientOnce(id)));
  } catch (error) {
    quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  if (!clients.length) return undefined;
  const votes = (await Promise.all(clients.map(client => askOne(client, question, options.signal)))).filter((v): v is boolean => v !== undefined);
  if (!votes.length) return undefined;
  const yes = votes.filter(Boolean).length;
  return yes * 2 > votes.length;
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
      client = await gatewayModelClientOnce(cachedVision.id);
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
