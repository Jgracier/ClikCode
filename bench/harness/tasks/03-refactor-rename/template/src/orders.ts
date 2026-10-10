export interface OrderLine {
  sku: string;
  unitCents: number;
  quantity: number;
}

export interface Order {
  id: string;
  lines: OrderLine[];
  discountPercent: number;
  shippingCents: number;
}

/** The order's total in cents: lines, less the discount, plus shipping. */
export function calcTotal(order: Order): number {
  const lines = order.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
  const discount = Math.round((lines * order.discountPercent) / 100);
  return lines - discount + order.shippingCents;
}

export function lineCount(order: Order): number {
  return order.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function emptyOrder(id: string): Order {
  return { id, lines: [], discountPercent: 0, shippingCents: 0 };
}
