import * as orders from './orders.ts';

/** Revenue across many orders, in cents. */
export function revenue(all: orders.Order[]): number {
  return all.map(orders.calcTotal).reduce((sum, total) => sum + total, 0);
}

export function largestOrder(all: orders.Order[]): orders.Order | undefined {
  let best: orders.Order | undefined;
  for (const order of all) {
    if (!best || orders.calcTotal(order) > orders.calcTotal(best)) best = order;
  }
  return best;
}
