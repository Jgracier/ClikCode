/** Money is kept as an integer number of cents everywhere. */

export interface LineItem {
  name: string;
  unitCents: number;
  quantity: number;
}

/** "$1,234.50" for 123450; negative amounts read "-$3.05". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}.${rest}`;
}

/** Sum of unitCents * quantity over every line. */
export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
}

/** Tax on a subtotal at a percentage rate, rounded half up to a whole cent. */
export function tax(subtotalCents: number, ratePercent: number): number {
  return Math.round((subtotalCents * ratePercent) / 100);
}
