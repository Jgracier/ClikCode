import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cart, calcTotal, emptyOrder, invoiceText, largestOrder, revenue } from '../src/index.ts';

const order = { id: 'o1', lines: [{ sku: 'a', unitCents: 1000, quantity: 2 }], discountPercent: 10, shippingCents: 500 };

test('calcTotal applies discount then shipping', () => {
  assert.equal(calcTotal(order), 2300);
});

test('empty order totals zero', () => {
  assert.equal(calcTotal(emptyOrder('e')), 0);
});

test('cart total', () => {
  const cart = new Cart('c');
  cart.add('a', 250, 2);
  cart.add('a', 250);
  assert.equal(cart.total(), 750);
});

test('invoice shows the total', () => {
  assert.match(invoiceText(order), /Total: 2300/);
});

test('revenue and largest order', () => {
  const small = { ...order, id: 'o2', lines: [{ sku: 'b', unitCents: 100, quantity: 1 }] };
  assert.equal(revenue([order, small]), 2300 + 590);
  assert.equal(largestOrder([small, order])?.id, 'o1');
});
