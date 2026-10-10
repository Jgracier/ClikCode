import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCents } from '../src/money.ts';

test('hidden: zero', () => assert.equal(formatCents(0), '$0.00'));
test('hidden: one cent', () => assert.equal(formatCents(1), '$0.01'));
test('hidden: ten cents', () => assert.equal(formatCents(10), '$0.10'));
test('hidden: millions', () => assert.equal(formatCents(123456789), '$1,234,567.89'));
test('hidden: negative small', () => assert.equal(formatCents(-7), '-$0.07'));
