import type * as orders from './orders.ts';
import { computeOrderTotal } from './pricing/total.ts';

/** Revenue across many orders, in cents. */
export function revenue(all: orders.Order[]): number {
  return all.map(computeOrderTotal).reduce((sum, total) => sum + total, 0);
}

export function largestOrder(all: orders.Order[]): orders.Order | undefined {
  let best: orders.Order | undefined;
  for (const order of all) {
    if (!best || computeOrderTotal(order) > computeOrderTotal(best)) best = order;
  }
  return best;
}
