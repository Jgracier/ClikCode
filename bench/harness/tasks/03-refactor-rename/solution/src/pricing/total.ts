import type { Order } from '../orders.ts';

/** The order's total in cents: lines, less the discount, plus shipping. */
export function computeOrderTotal(order: Order): number {
  const lines = order.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
  const discount = Math.round((lines * order.discountPercent) / 100);
  return lines - discount + order.shippingCents;
}
