import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as index from '../src/index.ts';
import * as orders from '../src/orders.ts';
import { computeOrderTotal } from '../src/pricing/total.ts';

const order = { id: 'o1', lines: [{ sku: 'a', unitCents: 333, quantity: 3 }], discountPercent: 15, shippingCents: 99 };

test('hidden: moved and renamed', () => {
  assert.equal(computeOrderTotal(order), 999 - 150 + 99);
  assert.equal(index.computeOrderTotal, computeOrderTotal);
  assert.equal('calcTotal' in index, false);
  assert.equal('calcTotal' in orders, false);
  assert.equal('computeOrderTotal' in orders && orders.computeOrderTotal !== computeOrderTotal, false);
});

test('hidden: other exports kept', () => {
  for (const name of ['Cart', 'invoiceText', 'emptyOrder', 'lineCount', 'largestOrder', 'revenue']) {
    assert.equal(typeof (index as Record<string, unknown>)[name], 'function', name);
  }
  assert.equal(typeof orders.lineCount, 'function');
  assert.equal(typeof orders.emptyOrder, 'function');
});
