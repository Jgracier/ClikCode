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

/** Models that point well at a spot in a picture (measured 2026-11-14 on live hCaptcha click puzzles: these agreed
 * on the right spot where others missed). The first the account lists is asked. */
export const POINT_MODELS = ['gemini-3-flash', 'qwen3-vl-235b-a22b', 'gemini-2.5-pro'];
let cachedPointModel: { id?: string; at: number } | undefined;

/** Models that vote on where to click a free-form challenge. Measured 2026-11-14 on live hCaptcha riddles ("find
 * all foods normally eaten hot"): these named every right square; others missed or added some. */
export const CLICK_VOTERS = ['gemini-3-flash', 'claude-sonnet-5-5', 'gpt-5.2', 'claude-opus-5-5'];
let cachedClickModels: { ids: string[]; at: number } | undefined;

/** Points two or more voters agree on (within `radius` of each other, as fractions of the picture), averaged.
 * A single model's stray click is dropped. */
export function agreedPoints(answers: Array<Array<{ x: number; y: number }> | undefined>, radius = 0.08): Array<{ x: number; y: number }> {
  const groups: Array<{ voters: Set<number>; points: Array<{ x: number; y: number }> }> = [];
  answers.forEach((points, voter) => {
    for (const p of points ?? []) {
      const near = groups.find(g => g.points.some(q => Math.hypot(q.x - p.x, q.y - p.y) <= radius));
      if (near) { near.voters.add(voter); near.points.push(p); } else groups.push({ voters: new Set([voter]), points: [p] });
    }
  });
  return groups.filter(g => g.voters.size >= 2).map(g => ({ x: g.points.reduce((t, p) => t + p.x, 0) / g.points.length, y: g.points.reduce((t, p) => t + p.y, 0) / g.points.length }));
}

/** Where to click on a free-form challenge ("click the icon that is different", "find all foods eaten hot"): the
 * spots, as fractions of the picture, that at least two voting models agree on. A challenge about motion ("the
 * island the moving animal never visited") is sent as a short series of frames in order. An empty list means the
 * voters saw nothing to click or did not agree -- the caller asks for another challenge. `undefined` is no usable
 * answer at all. `modelClientsOf` is the test seam. Never throws. */
export async function askClickPoints(images: ImageInput | ImageInput[], instruction: string, options: { signal?: AbortSignal; modelClientsOf?: () => Promise<ModelClient[]>; now?: () => number } = {}): Promise<Array<{ x: number; y: number }> | undefined> {
  const now = options.now ?? Date.now;
  const frames = Array.isArray(images) ? images : [images];
  let clients: ModelClient[];
  try {
    if (options.modelClientsOf) clients = await options.modelClientsOf();
    else {
      if (!cachedClickModels || now() - cachedClickModels.at > VISION_TTL_MS) {
        const { gatewayModels } = await import('../../gateway/models.js');
        const vision = (await gatewayModels()).models.filter(model => model.vision === true).map(model => model.id);
        const ids = CLICK_VOTERS.filter(name => vision.includes(name)).slice(0, 3);
        cachedClickModels = { ids: ids.length ? ids : vision.slice(0, 1), at: now() };
      }
      clients = await Promise.all(cachedClickModels.ids.map(id => gatewayModelClientOnce(id)));
    }
  } catch (error) {
    quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  const series = frames.length > 1 ? `These ${frames.length} pictures are frames of the same puzzle taken half a second apart, in order; watch what moves. ` : '';
  const text = `${series}This is a visual puzzle. The instruction is: "${instruction}". Where should one click to answer it? `
    + 'If it asks for several things, give a point for each one. Give each point as fractions of the picture\'s width and height'
    + (frames.length > 1 ? ' (on the last frame)' : '') + '. Answer with JSON only: {"points": [{"x": 0.0-1.0, "y": 0.0-1.0}]}.';
  const answers = await Promise.all(clients.map(async client => {
    try {
      const result = await client.step({
        system: 'You locate answers to visual puzzles and reply with JSON only.',
        items: [{ type: 'text', role: 'user', text, images: frames }],
        tools: [], toolChoice: 'none', maxOutputTokens: 1500,
        ...(options.signal ? { signal: options.signal } : {}),
        onTextDelta: () => undefined,
      });
      return parsePoints(result.text);
    } catch (error) {
      quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }));
  if (answers.every(a => a === undefined)) return undefined;
  // One voter (an account with a single vision model): its answer stands.
  return clients.length === 1 ? (answers[0] ?? []) : agreedPoints(answers);
}

/** Does this square show the same thing as the example picture (GeeTest's "select the images with" + a sample)?
 * The tile-reading models vote; the share of yes votes (0..1) is returned so the caller can take the best N.
 * `modelClientsOf` is the test seam. Never throws; undefined is no answer at all. */
export async function askSameAsExample(example: ImageInput, tile: ImageInput, options: { signal?: AbortSignal; modelClientsOf?: () => Promise<ModelClient[]>; now?: () => number } = {}): Promise<number | undefined> {
  let clients: ModelClient[];
  try {
    clients = options.modelClientsOf ? await options.modelClientsOf() : await Promise.all((await tileModelIds(options.now ?? Date.now)).map(id => gatewayModelClientOnce(id)));
  } catch (error) {
    quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  const votes = (await Promise.all(clients.map(async client => {
    try {
      const result = await client.step({
        system: 'You compare two pictures and answer with one word: yes or no.',
        items: [{ type: 'text', role: 'user', text: 'The first picture is an example symbol. Does the second picture show the same symbol (same shape, ignoring size, rotation, colour and background)? Answer one word: yes or no.', images: [example, tile] }],
        tools: [], toolChoice: 'none', maxOutputTokens: 300,
        ...(options.signal ? { signal: options.signal } : {}),
        onTextDelta: () => undefined,
      });
      return /\byes\b/i.test(result.text) ? true : /\bno\b/i.test(result.text) ? false : undefined;
    } catch { return undefined; }
  }))).filter((v): v is boolean => v !== undefined);
  return votes.length ? votes.filter(Boolean).length / votes.length : undefined;
}

/** Models that match small icons to rough drawings of them, in order (measured 2026-11-14 on GeeTest's "select
 * in this order": each got all three right where four other models did not). */
export const ORDER_VOTERS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'gemini-3-flash'];
let cachedOrderModels: { ids: string[]; at: number } | undefined;

/** Position by position, the point at least two voters agree on (within `radius`); undefined if any position
 * has no agreement or the voters disagree on how many there are. */
export function agreedInOrder(answers: Array<Array<{ x: number; y: number }> | undefined>, radius = 0.09): Array<{ x: number; y: number }> | undefined {
  const given = answers.filter((a): a is Array<{ x: number; y: number }> => !!a && a.length > 0);
  if (given.length < 2) return undefined;
  const lengths = new Map<number, number>();
  for (const a of given) lengths.set(a.length, (lengths.get(a.length) ?? 0) + 1);
  const count = [...lengths.entries()].sort((x, y) => y[1] - x[1])[0]![0];
  const same = given.filter(a => a.length === count);
  if (same.length < 2) return undefined;
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    const points = same.map(a => a[i]!);
    const anchor = points.find(p => points.filter(q => Math.hypot(q.x - p.x, q.y - p.y) <= radius).length >= 2);
    if (!anchor) return undefined;
    const near = points.filter(q => Math.hypot(q.x - anchor.x, q.y - anchor.y) <= radius);
    out.push({ x: near.reduce((t, q) => t + q.x, 0) / near.length, y: near.reduce((t, q) => t + q.y, 0) / near.length });
  }
  return out;
}

/** The spots to click, in order, on a "select in this order" challenge: small example icons and a picture holding
 * a rough drawing of each. `modelClientsOf` is the test seam. Never throws; undefined is no agreed answer. */
export async function askOrderedPoints(image: ImageInput, options: { signal?: AbortSignal; modelClientsOf?: () => Promise<ModelClient[]>; now?: () => number } = {}): Promise<Array<{ x: number; y: number }> | undefined> {
  const now = options.now ?? Date.now;
  let clients: ModelClient[];
  try {
    if (options.modelClientsOf) clients = await options.modelClientsOf();
    else {
      if (!cachedOrderModels || now() - cachedOrderModels.at > VISION_TTL_MS) {
        const { gatewayModels } = await import('../../gateway/models.js');
        const vision = (await gatewayModels()).models.filter(model => model.vision === true).map(model => model.id);
        const ids = ORDER_VOTERS.filter(name => vision.includes(name));
        cachedOrderModels = { ids: ids.length ? ids : vision.slice(0, 1), at: now() };
      }
      clients = await Promise.all(cachedOrderModels.ids.map(id => gatewayModelClientOnce(id)));
    }
  } catch (error) {
    quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  const text = 'This is a "select in this order" puzzle. At the top right are small black icons, in order from left to right. The large picture below contains hand-drawn coloured outline drawings; '
    + 'each small icon matches exactly one drawing (the same object, drawn as a rough outline). For each small icon, in order, give the centre of its matching drawing as fractions of the whole image width and height. '
    + 'Answer with JSON only: {"points": [{"x": 0.0-1.0, "y": 0.0-1.0}]}, one point per icon.';
  const answers = await Promise.all(clients.map(async client => {
    try {
      const result = await client.step({
        system: 'You match icons to drawings and reply with JSON only.',
        items: [{ type: 'text', role: 'user', text, images: [image] }],
        tools: [], toolChoice: 'none', maxOutputTokens: 1500,
        ...(options.signal ? { signal: options.signal } : {}),
        onTextDelta: () => undefined,
      });
      return parsePoints(result.text);
    } catch { return undefined; }
  }));
  return clients.length === 1 ? answers[0] : agreedInOrder(answers);
}

/** The client for the pointing model, cached like the list: the model that answers "where" and "what does it say". */
async function pointClient(now: () => number, modelClientOf?: ModelClientOf): Promise<ModelClient | undefined> {
  if (modelClientOf) return modelClientOf();
  if (!cachedPointModel || now() - cachedPointModel.at > VISION_TTL_MS) {
    const { gatewayModels } = await import('../../gateway/models.js');
    const vision = (await gatewayModels()).models.filter(model => model.vision === true).map(model => model.id);
    const id = POINT_MODELS.find(name => vision.includes(name)) ?? vision[0];
    cachedPointModel = { ...(id ? { id } : {}), at: now() };
  }
  return cachedPointModel.id ? gatewayModelClientOnce(cachedPointModel.id) : undefined;
}

async function askText(image: ImageInput, system: string, text: string, options: { signal?: AbortSignal; modelClientOf?: ModelClientOf; now?: () => number }): Promise<string | undefined> {
  try {
    const client = await pointClient(options.now ?? Date.now, options.modelClientOf);
    if (!client) return undefined;
    const result = await client.step({
      system, items: [{ type: 'text', role: 'user', text, images: [image] }],
      tools: [], toolChoice: 'none', maxOutputTokens: 800,
      ...(options.signal ? { signal: options.signal } : {}),
      onTextDelta: () => undefined,
    });
    return result.text;
  } catch (error) {
    quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** Models that read distorted captcha text well; up to three the account lists read the picture in parallel. */
export const TEXT_MODELS = ['gemini-3-flash', 'gpt-4.1-mini', 'claude-sonnet-5-5', 'qwen3-vl-235b-a22b'];
let cachedTextModels: { ids: string[]; at: number } | undefined;

const TEXT_PROMPT = 'This picture is a text captcha: distorted letters and digits on a noisy background. Read the characters exactly as drawn, keeping upper and lower case, ignoring lines and noise. '
  + 'If it shows a simple sum (like 3 + 4), give the result instead. Answer with JSON only: {"text": "..."}.';

export function parseCaptchaText(text: string): string | undefined {
  const found = /\{[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*\}/.exec(text);
  const value = found?.[1]?.replace(/\s+/g, '');
  return value && value.length <= 12 ? value : undefined;
}

/** The characters in a classic "type what you see" captcha picture, exactly as drawn (case kept, no spaces), or
 * undefined when it could not be read. Several models read it at once and the reading most of them agree on wins
 * (a tie goes to the best-ranked model): one model alone misreads a 7 as a 1 now and then. `modelClientsOf` is the
 * test seam. Never throws. */
export async function askCaptchaText(image: ImageInput, options: { signal?: AbortSignal; modelClientsOf?: () => Promise<ModelClient[]>; now?: () => number } = {}): Promise<string | undefined> {
  const now = options.now ?? Date.now;
  let clients: ModelClient[];
  try {
    if (options.modelClientsOf) clients = await options.modelClientsOf();
    else {
      if (!cachedTextModels || now() - cachedTextModels.at > VISION_TTL_MS) {
        const { gatewayModels } = await import('../../gateway/models.js');
        const vision = (await gatewayModels()).models.filter(model => model.vision === true).map(model => model.id);
        const ids = TEXT_MODELS.filter(name => vision.includes(name)).slice(0, 3);
        cachedTextModels = { ids: ids.length ? ids : vision.slice(0, 1), at: now() };
      }
      clients = await Promise.all(cachedTextModels.ids.map(id => gatewayModelClientOnce(id)));
    }
  } catch (error) {
    quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  const readings = await Promise.all(clients.map(async client => {
    try {
      const result = await client.step({
        system: 'You read distorted text in pictures and reply with JSON only.',
        items: [{ type: 'text', role: 'user', text: TEXT_PROMPT, images: [image] }],
        tools: [], toolChoice: 'none', maxOutputTokens: 800,
        ...(options.signal ? { signal: options.signal } : {}),
        onTextDelta: () => undefined,
      });
      return parseCaptchaText(result.text);
    } catch (error) {
      quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }));
  const counts = new Map<string, number>();
  for (const reading of readings) if (reading) counts.set(reading, (counts.get(reading) ?? 0) + 1);
  let best: string | undefined, most = 0;
  for (const reading of readings) if (reading && (counts.get(reading) ?? 0) > most) { best = reading; most = counts.get(reading) ?? 0; }
  return best;
}

/** A drag answer: where to grab and where to let go, as fractions of the picture. */
export type DragAnswer = { from: { x: number; y: number }; to: { x: number; y: number } };

/** Where to drag on a drag puzzle ("drag the segment to complete the line", a slider that fits a piece into its gap).
 * Never throws; undefined is no usable answer. */
export async function askDrag(image: ImageInput, instruction: string, options: { signal?: AbortSignal; modelClientOf?: ModelClientOf; now?: () => number } = {}): Promise<DragAnswer | undefined> {
  const text = await askText(image, 'You solve drag puzzles and reply with JSON only.',
    `This picture is a drag puzzle. The instruction is: "${instruction}". Where should the piece be grabbed, and where should it be dropped to solve it? `
    + 'For a slider, grab the slider handle and drop it where the piece fits its gap. Give both points as fractions of the picture\'s width and height. '
    + 'Answer with JSON only: {"from": {"x": 0.0-1.0, "y": 0.0-1.0}, "to": {"x": 0.0-1.0, "y": 0.0-1.0}}.', options);
  return text ? parseDrag(text) : undefined;
}

export function parseDrag(text: string): DragAnswer | undefined {
  const found = /\{[\s\S]*"from"[\s\S]*"to"[\s\S]*\}/.exec(text);
  if (!found) return undefined;
  try {
    const value = JSON.parse(found[0].slice(0, found[0].lastIndexOf('}') + 1)) as { from?: { x?: unknown; y?: unknown }; to?: { x?: unknown; y?: unknown } };
    const ok = (p?: { x?: unknown; y?: unknown }): p is { x: number; y: number } => !!p && typeof p.x === 'number' && typeof p.y === 'number' && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
    return ok(value.from) && ok(value.to) ? { from: { x: value.from.x, y: value.from.y }, to: { x: value.to.x, y: value.to.y } } : undefined;
  } catch { return undefined; }
}

/** The points in a model's answer: {"points": [...]} or a single {"x","y"}; values outside 0..1 are dropped. */
export function parsePoints(text: string): Array<{ x: number; y: number }> | undefined {
  const inRange = (p: { x?: unknown; y?: unknown }): p is { x: number; y: number } => typeof p.x === 'number' && typeof p.y === 'number' && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  const list = /\{\s*"points"\s*:\s*\[[\s\S]*?\]\s*\}/.exec(text);
  try {
    if (list) {
      const points = (JSON.parse(list[0]) as { points?: unknown }).points;
      if (Array.isArray(points)) return (points as Array<{ x?: unknown; y?: unknown }>).filter(inRange).map(p => ({ x: p.x as number, y: p.y as number }));
    }
    const one = /\{[^{}]*"x"[^{}]*\}/.exec(text);
    if (one) { const p = JSON.parse(one[0]) as { x?: unknown; y?: unknown }; return inRange(p) ? [{ x: p.x as number, y: p.y as number }] : []; }
  } catch { return undefined; }
  return undefined;
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

/** Speech-to-text models on the Gateway, best first for short noisy clips of spoken words or digits. */
export const TRANSCRIBE_MODELS = ['whisper-large-v3', 'whisper-1', 'whisper-large-v3-turbo', 'gpt-4o-transcribe'];

/** The words spoken in an audio challenge clip, through the account's own Gateway (`/v1/audio/transcriptions`).
 * The first model that answers with text wins. `fetchImpl` and `connection` are the test seams. Never throws. */
export async function askTranscript(audio: Buffer, mimeType: string, options: { signal?: AbortSignal; fetchImpl?: typeof fetch; connection?: { baseUrl: string; apiKey: string } } = {}): Promise<string | undefined> {
  let connection = options.connection;
  try {
    if (!connection) {
      const { gatewayConnection } = await import('../models/for-session.js');
      const Conf = (await import('conf')).default;
      connection = gatewayConnection(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
    }
  } catch (error) {
    quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const name = /wav/i.test(mimeType) ? 'clip.wav' : /ogg/i.test(mimeType) ? 'clip.ogg' : 'clip.mp3';
  for (const model of TRANSCRIBE_MODELS) {
    try {
      const form = new FormData();
      form.append('model', model);
      form.append('language', 'en');
      form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), name);
      const response = await fetchImpl(`${connection.baseUrl}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${connection.apiKey}` }, body: form, signal: options.signal ?? AbortSignal.timeout(45_000) });
      if (!response.ok) continue;
      const text = String(((await response.json()) as { text?: unknown }).text ?? '').trim();
      if (text) return text;
    } catch (error) {
      quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
    }
  }
  return undefined;
}

/** What gets typed for an audio challenge: lower case, no punctuation, single spaces. */
export function cleanTranscript(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
}
