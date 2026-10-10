import { calcTotal, emptyOrder, type Order } from './orders.ts';

export class Cart {
  private order: Order;

  constructor(id: string) {
    this.order = emptyOrder(id);
  }

  add(sku: string, unitCents: number, quantity = 1): void {
    const existing = this.order.lines.find((line) => line.sku === sku);
    if (existing) existing.quantity += quantity;
    else this.order.lines.push({ sku, unitCents, quantity });
  }

  setDiscount(percent: number): void {
    this.order.discountPercent = percent;
  }

  /** What the customer pays now (calcTotal of the current order). */
  total(): number {
    return calcTotal(this.order);
  }

  snapshot(): Order {
    return structuredClone(this.order);
  }
}
