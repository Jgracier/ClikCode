import { describe, expect, it } from 'vitest';
import { describeCalls, jsonShape, safeUrl } from './network-capture.js';

describe('network capture helpers', () => {
  it('drops query values and keeps their names', () => {
    expect(safeUrl('https://api.x.test/v1/items?access_token=abc123&limit=5&limit=6')).toBe('https://api.x.test/v1/items?access_token=…&limit=…');
    expect(safeUrl('https://api.x.test/v1/items')).toBe('https://api.x.test/v1/items');
  });

  it('shows an answer\'s shape without its data', () => {
    expect(jsonShape({ data: [{ id: 'a1', name: 'x', owner: { email: 'e' } }], next: null, total: 3 })).toBe('{data: [{id: string, name: string, owner: {…}}], next: null, total: number}');
    expect(jsonShape([])).toBe('[]');
  });

  it('describes calls with header names only', () => {
    const text = describeCalls([{ method: 'GET', url: 'https://a.test/x', status: 200, type: 'fetch', requestHeaders: ['accept', 'authorization'], contentType: 'application/json', jsonShape: '{id: string}' }], 2);
    expect(text).toContain('1 API call (2 more not shown)');
    expect(text).toContain('GET https://a.test/x → 200 application/json');
    expect(text).toContain('header names: accept, authorization');
    expect(describeCalls([])).toContain('No API calls');
  });
});
