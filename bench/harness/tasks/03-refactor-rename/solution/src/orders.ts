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

export function lineCount(order: Order): number {
  return order.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function emptyOrder(id: string): Order {
  return { id, lines: [], discountPercent: 0, shippingCents: 0 };
}
