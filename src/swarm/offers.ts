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

function linesFor(row: OfferRow, cache: ScoreCache | undefined): Array<{ model: string; modelArg?: string; score?: ModelScore }> {
  const scored = row.account.models.filter(Boolean).flatMap((model) => {
    const score = lookupScore(cache, model);
    return score ? [{ model, modelArg: model, score }] : [];
  });
  scored.sort((left, right) => rank(right.score) - rank(left.score) || left.model.localeCompare(right.model));
  if (scored.length) return scored.slice(0, 2);
  return [{ model: row.command }];
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
  offers.sort((left, right) => rank(right.score) - rank(left.score) || (right.seats[0]?.candidate.leftPct ?? 0) - (left.seats[0]?.candidate.leftPct ?? 0) || left.model.localeCompare(right.model));
  return offers.slice(0, 12);
}

/** The paragraph the host reads on the tool. */
export function swarmChoiceNote(offers: readonly SwarmOffer[]): string {
  return `Pass model from this list. A harder task should use a higher coding or intelligence index. You get one subagent row and a short card, not that model's conversation.\n${formatSwarmOffers(offers)}`;
}

export function formatSwarmOffers(offers: readonly SwarmOffer[]): string {
  if (!offers.length) return 'No other account has usage left.';
  return offers.map((offer) => {
    const seat = offer.seats[0];
    const usage = `${Math.round(seat?.candidate.leftPct ?? 0)}% left`;
    const scores = [
      offer.score?.coding !== undefined ? `coding ${offer.score.coding}` : '',
      offer.score?.intelligence !== undefined ? `intelligence ${offer.score.intelligence}` : '',
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
