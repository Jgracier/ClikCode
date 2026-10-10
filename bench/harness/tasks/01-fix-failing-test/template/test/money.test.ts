import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCents, subtotal, tax } from '../src/money.ts';

test('formats whole dollars', () => {
  assert.equal(formatCents(500), '$5.00');
});

test('formats cents below ten with a leading zero', () => {
  assert.equal(formatCents(305), '$3.05');
});

test('groups thousands', () => {
  assert.equal(formatCents(123450), '$1,234.50');
});

test('formats negative amounts', () => {
  assert.equal(formatCents(-305), '-$3.05');
});

test('subtotal multiplies by quantity', () => {
  assert.equal(subtotal([{ name: 'a', unitCents: 250, quantity: 2 }, { name: 'b', unitCents: 99, quantity: 1 }]), 599);
});

test('tax rounds to a whole cent', () => {
  assert.equal(tax(1999, 8.25), 165);
});
