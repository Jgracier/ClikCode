/** The models a host may hand work to. Each line is a model on an account
 * that still has usage. The host passes that model. Swarm runs it on the
 * account in the line that has the most usage left. */

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

/** The strongest models, plus a cheaper one when the account has it.
 * A routine task cannot be matched to a price the list never shows. */
function linesFor(row: OfferRow, cache: ScoreCache | undefined): Array<{ model: string; modelArg?: string; score?: ModelScore }> {
  const scored = row.account.models.filter(Boolean).flatMap((model) => {
    const score = lookupScore(cache, model);
    return score ? [{ model, modelArg: model, score }] : [];
  });
  scored.sort((left, right) => rank(right.score) - rank(left.score) || left.model.localeCompare(right.model));
  if (!scored.length) return [{ model: row.command }];
  const cheapest = [...scored].sort((left, right) => cost(left.score) - cost(right.score) || left.model.localeCompare(right.model))[0];
  const chosen = [scored[0]!];
  if (cheapest && cheapest !== scored[0] && cost(cheapest.score) < cost(scored[0]!.score)) chosen.push(cheapest);
  for (const line of scored) {
    if (chosen.length >= 3) break;
    if (!chosen.includes(line)) chosen.push(line);
  }
  return chosen;
}

/** One offer per model. Seats are the accounts that can run it, most usage first. */
export function swarmOffers<T extends OfferRow>(pool: readonly T[], cache?: ScoreCache): SwarmOffer<T>[] {
  const grouped = new Map<string, SwarmOffer<T>>();
  for (const row of pool) {
    for (const line of linesFor(row, cache)) {
      const key = scoreKey(line.model);
      const offer = grouped.get(key) ?? { model: line.model, ...(line.score ? { score: line.score } : {}), seats: [] };
      offer.seats.push({ candidate: row, ...(line.modelArg ? { modelArg: line.modelArg } : {}) });
      if (!offer.score && line.score) offer.score = line.score;
      grouped.set(key, offer);
    }
  }
  const offers = [...grouped.values()];
  for (const offer of offers) offer.seats.sort((left, right) => right.candidate.leftPct - left.candidate.leftPct);
  offers.sort(byStrength);
  return mixPrices(offers);
}

function byStrength<T extends OfferRow>(left: SwarmOffer<T>, right: SwarmOffer<T>): number {
  return rank(right.score) - rank(left.score) || (right.seats[0]?.candidate.leftPct ?? 0) - (left.seats[0]?.candidate.leftPct ?? 0) || left.model.localeCompare(right.model);
}

/** Twelve lines. The strongest stay, and so does a cheaper model that would
 * otherwise fall off the end. */
function mixPrices<T extends OfferRow>(offers: SwarmOffer<T>[]): SwarmOffer<T>[] {
  if (offers.length <= 12) return offers;
  const kept: SwarmOffer<T>[] = [];
  const seen = new Set<string>();
  const take = (offer: SwarmOffer<T>): void => {
    const key = scoreKey(offer.model);
    if (seen.has(key) || kept.length >= 12) return;
    seen.add(key);
    kept.push(offer);
  };
  const byRank = [...offers].sort(byStrength);
  const byPrice = [...offers].sort((left, right) => cost(left.score) - cost(right.score) || left.model.localeCompare(right.model));
  for (const offer of byRank.slice(0, 8)) take(offer);
  for (const offer of byPrice) take(offer);
  return kept.sort(byStrength);
}

/** The paragraph the host reads on the tool. */
export function swarmChoiceNote(offers: readonly SwarmOffer[]): string {
  return `Pass model from this list. Match the task to the index, and use a cheaper model when a lower index is enough. Prices are USD per million tokens, in then out. You get one subagent row and a short card, not that model's conversation.\n${formatSwarmOffers(offers)}`;
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
  const key = scoreKey(model);
  return offers.find((offer) => scoreKey(offer.model) === key);
}

/** The account that has this model and the most usage left, skipping one that is already working when another is free. */
export function seatFor<T extends OfferRow>(offer: SwarmOffer<T>, busy: ReadonlySet<string>): SwarmSeat<T> {
  return offer.seats.find((seat) => !busy.has(seat.candidate.account.id)) ?? offer.seats[0]!;
}
