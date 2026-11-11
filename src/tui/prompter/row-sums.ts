/** Rows of a conversation's messages, summed: a Fenwick tree over each message's row count, so the rows above or below any
 * message, and the message at any row, are found in O(log n) -- a scroll step costs the same in a chat of ten messages and one
 * of ten thousand. A count is replaced in place (an estimate by a measured count) in O(log n) too. */
export class RowSums {
  private readonly values: number[] = [];
  /** 1-based: tree[i] holds the sum of values (i - lowbit(i), i]. */
  private readonly tree: number[] = [0];

  get size(): number { return this.values.length; }

  clear(): void {
    this.values.length = 0;
    this.tree.length = 1;
  }

  /** Keep the first `size` values only. */
  truncate(size: number): void {
    if (size >= this.values.length) return;
    this.values.length = size;
    this.tree.length = size + 1;
  }

  push(value: number): void {
    const i = this.values.length + 1;
    this.values.push(value);
    const low = i - (i & -i);
    this.tree.push(value + this.before(i - 1) - this.before(low));
  }

  set(index: number, value: number): void {
    const delta = value - this.values[index]!;
    if (delta === 0) return;
    this.values[index] = value;
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i]! += delta;
  }

  /** The rows of values [0, index). */
  before(index: number): number {
    let sum = 0;
    for (let i = Math.min(index, this.values.length); i > 0; i -= i & -i) sum += this.tree[i]!;
    return sum;
  }

  /** The value whose rows contain `row` (counted from the first value's first row), and how many rows into it. The last value
   * when `row` is past the end; undefined when there are none. */
  at(row: number): { index: number; into: number } | undefined {
    const size = this.values.length;
    if (size === 0) return undefined;
    let pos = 0;
    let left = Math.max(0, row);
    let step = 1;
    while (step * 2 <= size) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= size && this.tree[next]! <= left) { pos = next; left -= this.tree[next]!; }
    }
    if (pos >= size) return { index: size - 1, into: left + this.values[size - 1]! };
    return { index: pos, into: left };
  }
}
