/** The models a host may hand work to. Each line is a model id an account
 * with usage actually lists. The host passes that id and does not invent
 * one. Swarm runs it on the account that lists it and has the most usage left. */

import { lookupScore, type ModelScore, type ScoreCache, scoreKey } from './scores.js';
import { vendorWindows } from '../harness/accounts/usage-reading.js';
import type { AiHarnessAccount } from '../harness/definition.js';

interface OfferRow {
  account: Pick<AiHarnessAccount, 'id' | 'models' | 'usage'>;
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
  // Copilot has no scriptable account model list. Its stored models come from
  // a public catalog, which includes ids the installed CLI rejects.
  if (row.command === 'copilot') return [];
  const cursorNamedSpent = row.command === 'cursor' && vendorWindows(row.account as AiHarnessAccount)
    .some((window) => window.advisory && /api/i.test(window.name) && window.usedPct >= 100);
  return row.account.models.flatMap((raw) => {
    const model = raw.trim();
    if (!model || !/^[a-z0-9][a-z0-9._:/\[\],=-]*$/i.test(model)) return [];
    // Some human `models` commands have section headers that the generic
    // catalog parser once stored as ids. They are not valid model choices.
    if (/^(?:Anthropic|OpenAI|Stealth)$/i.test(model)) return [];
    if (cursorNamedSpent && !/^(?:auto|default\[\])$/i.test(model)) return [];
    const identity = scoreKey(model.replace(/\[[^\]]*\]$/, ''));
    if (seen.has(identity)) return [];
    seen.add(identity);
    const score = lookupScore(cache, model.replace(/\[[^\]]*\]$/, ''));
    return [{ model, modelArg: model, ...(score ? { score } : {}) }];
  });
}

/** One offer per model. Seats are the accounts that can run it, most usage first. */
export function swarmOffers<T extends OfferRow>(pool: readonly T[], cache?: ScoreCache): SwarmOffer<T>[] {
  const grouped = new Map<string, SwarmOffer<T>>();
  for (const row of pool) {
    for (const line of linesFor(row, cache)) {
      const key = scoreKey(line.model.replace(/\[[^\]]*\]$/, ''));
      const offer = grouped.get(key) ?? { model: line.model, ...(line.score ? { score: line.score } : {}), seats: [] };
      offer.seats.push({ candidate: row, ...(line.modelArg ? { modelArg: line.modelArg } : {}) });
      if (!offer.score && line.score) offer.score = line.score;
      grouped.set(key, offer);
    }
  }
  const offers = [...grouped.values()];
  for (const offer of offers) offer.seats.sort((left, right) => right.candidate.leftPct - left.candidate.leftPct);
  return offers.sort(byStrength);
}

function byStrength<T extends OfferRow>(left: SwarmOffer<T>, right: SwarmOffer<T>): number {
  return rank(right.score) - rank(left.score) || cost(left.score) - cost(right.score) || (right.seats[0]?.candidate.leftPct ?? 0) - (left.seats[0]?.candidate.leftPct ?? 0) || left.model.localeCompare(right.model);
}

/** How many models the tool description shows. The rest stay available through model "list". */
const SHOWN_MODELS = 8;

/** The strongest models, plus the cheapest, so a routine task still has something to choose. */
export function shownSwarmOffers<T>(offers: readonly SwarmOffer<T>[]): SwarmOffer<T>[] {
  if (offers.length <= SHOWN_MODELS) return [...offers];
  const shown = new Set<string>();
  for (const offer of offers) {
    if (shown.size >= SHOWN_MODELS - 2) break;
    shown.add(offer.model);
  }
  const cheapest = [...offers].sort((left, right) => cost(left.score) - cost(right.score));
  for (const offer of cheapest) {
    if (shown.size >= SHOWN_MODELS) break;
    if (cost(offer.score) === Number.POSITIVE_INFINITY) continue;
    shown.add(offer.model);
  }
  for (const offer of offers) {
    if (shown.size >= SHOWN_MODELS) break;
    shown.add(offer.model);
  }
  return offers.filter((offer) => shown.has(offer.model));
}

/** The paragraph the host reads on the tool. A long catalog stays off this text. */
export function swarmChoiceNote(offers: readonly SwarmOffer[]): string {
  const shown = shownSwarmOffers(offers);
  const hidden = offers.length - shown.length;
  const more = hidden > 0 ? `\n${hidden} more. Pass model "list" to see every model.` : '';
  return `Pass one of these model ids exactly. They are the models on accounts that still have usage. Do not invent a model. Match the task to the index, and use a cheaper model when a lower index is enough. Prices are OpenRouter list rates in USD per million tokens, in then out; subscription charges may differ. You get one subagent row and a short card, not that model's conversation.\n${formatSwarmOffers(shown)}${more}`;
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

/** Exact id, or the same id once punctuation is ignored. A prefix or a typo does not match. */
export function matchSwarmOffer<T>(offers: readonly SwarmOffer<T>[], model: string): SwarmOffer<T> | undefined {
  const trimmed = model.trim().toLowerCase();
  const exact = offers.find((offer) => offer.model.toLowerCase() === trimmed);
  if (exact) return exact;
  const key = scoreKey(model);
  return offers.find((offer) => scoreKey(offer.model) === key);
}

/** The account that has this model and the most usage left, skipping one that is already working when another is free. */
export function seatFor<T extends OfferRow>(offer: SwarmOffer<T>, busy: ReadonlySet<string>): SwarmSeat<T> {
  return offer.seats.find((seat) => !busy.has(seat.candidate.account.id)) ?? offer.seats[0]!;
}
