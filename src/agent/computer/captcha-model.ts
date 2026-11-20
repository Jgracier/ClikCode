/** The questions the captcha solver puts to models. Every one goes to the account's own ClikDeploy Gateway (the
 * same connection `gateway login` made): pictures to its vision models, sound to its speech-to-text. No outside
 * solving service and no extra key; nothing but the puzzle's pixels or audio leaves this machine.
 *
 * One shape throughout: a small roster of models is asked the same question at once, each answer is parsed, and an
 * answer counts only when voters agree. Waiting stops as soon as enough of them do, so the slowest model never
 * holds a puzzle up. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { listedModel } from '../../gateway/model-names.js';
import type { ImageInput, ModelClient } from '../model-client.js';

// ── who is asked ────────────────────────────────────────────────────────────────────────────────────────────────

/** The kinds of question, each with the models that answered it best when measured on live challenges
 * (2026-11-14, hand-checked answers), best first. The first three the account's Gateway lists are asked; the
 * rest stand in when one of them cannot answer (a provider out of credit or overloaded). */
export const ROSTERS = {
  /** Is the outlined square part of the target? (reCAPTCHA grids, GeeTest example matching): many quick asks, the fast models first. */
  tile: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.3-codex'],
  /** Where should one click? (hCaptcha riddles, unknown challenge boxes) */
  click: ['gpt-6-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  /** Matching, ordering and choosing among options (GeeTest icons, hCaptcha drags, Arkose picks). */
  order: ['gpt-6-sol', 'gpt-6.1-terra', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  /** Reading distorted characters. */
  text: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-5.6-terra'],
} as const;
export type Roster = keyof typeof ROSTERS;
const VOTERS = 3;
const VISION_TTL_MS = 60_000;

/** The account's vision models, cached for a minute (the Gateway list itself is cached about as long). */
let cachedVision: { ids: string[]; at: number } | undefined;

/** What one solver run asked of the models: how many asks went to which model, how each voter sided with the
 * answer that was given, and the hard questions themselves (for the tally and the stored answer set). */
export interface AskMeter {
  asks: number;
  models: Record<string, number>;
  votes: Array<{ roster: Roster; model: string; withWinner: boolean }>;
  samples: Array<{ roster: Roster; text: string; images: ImageInput[]; answers: Record<string, string> }>;
}
export const newMeter = (): AskMeter => ({ asks: 0, models: {}, votes: [], samples: [] });

/** `order`: the roster's models in the order measured on this machine (captcha-log.ts voterOrder), when known.
 * `meter`: where to count the asks. The rest are seams for tests: fake voters, a fixed clock, a signal. */
export interface AskOptions { signal?: AbortSignal; modelClientsOf?: () => Promise<ModelClient[]>; /** Named voters, best first, in place of the roster (a seam for tests of who sits in and who stands in). */ voters?: () => Promise<Voter[]>; now?: () => number; meter?: AskMeter; order?: Partial<Record<Roster, readonly string[]>> }

/** The questions worth a subscription voter: one or two pictures, an answer that takes thought. */
const HARD: ReadonlySet<Roster> = new Set<Roster>(['click', 'order']);

async function gatewayClient(model: string): Promise<ModelClient> {
  const { gatewayConnection, gatewayModelClient } = await import('../models/for-session.js');
  const Conf = (await import('conf')).default;
  const { baseUrl, apiKey } = gatewayConnection(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
  // Each voter is named explicitly: `auto` can land on a text-only provider that refuses the picture.
  // On the subscriptions lane: captcha votes are internal work and never spend paid (unsubsidized) Gateway usage.
  return gatewayModelClient({ baseUrl, apiKey, vision: true, model, subscriptions: true });
}

export interface Voter { name: string; client: ModelClient }

/** Models that just failed (out of credit, overloaded) sit out for five minutes, so a vote is not held up -- or
 * left one voter short -- by a model that cannot answer right now. */
const benched = new Map<string, number>();
const BENCH_MS = 5 * 60_000;
/** A model declining the task in words (some decline anything that names a captcha) rather than answering it. */
const REFUSAL = /\bI(?:'m| am)? (?:cannot|can't|can not|won't|will not|am unable|am not able|unable|not able)\b|\bprohibited\b|\b(?:against|violates?) (?:my|the|our) (?:guidelines|polic(?:y|ies)|rules)\b/i;
/** Whether a model is sitting out right now (it failed or declined lately). */
export const isBenched = (name: string, now = Date.now()): boolean => (benched.get(name) ?? 0) > now;

/** No paid stand-ins: a voter is only ever a model the Gateway serves from a subscription (or its free tier). The paid stand-ins of
 * 2026-11-20 (gpt-4.1-mini, gpt-4o, gemini-2.5-flash, ...) spent unsubsidized usage; the owner's rule is that internal work never does. */
export const STAND_INS = [] as readonly string[];

/** Who may sit in a roster's vote, best first, as the Gateway lists them now: models measured on this machine first (in their measured
 * order), then the roster's own order, then the stand-ins. A roster name stands for whatever the Gateway lists under it now
 * (src/gateway/model-names.ts): its list renames families, and a name matched exactly silently dropped every Claude voter from the
 * rosters on 2026-11-17. The voter keeps the wanted name (for scores and benching); the client asks for the listed one. */
export function seatOrder(roster: Roster, vision: readonly string[], measured: readonly string[] = []): Array<{ name: string; id: string }> {
  const listed: readonly string[] = ROSTERS[roster];
  const wanted = [...measured.filter(name => listed.includes(name)), ...listed.filter(name => !measured.includes(name)), ...STAND_INS.filter(name => !listed.includes(name))];
  const seen = new Set<string>();
  const out: Array<{ name: string; id: string }> = [];
  for (const name of wanted) {
    const id = listedModel(name, vision);
    if (id && !seen.has(id)) { seen.add(id); out.push({ name, id }); }
  }
  return out;
}

/** The voters for a kind of question, best first: the roster's models the account has (those not sitting out
 * first), else its first vision model alone. The first three vote; the rest stand in for one that fails. */
async function votersFor(roster: Roster, options: AskOptions): Promise<Voter[]> {
  if (options.voters) return options.voters();
  if (options.modelClientsOf) return (await options.modelClientsOf()).map(client => ({ name: '', client }));
  const now = options.now ?? Date.now;
  if (!cachedVision || now() - cachedVision.at > VISION_TTL_MS) {
    const { gatewayModels } = await import('../../gateway/models.js');
    // Only what a subscription (or the free tier) serves: a paid model is never seated, whatever a roster names.
    cachedVision = { ids: (await gatewayModels()).models.filter(model => model.vision === true && (model.access === 'subscription' || model.access === 'free')).map(model => model.id), at: now() };
  }
  const vision = cachedVision.ids;
  const preferred = seatOrder(roster, vision, options.order?.[roster] ?? []);
  const fit = preferred.filter(model => (benched.get(model.name) ?? 0) <= now());
  const ordered = preferred.length ? [...fit, ...preferred.filter(model => !fit.includes(model))] : vision.slice(0, 1).map(id => ({ name: id, id }));
  const gateway = await Promise.all(ordered.map(async model => ({ name: model.name, client: await gatewayClient(model.id) })));
  // The user's own subscription votes third on a hard question (two Gateway voters agreeing still ends the vote
  // before it is waited for) and stands in last on reading text; it never takes the many yes/no asks of a grid.
  if (roster === 'tile') return gateway;
  const { subscriptionVoter } = await import('./captcha-subscription.js');
  const own = await subscriptionVoter(now).catch(quiet('agent/computer/captcha-model'));
  if (!own) return gateway;
  return HARD.has(roster) ? [...gateway.slice(0, VOTERS - 1), own, ...gateway.slice(VOTERS - 1)] : [...gateway, own];
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
interface Polled<T> { answers: Array<T | undefined>; voters: number; /** Who gave each answer. */ names: string[]; roster: Roster }

/** Put one question to the roster's voters. Returns each voter's parsed answer (undefined for one that failed or
 * said nothing usable) and how many voters there were; `undefined` when no voter could be reached. Never throws. */
async function poll<T>(question: Question<T>, options: AskOptions): Promise<Polled<T> | undefined> {
  let all: Voter[];
  try { all = await votersFor(question.roster, options); }
  catch (error) { quiet('agent/computer/captcha-model')(error instanceof Error ? error.message : String(error)); return undefined; }
  if (!all.length) return undefined;
  // Fakes handed in by a test all vote; otherwise three vote and the rest are spares.
  const voting = options.modelClientsOf ? all : all.slice(0, VOTERS);
  const spares = options.modelClientsOf ? [] : all.slice(VOTERS);
  const names = voting.map(voter => voter.name);
  // Voters still thinking when the vote is settled are told to stop: nobody waits for them or pays for the rest.
  const settled = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, settled.signal]) : settled.signal;
  const meter = options.meter;
  const sample = meter && question.roster !== 'tile' && meter.samples.length < 12 ? { roster: question.roster, text: question.text, images: question.images, answers: {} as Record<string, string> } : undefined;
  if (sample) meter!.samples.push(sample);
  const ask = async (voter: Voter, seat: number): Promise<T | undefined> => {
    names[seat] = voter.name;
    if (meter) { meter.asks++; meter.models[voter.name || 'test'] = (meter.models[voter.name || 'test'] ?? 0) + 1; }
    try {
      const result = await voter.client.step({
        system: question.system,
        items: [{ type: 'text', role: 'user', text: question.text, images: question.images }],
        tools: [], toolChoice: 'none', maxOutputTokens: question.maxOutputTokens ?? 800,
        signal,
        onTextDelta: () => undefined,
      });
      if (process.env.CLIKCODE_CAPTCHA_VOTES) console.error(`vote ${question.roster} ${voter.name}: ${JSON.stringify(result.text.slice(0, 160))}`);
      if (sample) sample.answers[voter.name || `voter-${seat + 1}`] = result.text.slice(0, 600);
      const answer = question.parse(result.text);
      if (answer !== undefined) return answer;
      // No usable answer: a refusal, or prose with no answer in it. That voter is not counted; the next model in the roster is asked in
      // its place (a vote of two that must match exactly is a far weaker check than three). A model that refused sits out for a while.
      if (REFUSAL.test(result.text) && voter.name) benched.set(voter.name, (options.now ?? Date.now)() + BENCH_MS);
      const spare = spares.shift();
      return spare ? ask(spare, seat) : undefined;
    } catch (error) {
      if (signal.aborted) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (process.env.CLIKCODE_CAPTCHA_VOTES) console.error(`vote ${question.roster} ${voter.name} failed: ${message.slice(0, 160)}`);
      quiet('agent/computer/captcha-model')(message);
      // A voter that cannot answer sits out for a while and the next model in the roster votes in its place.
      if (voter.name) benched.set(voter.name, (options.now ?? Date.now)() + BENCH_MS);
      const spare = spares.shift();
      return spare ? ask(spare, seat) : undefined;
    }
  };
  const enough = question.enough;
  const answers = await untilAgreed(voting.map(ask), got => voting.length > 1 && !!enough && enough(got));
  settled.abort();
  return { answers, voters: voting.length, names: [...names], roster: question.roster };
}

/** Note, for the answer that was given, which voters sided with it (the measure a roster is later ordered by). */
function credit<T>(polled: Polled<T>, options: AskOptions, sides: (answer: T) => boolean): void {
  const meter = options.meter;
  if (!meter) return;
  polled.answers.forEach((answer, seat) => {
    const model = polled.names[seat];
    if (answer !== undefined && model && meter.votes.length < 600) meter.votes.push({ roster: polled.roster, model, withWinner: sides(answer) });
  });
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
export interface TileQuestion { image: ImageInput; instruction: string; target: string; size: number;
  /** The widget said a matching square is still unselected ("Please select all matching images"): one voter seeing the target is
   * enough, and every voter is waited for. The majority missed that square last time, so the majority cannot be what decides. */
  lenient?: boolean }

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
  const enough = question.lenient ? (got: Array<boolean | undefined>) => got.includes(true) : (got: Array<boolean | undefined>) => sharedBy(got, 2);
  const polled = await poll({ roster: 'tile', system: 'You answer image-selection questions with one word: yes or no.', text: tileQuestionText(question), images: [question.image], parse: yesNo, maxOutputTokens: 300, enough }, options);
  if (!polled) return undefined;
  const votes = polled.answers.filter((v): v is boolean => v !== undefined);
  if (!votes.length) return undefined;
  const yes = question.lenient ? votes.includes(true) : votes.filter(Boolean).length * 2 > votes.length;
  credit(polled, options, answer => answer === yes);
  return yes;
}

/** Which squares of a grid show the same thing as an example picture (GeeTest's "select N images with" + a
 * sample)? The squares, numbered from 1 left to right then top to bottom, that at least two voters name -- the
 * `want` most-named of them. The whole grid is asked about at once: the squares are told apart by comparing them
 * with each other, which a square on its own does not allow. Undefined is no usable answer. */
export async function askSquaresLikeExample(example: ImageInput, grid: ImageInput, want: number, squares = 9, options: AskOptions = {}): Promise<number[] | undefined> {
  const parse = (answer: string): number[] | undefined => {
    const list = /"squares"\s*:\s*\[([^\]]*)\]/.exec(answer)?.[1];
    if (list === undefined) return undefined;
    return [...new Set(list.split(',').map(n => Number(n.trim())).filter(n => Number.isInteger(n) && n >= 1 && n <= squares))];
  };
  const text = `The first picture is an example. The second picture is a grid of ${squares} drawings, numbered 1 to ${squares} from left to right, then top to bottom. `
    + `Exactly ${want} of the drawings show${want === 1 ? 's' : ''} the same object as the example; it may be rotated, resized, recoloured or on another background. `
    + 'Compare the shapes and their parts carefully. Answer with JSON only: {"squares": [<number>, ...]}.';
  const polled = await poll({ roster: 'order', system: 'You match drawings to an example and reply with JSON only.', text, images: [example, grid], parse }, options);
  if (!polled) return undefined;
  const votes = new Map<number, number>();
  for (const answer of polled.answers) for (const square of answer ?? []) votes.set(square, (votes.get(square) ?? 0) + 1);
  const need = polled.voters > 1 ? 2 : 1;
  const picked = [...votes].filter(([, count]) => count >= need).sort((a, b) => b[1] - a[1]).slice(0, want).map(([square]) => square);
  if (picked.length) credit(polled, options, answer => picked.every(square => answer.includes(square)));
  return picked;
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
    + 'If it asks for several things, give a point for each one. Give the spots that are the answer; a begin, proceed or continue button counts when the instruction says to start or begin. Never a skip, refresh or close button. Give each point as fractions of the picture\'s width and height'
    + (frames.length > 1 ? ' (on the last frame)' : '') + '. Answer with JSON only: {"points": [{"x": 0.0-1.0, "y": 0.0-1.0}]}.';
  const polled = await poll({ roster: 'click', system: 'You locate answers to visual puzzles and reply with JSON only.', text, images: frames, parse: parsePoints, maxOutputTokens: 1500, enough: got => sameAnswer(got).length > 0 }, options);
  if (!polled || polled.answers.every(a => a === undefined)) return undefined;
  // One voter (an account with a single vision model): its answer stands.
  const spots = polled.voters === 1 ? (polled.answers[0] ?? []) : sameAnswer(polled.answers);
  if (spots.length) credit(polled, options, answer => sameAnswer([answer, spots]).length > 0);
  return spots;
}

/** The spots to click, in order, on a "select in this order" challenge: small example icons and a picture holding
 * a rough drawing of each. Undefined is no agreed answer. */
export async function askOrderedPoints(image: ImageInput, options: AskOptions = {}): Promise<Point[] | undefined> {
  const text = 'This is a "select in this order" puzzle. At the top right are small black icons, in order from left to right. The large picture below contains hand-drawn coloured outline drawings; '
    + 'each small icon matches exactly one drawing (the same object, drawn as a rough outline). For each small icon, in order, give the centre of its matching drawing as fractions of the whole image width and height. '
    + 'Answer with JSON only: {"points": [{"x": 0.0-1.0, "y": 0.0-1.0}]}, one point per icon.';
  const polled = await poll({ roster: 'order', system: 'You match icons to drawings and reply with JSON only.', text, images: [image], parse: parsePoints, maxOutputTokens: 1500, enough: got => !!agreedInOrder(got) }, options);
  if (!polled) return undefined;
  const inOrder = polled.voters === 1 ? polled.answers[0] : agreedInOrder(polled.answers);
  if (inOrder?.length) credit(polled, options, answer => !!agreedInOrder([answer, inOrder]));
  return inOrder;
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
  // A piece is part of the puzzle when two voters name it (one voter alone may have seen a stray mark). Dragging only some of the
  // pieces of a puzzle never completes it, so an answer counts only when every one of those pieces has an agreed move.
  const named = new Map<number, number>();
  for (const answer of answers) for (const n of new Set((answer ?? []).map(d => d.n))) named.set(n, (named.get(n) ?? 0) + 1);
  const wanted = [...named].filter(([, count]) => count >= 2).map(([n]) => n).sort((a, b) => a - b);
  const out: NumberedDrag[] = [];
  for (const n of wanted) {
    const given = answers.map(a => a?.find(d => d.n === n)).filter((d): d is NumberedDrag => !!d);
    const alike = (d: NumberedDrag, e: NumberedDrag) => near(d.to, e.to, radius) && near(d.from, e.from, radius);
    const anchor = given.find(d => given.filter(e => alike(d, e)).length >= 2);
    if (!anchor) return [];
    const close = given.filter(e => alike(anchor, e));
    out.push({ n, from: { x: mean(close.map(d => d.from.x)), y: mean(close.map(d => d.from.y)) }, to: { x: mean(close.map(d => d.to.x)), y: mean(close.map(d => d.to.y)) } });
  }
  return out;
}

/** Every piece to drag on a drag puzzle ("drag the segments to complete the line", "drag the item into the
 * pattern", a slider that fits a piece into its gap): piece by piece, where two voters agree. An empty list means
 * no agreement; undefined no usable answer. */
export async function askDrags(image: ImageInput, instruction: string, options: AskOptions = {}): Promise<NumberedDrag[] | undefined> {
  const text = `This puzzle's instruction is: "${instruction}". If it is answered by clicking or selecting rather than by dragging something, answer {"drags": []} and nothing else. Otherwise it is a drag puzzle. If numbered pieces form one continuous line (or complete picture) in number order, the pieces labelled "Move" are out of place and the others are already placed. `
    + 'For a slider, the one piece is the slider handle (number it 1) and it is dropped where the puzzle piece fits its gap. '
    + 'For each piece to move, give where to grab it (the centre of its numbered circle, or of the piece) and where that point should end up. Fractions of the whole image. '
    + 'Answer with JSON only: {"drags": [{"n": 2, "from": {"x": 0.0, "y": 0.0}, "to": {"x": 0.0, "y": 0.0}}]}.';
  const polled = await poll({ roster: 'order', system: 'You solve drag puzzles and reply with JSON only.', text, images: [image], parse: parseDrags, maxOutputTokens: 1500, enough: got => agreedDrags(got).length > 0 && got.filter(Boolean).length >= 2 }, options);
  if (!polled || polled.answers.every(a => a === undefined)) return undefined;
  const drags = polled.voters === 1 ? (polled.answers[0] ?? []) : agreedDrags(polled.answers);
  if (drags.length) credit(polled, options, answer => agreedDrags([answer, drags]).length === drags.length);
  return drags;
}

/** Which of several numbered pictures answers an instruction (Arkose's "use the arrows to pick the image that..."):
 * the majority's pick, numbered from 1 in the order given; a tie or no answer is undefined. */
export async function askPick(images: ImageInput[], instruction: string, options: AskOptions = {}): Promise<number | undefined> {
  const text = `These ${images.length} pictures are the options of one visual puzzle, numbered 1 to ${images.length} in the order given. The instruction is: "${instruction}". `
    + 'Which one option is the correct answer? Answer with JSON only: {"pick": <number>}.';
  const parse = (answer: string): number | undefined => { const pick = Number(/"pick"\s*:\s*(\d+)/.exec(answer)?.[1]); return Number.isInteger(pick) && pick >= 1 && pick <= images.length ? pick : undefined; };
  const polled = await poll({ roster: 'order', system: 'You choose the option that answers a visual puzzle and reply with JSON only.', text, images, parse, enough: got => sharedBy(got, 2) }, options);
  const pick = polled ? majority(polled.answers, polled.voters) : undefined;
  if (polled && pick !== undefined) credit(polled, options, answer => answer === pick);
  return pick;
}

export function parseCaptchaText(text: string): string | undefined {
  const found = /\{[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*\}/.exec(text);
  const value = found?.[1]?.replace(/\s+/g, '');
  return value && value.length <= 12 ? value : undefined;
}

/** The characters in a classic "type what you see" captcha picture, exactly as drawn (case kept, no spaces), or
 * undefined when it could not be read. The reading most voters agree on wins (a tie goes to the best-ranked
 * model): one model alone misreads a 7 as a 1 now and then. */
/** When no whole reading wins, the readings of the commonest length are voted on one character at a time: three
 * voters that each misread a different character still spell the right code between them. Undefined when fewer
 * than three readings share a length or some position has no majority. */
export function characterVote(readings: Array<string | undefined>): string | undefined {
  const byLength = new Map<number, string[]>();
  for (const reading of readings) if (reading) byLength.set(reading.length, [...(byLength.get(reading.length) ?? []), reading]);
  const same = [...byLength.values()].sort((a, b) => b.length - a.length)[0];
  if (!same || same.length < 3) return undefined;
  let out = '';
  for (let i = 0; i < same[0]!.length; i++) {
    const char = majority(same.map(reading => reading[i]!), same.length);
    if (char === undefined) return undefined;
    out += char;
  }
  return out;
}

export async function askCaptchaText(image: ImageInput, options: AskOptions = {}): Promise<string | undefined> {
  const polled = await poll({ roster: 'text', system: 'You read distorted text in pictures and reply with JSON only.', images: [image], parse: parseCaptchaText, enough: got => sharedBy(got, 2),
    text: 'This picture is a text captcha: distorted letters and digits on a noisy background. Read the characters exactly as drawn, keeping upper and lower case, ignoring lines and noise. '
      + 'If it shows a simple sum (like 3 + 4), give the result instead. Answer with JSON only: {"text": "..."}.' }, options);
  if (!polled) return undefined;
  const reading = majority(polled.answers, polled.voters) ?? characterVote(polled.answers) ?? polled.answers.find(answer => answer !== undefined);
  if (reading) credit(polled, options, answer => answer === reading);
  return reading;
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
