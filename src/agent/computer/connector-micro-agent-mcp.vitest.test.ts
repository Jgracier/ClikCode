import { describe, expect, it } from 'vitest';

describe('a connector answer too large to read at once', () => {
  const big = { spec: { id: 'adsense', http: { baseUrl: 'https://adsense.googleapis.com/v1.4' }, actions: Array.from({ length: 400 }, (_, i) => ({ event: `adsense.op-${i}`, run: { request: { method: 'GET', path: `/accounts/${i}` } }, description: 'x'.repeat(200) })) } };
  it('comes back as an outline naming every operation, and a part by JSON pointer', async () => {
    const { readable, MAX_TOOL_OUTPUT } = await import('./connector-micro-agent-mcp.js');
    const shown = readable(big);
    expect(shown.length).toBeLessThan(MAX_TOOL_OUTPUT);
    expect(shown).toContain('args.path');
    expect(shown).toContain('12: adsense.op-12 GET /accounts/12');
    expect(JSON.parse(readable(big, '/http'))).toEqual({ baseUrl: 'https://adsense.googleapis.com/v1.4' });
    expect(JSON.parse(readable(big, '/actions/7/run/request'))).toEqual({ method: 'GET', path: '/accounts/7' });
    expect(readable(big, '/nope')).toContain('Nothing at /nope');
    // A small answer is unchanged.
    expect(readable({ spec: { id: 'tiny' } })).toBe('{"spec":{"id":"tiny"}}');
  });
});
