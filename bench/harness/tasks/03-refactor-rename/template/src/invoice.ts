import { calcTotal, lineCount, type Order } from './orders.ts';

export function invoiceText(order: Order): string {
  const rows = order.lines.map((line) => `${line.sku} x${line.quantity} @ ${line.unitCents}`);
  return [`Invoice ${order.id}`, ...rows, `Items: ${lineCount(order)}`, `Total: ${calcTotal(order)}`].join('\n');
}
