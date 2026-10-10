import { lineCount, type Order } from './orders.ts';
import { computeOrderTotal } from './pricing/total.ts';

export function invoiceText(order: Order): string {
  const rows = order.lines.map((line) => `${line.sku} x${line.quantity} @ ${line.unitCents}`);
  return [`Invoice ${order.id}`, ...rows, `Items: ${lineCount(order)}`, `Total: ${computeOrderTotal(order)}`].join('\n');
}
