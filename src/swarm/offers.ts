/** The models a host may hand work to. Each line is a model id an account
 * with usage actually lists. The host passes that id and does not invent
 * one. Swarm runs it on the account that lists it and has the most usage left. */

import { lookupScore, type ModelScore, type ScoreCache, scoreKey } from './scores.js';

interface OfferRow {
  account: { id: string; models: readonly string[] };
  command: string;
  displayName: string;
  leftPct: number;
}

export interface SwarmSeat<T> {
  candidate: T;
  /** Passed to the harness. Absent when the account has no named model. */
  modelArg?: string;
}

export interface SwarmOffer<T = OfferRow> {
  /** What the host passes as `model`. */
  model: string;
  score?: ModelScore;
  seats: SwarmSeat<T>[];
}

function rank(score: ModelScore | undefined): number {
  if (!score) return 0;
  return Math.max(score.coding ?? 0, score.intelligence ?? 0, score.agentic ?? 0);
}

function cost(score: ModelScore | undefined): number {
  if (!score || (score.promptPerM === undefined && score.completionPerM === undefined)) return Number.POSITIVE_INFINITY;
  return (score.promptPerM ?? 0) + (score.completionPerM ?? 0);
}

/** Every model id this account lists. An account with usage but no models
 * adds nothing: the harness command is not a model the host can name. */
function linesFor(row: OfferRow, cache: ScoreCache | undefined): Array<{ model: string; modelArg?: string; score?: ModelScore }> {
  const seen = new Set<string>();
  return row.account.models.filter(Boolean).flatMap((model) => {
    if (seen.has(model)) return [];
    seen.add(model);
    const score = lookupScore(cache, model);
    return [{ model, modelArg: model, ...(score ? { score } : {}) }];
  });
}

/** One offer per model. Seats are the accounts that can run it, most usage first. */
export function swarmOffers<T extends OfferRow>(pool: readonly T[], cache?: ScoreCache): SwarmOffer<T>[] {
  const grouped = new Map<string, SwarmOffer<T>>();
  for (const row of pool) {
    for (const line of linesFor(row, cache)) {
      const offer = grouped.get(line.model) ?? { model: line.model, ...(line.score ? { score: line.score } : {}), seats: [] };
      offer.seats.push({ candidate: row, ...(line.modelArg ? { modelArg: line.modelArg } : {}) });
      if (!offer.score && line.score) offer.score = line.score;
      grouped.set(line.model, offer);
    }
  }
  const offers = [...grouped.values()];
  for (const offer of offers) offer.seats.sort((left, right) => right.candidate.leftPct - left.candidate.leftPct);
  return offers.sort(byStrength);
}

function byStrength<T extends OfferRow>(left: SwarmOffer<T>, right: SwarmOffer<T>): number {
  return rank(right.score) - rank(left.score) || cost(left.score) - cost(right.score) || (right.seats[0]?.candidate.leftPct ?? 0) - (left.seats[0]?.candidate.leftPct ?? 0) || left.model.localeCompare(right.model);
}

/** The paragraph the host reads on the tool. */
export function swarmChoiceNote(offers: readonly SwarmOffer[]): string {
  return `Pass one of these model ids exactly. They are the models on accounts that still have usage. Do not invent a model. Match the task to the index, and use a cheaper model when a lower index is enough. Prices are USD per million tokens, in then out. You get one subagent row and a short card, not that model's conversation.\n${formatSwarmOffers(offers)}`;
}

function money(amount: number): string {
  const text = amount >= 10 ? String(Math.round(amount)) : amount.toFixed(2).replace(/\.?0+$/, '');
  return `$${text}`;
}

function priceLabel(score: ModelScore | undefined): string {
  if (!score || (score.promptPerM === undefined && score.completionPerM === undefined)) return '';
  const inn = score.promptPerM !== undefined ? `${money(score.promptPerM)} in` : '';
  const out = score.completionPerM !== undefined ? `${money(score.completionPerM)} out` : '';
  return [inn, out].filter(Boolean).join(' / ');
}

export function formatSwarmOffers(offers: readonly SwarmOffer[]): string {
  if (!offers.length) return 'No other account has usage left.';
  return offers.map((offer) => {
    const seat = offer.seats[0];
    const usage = `${Math.round(seat?.candidate.leftPct ?? 0)}% left`;
    const scores = [
      offer.score?.coding !== undefined ? `coding ${offer.score.coding}` : '',
      offer.score?.intelligence !== undefined ? `intelligence ${offer.score.intelligence}` : '',
      priceLabel(offer.score),
    ].filter(Boolean).join(' · ');
    const name = offer.score ? offer.model : `${offer.model} · ${seat?.candidate.displayName ?? offer.model}`;
    return [name, scores, usage].filter(Boolean).join(' · ');
  }).join('\n');
}

export function matchSwarmOffer<T>(offers: readonly SwarmOffer<T>[], model: string): SwarmOffer<T> | undefined {
  const exact = offers.find((offer) => offer.model === model);
  if (exact) return exact;
  const key = scoreKey(model);
  const hits = offers.filter((offer) => scoreKey(offer.model) === key);
  return hits.length === 1 ? hits[0] : undefined;
}

/** The account that has this model and the most usage left, skipping one that is already working when another is free. */
export function seatFor<T extends OfferRow>(offer: SwarmOffer<T>, busy: ReadonlySet<string>): SwarmSeat<T> {
  return offer.seats.find((seat) => !busy.has(seat.candidate.account.id)) ?? offer.seats[0]!;
}
