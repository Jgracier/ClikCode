/** The questions the captcha solver puts to models. Every one goes to the account's own ClikDeploy Gateway (the
 * same connection `gateway login` made): pictures to its vision models, sound to its speech-to-text. No outside
 * solving service and no extra key; nothing but the puzzle's pixels or audio leaves this machine.
 *
 * One shape throughout: a small roster of models is asked the same question at once, each answer is parsed, and an
 * answer counts only when voters agree. Waiting stops as soon as enough of them do, so the slowest model never
 * holds a puzzle up. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { ImageInput, ModelClient } from '../model-client.js';

// ── who is asked ────────────────────────────────────────────────────────────────────────────────────────────────

/** The kinds of question, each with the models that answered it best when measured on live challenges
 * (2026-11-14, hand-checked answers), best first. Up to three that the account's Gateway lists are asked. */
export const ROSTERS = {
  /** Is the outlined square part of the target? (reCAPTCHA grids, GeeTest example matching) */
  tile: ['gpt-4.1-mini', 'gemini-3-flash', 'claude-sonnet-5-5', 'gemini-2.5-pro', 'qwen3-vl-235b-a22b'],
  /** Where should one click? (hCaptcha riddles, unknown challenge boxes) */
  click: ['gemini-3-flash', 'claude-sonnet-5-5', 'gpt-5.2', 'claude-opus-5-5'],
  /** Matching, ordering and choosing among options (GeeTest icons, hCaptcha drags, Arkose picks). */
  order: ['claude-sonnet-5-5', 'claude-opus-5-5', 'gemini-3-flash'],
  /** Reading distorted characters. */
  text: ['gemini-3-flash', 'gpt-4.1-mini', 'claude-sonnet-5-5', 'qwen3-vl-235b-a22b'],
} as const;
export type Roster = keyof typeof ROSTERS;
const VOTERS = 3;
const VISION_TTL_MS = 60_000;

/** The account's vision models, cached for a minute (the Gateway list itself is cached about as long). */
let cachedVision: { ids: string[]; at: number } | undefined;

/** Seams for tests: fake voters, a fixed clock, a signal. */
export interface AskOptions { signal?: AbortSignal; modelClientsOf?: () => Promise<ModelClient[]>; now?: () => number }

async function gatewayClient(model: string): Promise<ModelClient> {
  const { gatewayConnection, gatewayModelClient } = await import('../models/for-session.js');
  const Conf = (await import('conf')).default;
  const { baseUrl, apiKey } = gatewayConnection(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
  // Each voter is named explicitly: `auto` can land on a text-only provider that refuses the picture.
  return gatewayModelClient({ baseUrl, apiKey, vision: true, model });
}

/** The voters for a kind of question: the roster's models the account has, else its first vision model alone. */
async function votersFor(roster: Roster, options: AskOptions): Promise<ModelClient[]> {
  if (options.modelClientsOf) return options.modelClientsOf();
  const now = options.now ?? Date.now;
  if (!cachedVision || now() - cachedVision.at > VISION_TTL_MS) {
    const { gatewayModels } = await import('../../gateway/models.js');
    cachedVision = { ids: (await gatewayModels()).models.filter(model => model.vision === true).map(model => model.id), at: now() };
  }
  const vision = cachedVision.ids;
  const preferred = ROSTERS[roster].filter(name => vision.includes(name)).slice(0, VOTERS);
  return Promise.all((preferred.length ? preferred : vision.slice(0, 1)).map(gatewayClient));
}

// ── asking and agreeing ─────────────────────────────────────────────────────────────────────────────────────────

/** Run every voter, but stop waiting as soon as the answers in hand satisfy `agreed` (two voters matching is
 * enough: the third, slowest one is not waited for). Resolves with all answers once every voter is done otherwise. */
export async function untilAgreed<T>(asks: Array<Promise<T | undefined>>, agreed: (answers: Array<T | undefined>) => boolean): Promise<Array<T | undefined>> {
  const answers: Array<T | undefined> = asks.map(() => undefined);
  return new Promise(resolve => {
    let pending = asks.length, settled = false;
    if (!pending) resolve(answers);
    asks.forEach((ask, index) => {
      void ask.then(value => { answers[index] = value; }, () => undefined).then(() => {
        pending--;
        if (settled) return;
        if (pending === 0 || agreed(answers)) { settled = true; resolve([...answers]); }
      });
    });
  });
}

interface Question<T> { roster: Roster; system: string; text: string; images: ImageInput[]; parse: (text: string) => T | undefined; maxOutputTokens?: number;
  /** Enough answers are in: stop waiting for the rest. */ enough?: (answers: Array<T | undefined>) => boolean }

/** Put one question to the roster's voters. Returns each voter's parsed answer (undefined for one that failed or
 * said nothing usable) and how many voters there were; `undefined` when no voter could be reached. Never throws. */
async function poll<T>(question: Question<T>, options: AskOptions): Promise<{ answers: Array<T | undefined>; voters: number } | undefined> {
  let clients: ModelClient[];
  try { clients = await votersFor(question.roster, options); }
  catch (error) { quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error)); return undefined; }
  if (!clients.length) return undefined;
  const asks = clients.map(async client => {
    try {
      const result = await client.step({
        system: question.system,
        items: [{ type: 'text', role: 'user', text: question.text, images: question.images }],
        tools: [], toolChoice: 'none', maxOutputTokens: question.maxOutputTokens ?? 800,
        ...(options.signal ? { signal: options.signal } : {}),
        onTextDelta: () => undefined,
      });
      return question.parse(result.text);
    } catch (error) {
      quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  });
  const enough = question.enough;
  return { answers: await untilAgreed(asks, got => clients.length > 1 && !!enough && enough(got)), voters: clients.length };
}

/** The value most voters gave, or undefined on a tie for first place (unless there was only one voter). */
function majority<T>(answers: Array<T | undefined>, voters: number): T | undefined {
  const counts = new Map<T, number>();
  for (const answer of answers) if (answer !== undefined) counts.set(answer, (counts.get(answer) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return undefined;
  if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1] && voters > 1) return undefined;
  return ranked[0]![0];
}
const sharedBy = <T>(answers: Array<T | undefined>, count: number): boolean => { const seen = new Map<T, number>(); for (const a of answers) if (a !== undefined) { const n = (seen.get(a) ?? 0) + 1; if (n >= count) return true; seen.set(a, n); } return false; };

type Point = { x: number; y: number };
const near = (a: Point, b: Point, radius: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= radius;
const mean = (values: number[]): number => values.reduce((total, v) => total + v, 0) / values.length;
const inPicture = (p: unknown): p is Point => !!p && typeof (p as Point).x === 'number' && typeof (p as Point).y === 'number' && (p as Point).x >= 0 && (p as Point).x <= 1 && (p as Point).y >= 0 && (p as Point).y <= 1;

/** The points in a model's answer: {"points": [...]} or a single {"x","y"}; values outside 0..1 are dropped. */
export function parsePoints(text: string): Point[] | undefined {
  const list = /\{\s*"points"\s*:\s*\[[\s\S]*?\]\s*\}/.exec(text);
  try {
    if (list) {
      const points = (JSON.parse(list[0]) as { points?: unknown }).points;
      if (Array.isArray(points)) return (points as unknown[]).filter(inPicture).map(p => ({ x: p.x, y: p.y }));
    }
    const one = /\{[^{}]*"x"[^{}]*\}/.exec(text);
    if (one) { const p = JSON.parse(one[0]) as unknown; return inPicture(p) ? [{ x: p.x, y: p.y }] : []; }
  } catch { return undefined; }
  return undefined;
}

/** The whole answer two voters share: the same number of spots, each within `radius` of one of the other's.
 * A voter who adds or misses one spot does not count as agreeing -- for checks where one wrong click loses the
 * round and asking for another challenge is free. Empty when no two match. */
export function sameAnswer(answers: Array<Point[] | undefined>, radius = 0.08): Point[] {
  const given = answers.filter((a): a is Point[] => !!a && a.length > 0);
  for (let i = 0; i < given.length; i++) for (let j = i + 1; j < given.length; j++) {
    const a = given[i]!, b = given[j]!;
    if (a.length !== b.length) continue;
    const used = new Set<number>();
    const pairs = a.map(p => { const k = b.findIndex((q, index) => !used.has(index) && near(p, q, radius)); if (k >= 0) used.add(k); return k; });
    if (pairs.every(k => k >= 0)) return a.map((p, index) => ({ x: (p.x + b[pairs[index]!]!.x) / 2, y: (p.y + b[pairs[index]!]!.y) / 2 }));
  }
  return [];
}

/** Position by position, the point at least two voters agree on (within `radius`); undefined if any position
 * has no agreement or the voters disagree on how many there are. */
export function agreedInOrder(answers: Array<Point[] | undefined>, radius = 0.09): Point[] | undefined {
  const given = answers.filter((a): a is Point[] => !!a && a.length > 0);
  if (given.length < 2) return undefined;
  const lengths = new Map<number, number>();
  for (const a of given) lengths.set(a.length, (lengths.get(a.length) ?? 0) + 1);
  const count = [...lengths.entries()].sort((x, y) => y[1] - x[1])[0]![0];
  const same = given.filter(a => a.length === count);
  if (same.length < 2) return undefined;
  const out: Point[] = [];
  for (let i = 0; i < count; i++) {
    const points = same.map(a => a[i]!);
    const anchor = points.find(p => points.filter(q => near(p, q, radius)).length >= 2);
    if (!anchor) return undefined;
    const close = points.filter(q => near(anchor, q, radius));
    out.push({ x: mean(close.map(q => q.x)), y: mean(close.map(q => q.y)) });
  }
  return out;
}

// ── the questions ───────────────────────────────────────────────────────────────────────────────────────────────

/** One square asked about: the whole challenge with that square outlined in red, the task, and the grid size. */
export interface TileQuestion { image: ImageInput; instruction: string; target: string; size: number }

export function tileQuestionText(question: Pick<TileQuestion, 'instruction' | 'target' | 'size'>): string {
  const whole = question.size >= 4
    ? 'The squares together form one photo, so count the square if even a small part of it shows the object.'
    : 'Each square is a separate photo.';
  return `This is an image-selection test: "${question.instruction}". One square is outlined in red. Does the red-outlined square contain any part of ${question.target}? ${whole} Answer one word: yes or no.`;
}
const yesNo = (text: string): boolean | undefined => /\byes\b/i.test(text) ? true : /\bno\b/i.test(text) ? false : undefined;

/** Does the outlined square hold any part of the target? The majority of the voters that answered decides (a tie or
 * no answer at all is "no"). One square at a time, outlined in the whole picture, reads far better than asking for
 * a list of squares: the model sees the context and judges one place. */
export async function askTileMatch(question: TileQuestion, options: AskOptions = {}): Promise<boolean | undefined> {
  const polled = await poll({ roster: 'tile', system: 'You answer image-selection questions with one word: yes or no.', text: tileQuestionText(question), images: [question.image], parse: yesNo, maxOutputTokens: 300, enough: got => sharedBy(got, 2) }, options);
  if (!polled) return undefined;
  const votes = polled.answers.filter((v): v is boolean => v !== undefined);
  return votes.length ? votes.filter(Boolean).length * 2 > votes.length : undefined;
}

/** Does this square show the same thing as the example picture (GeeTest's "select the images with" + a sample)?
 * The share of yes votes (0..1), so the caller can take the best N; undefined is no answer at all. */
export async function askSameAsExample(example: ImageInput, tile: ImageInput, options: AskOptions = {}): Promise<number | undefined> {
  const polled = await poll({ roster: 'tile', system: 'You compare two pictures and answer with one word: yes or no.', maxOutputTokens: 300, images: [example, tile], parse: yesNo,
    text: 'The first picture is an example symbol. Does the second picture show the same symbol (same shape, ignoring size, rotation, colour and background)? Answer one word: yes or no.' }, options);
  const votes = polled?.answers.filter((v): v is boolean => v !== undefined) ?? [];
  return votes.length ? votes.filter(Boolean).length / votes.length : undefined;
}

/** Where to click on a free-form challenge ("click the icon that is different", "find all foods eaten hot"): the
 * spots, as fractions of the picture, when at least two voters give the same whole answer. A challenge about
 * motion ("the island the moving animal never visited") is sent as a short series of frames in order. An empty
 * list means the voters saw nothing to click or did not agree -- the caller asks for another challenge.
 * `undefined` is no usable answer at all. */
export async function askClickPoints(images: ImageInput | ImageInput[], instruction: string, options: AskOptions = {}): Promise<Point[] | undefined> {
  const frames = Array.isArray(images) ? images : [images];
  const series = frames.length > 1 ? `These ${frames.length} pictures are frames of the same puzzle taken half a second apart, in order; watch what moves. ` : '';
  const text = `${series}This is a visual puzzle. The instruction is: "${instruction}". Where should one click to answer it? `
    + 'If it asks for several things, give a point for each one. Give each point as fractions of the picture\'s width and height'
    + (frames.length > 1 ? ' (on the last frame)' : '') + '. Answer with JSON only: {"points": [{"x": 0.0-1.0, "y": 0.0-1.0}]}.';
  const polled = await poll({ roster: 'click', system: 'You locate answers to visual puzzles and reply with JSON only.', text, images: frames, parse: parsePoints, maxOutputTokens: 1500, enough: got => sameAnswer(got).length > 0 }, options);
  if (!polled || polled.answers.every(a => a === undefined)) return undefined;
  // One voter (an account with a single vision model): its answer stands.
  return polled.voters === 1 ? (polled.answers[0] ?? []) : sameAnswer(polled.answers);
}

/** The spots to click, in order, on a "select in this order" challenge: small example icons and a picture holding
 * a rough drawing of each. Undefined is no agreed answer. */
export async function askOrderedPoints(image: ImageInput, options: AskOptions = {}): Promise<Point[] | undefined> {
  const text = 'This is a "select in this order" puzzle. At the top right are small black icons, in order from left to right. The large picture below contains hand-drawn coloured outline drawings; '
    + 'each small icon matches exactly one drawing (the same object, drawn as a rough outline). For each small icon, in order, give the centre of its matching drawing as fractions of the whole image width and height. '
    + 'Answer with JSON only: {"points": [{"x": 0.0-1.0, "y": 0.0-1.0}]}, one point per icon.';
  const polled = await poll({ roster: 'order', system: 'You match icons to drawings and reply with JSON only.', text, images: [image], parse: parsePoints, maxOutputTokens: 1500, enough: got => !!agreedInOrder(got) }, options);
  if (!polled) return undefined;
  return polled.voters === 1 ? polled.answers[0] : agreedInOrder(polled.answers);
}

/** One piece to drag: its number, where to grab it and where to drop it (fractions of the picture). */
export type NumberedDrag = { n: number; from: Point; to: Point };

export function parseDrags(text: string): NumberedDrag[] | undefined {
  const found = /\{\s*"drags"\s*:\s*\[[\s\S]*\]\s*\}/.exec(text);
  if (!found) return undefined;
  try {
    const drags = (JSON.parse(found[0]) as { drags?: unknown }).drags;
    if (!Array.isArray(drags)) return undefined;
    return (drags as Array<{ n?: unknown; from?: unknown; to?: unknown }>).filter(d => typeof d.n === 'number' && inPicture(d.from) && inPicture(d.to))
      .map(d => ({ n: d.n as number, from: { x: (d.from as Point).x, y: (d.from as Point).y }, to: { x: (d.to as Point).x, y: (d.to as Point).y } }));
  } catch { return undefined; }
}

/** The drags at least two voters agree on, piece by piece (same number, grab and drop points within `radius`),
 * averaged, in number order. */
export function agreedDrags(answers: Array<NumberedDrag[] | undefined>, radius = 0.09): NumberedDrag[] {
  const numbers = [...new Set(answers.flatMap(a => (a ?? []).map(d => d.n)))].sort((a, b) => a - b);
  const out: NumberedDrag[] = [];
  for (const n of numbers) {
    const given = answers.map(a => a?.find(d => d.n === n)).filter((d): d is NumberedDrag => !!d);
    const alike = (d: NumberedDrag, e: NumberedDrag) => near(d.to, e.to, radius) && near(d.from, e.from, radius);
    const anchor = given.find(d => given.filter(e => alike(d, e)).length >= 2);
    if (!anchor) continue;
    const close = given.filter(e => alike(anchor, e));
    out.push({ n, from: { x: mean(close.map(d => d.from.x)), y: mean(close.map(d => d.from.y)) }, to: { x: mean(close.map(d => d.to.x)), y: mean(close.map(d => d.to.y)) } });
  }
  return out;
}

/** Every piece to drag on a drag puzzle ("drag the segments to complete the line", "drag the item into the
 * pattern", a slider that fits a piece into its gap): piece by piece, where two voters agree. An empty list means
 * no agreement; undefined no usable answer. */
export async function askDrags(image: ImageInput, instruction: string, options: AskOptions = {}): Promise<NumberedDrag[] | undefined> {
  const text = `This is a drag puzzle: "${instruction}". If numbered pieces form one continuous line (or complete picture) in number order, the pieces labelled "Move" are out of place and the others are already placed. `
    + 'For a slider, the one piece is the slider handle (number it 1) and it is dropped where the puzzle piece fits its gap. '
    + 'For each piece to move, give where to grab it (the centre of its numbered circle, or of the piece) and where that point should end up. Fractions of the whole image. '
    + 'Answer with JSON only: {"drags": [{"n": 2, "from": {"x": 0.0, "y": 0.0}, "to": {"x": 0.0, "y": 0.0}}]}.';
  const polled = await poll({ roster: 'order', system: 'You solve drag puzzles and reply with JSON only.', text, images: [image], parse: parseDrags, maxOutputTokens: 1500, enough: got => agreedDrags(got).length > 0 && got.filter(Boolean).length >= 2 }, options);
  if (!polled || polled.answers.every(a => a === undefined)) return undefined;
  return polled.voters === 1 ? (polled.answers[0] ?? []) : agreedDrags(polled.answers);
}

/** Which of several numbered pictures answers an instruction (Arkose's "use the arrows to pick the image that..."):
 * the majority's pick, numbered from 1 in the order given; a tie or no answer is undefined. */
export async function askPick(images: ImageInput[], instruction: string, options: AskOptions = {}): Promise<number | undefined> {
  const text = `These ${images.length} pictures are the options of one visual puzzle, numbered 1 to ${images.length} in the order given. The instruction is: "${instruction}". `
    + 'Which one option is the correct answer? Answer with JSON only: {"pick": <number>}.';
  const parse = (answer: string): number | undefined => { const pick = Number(/"pick"\s*:\s*(\d+)/.exec(answer)?.[1]); return Number.isInteger(pick) && pick >= 1 && pick <= images.length ? pick : undefined; };
  const polled = await poll({ roster: 'order', system: 'You choose the option that answers a visual puzzle and reply with JSON only.', text, images, parse, enough: got => sharedBy(got, 2) }, options);
  return polled ? majority(polled.answers, polled.voters) : undefined;
}

export function parseCaptchaText(text: string): string | undefined {
  const found = /\{[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*\}/.exec(text);
  const value = found?.[1]?.replace(/\s+/g, '');
  return value && value.length <= 12 ? value : undefined;
}

/** The characters in a classic "type what you see" captcha picture, exactly as drawn (case kept, no spaces), or
 * undefined when it could not be read. The reading most voters agree on wins (a tie goes to the best-ranked
 * model): one model alone misreads a 7 as a 1 now and then. */
export async function askCaptchaText(image: ImageInput, options: AskOptions = {}): Promise<string | undefined> {
  const polled = await poll({ roster: 'text', system: 'You read distorted text in pictures and reply with JSON only.', images: [image], parse: parseCaptchaText, enough: got => sharedBy(got, 2),
    text: 'This picture is a text captcha: distorted letters and digits on a noisy background. Read the characters exactly as drawn, keeping upper and lower case, ignoring lines and noise. '
      + 'If it shows a simple sum (like 3 + 4), give the result instead. Answer with JSON only: {"text": "..."}.' }, options);
  if (!polled) return undefined;
  return majority(polled.answers, polled.voters) ?? polled.answers.find(reading => reading !== undefined);
}

// ── listening ───────────────────────────────────────────────────────────────────────────────────────────────────

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

/** The digits in a spoken-number clip (Arkose's audio challenge), whether heard as "4 7 1" or "four seven one". */
export function spokenDigits(text: string): string {
  const words: Record<string, string> = { zero: '0', oh: '0', one: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9' };
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).map(word => /^\d+$/.test(word) ? word : words[word] ?? '').join('');
}
