import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { pageEgress } from './egress.js';
import { fetchAsTab } from './tab-fetch.js';
import { documentView } from './document-text.js';

/** A tab whose Node-side request client must never be used when it is on an egress. */
function fakeTab(options: { egress?: string; cdp?: 'works' | 'fails'; inPage?: 'works' | 'fails'; contentType?: string; url?: string }) {
  const nodeRequest = vi.fn(async () => ({ ok: () => true, status: () => 200, headers: () => ({ 'content-type': 'text/plain' }), body: async () => Buffer.from('from home') }));
  const sent: string[] = [];
  const session = {
    send: vi.fn(async (method: string) => {
      sent.push(method);
      if (options.cdp === 'fails') throw new Error('no CDP here');
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1' } } };
      if (method === 'Network.loadNetworkResource') return { resource: { success: true, httpStatusCode: 200, stream: 'S1', headers: { 'Content-Type': 'text/plain' } } };
      if (method === 'IO.read') return { data: Buffer.from('through the egress').toString('base64'), base64Encoded: true, eof: true };
      return {};
    }),
    detach: vi.fn(async () => undefined),
  };
  const frame = {
    evaluate: vi.fn(async (fn: unknown, arg?: unknown) => {
      if (typeof fn === 'function' && arg && typeof arg === 'object' && 'url' in arg) {
        if (options.inPage === 'fails') throw new Error('blocked by CORS');
        return { status: 200, type: 'text/plain', data: Buffer.from('in the page').toString('base64'), large: false };
      }
      return options.contentType ?? 'text/plain';
    }),
  };
  const context = { request: { get: nodeRequest }, newCDPSession: vi.fn(async () => session) };
  const page = { context: () => context, mainFrame: () => frame, url: () => options.url ?? 'https://example.test/notes.txt', evaluate: frame.evaluate } as unknown as Page;
  if (options.egress) pageEgress.set(page, options.egress);
  return { page, nodeRequest, sent, frame };
}

describe('fetchAsTab', () => {
  it('uses the context request client for a tab on home', async () => {
    const { page, nodeRequest } = fakeTab({});
    const got = await fetchAsTab(page, 'https://example.test/a');
    expect(nodeRequest).toHaveBeenCalledOnce();
    expect(got.body.toString()).toBe('from home');
  });

  it('loads through Chrome for a tab on an egress, never from this process', async () => {
    const { page, nodeRequest, sent } = fakeTab({ egress: 'vps', cdp: 'works' });
    const got = await fetchAsTab(page, 'https://example.test/a');
    expect(got).toMatchObject({ ok: true, status: 200, contentType: 'text/plain' });
    expect(got.body.toString()).toBe('through the egress');
    expect(sent).toContain('Network.loadNetworkResource');
    expect(nodeRequest).not.toHaveBeenCalled();
  });

  it('falls back to a fetch in the page, then fails rather than leak', async () => {
    const inPage = fakeTab({ egress: 'vps', cdp: 'fails' });
    expect((await fetchAsTab(inPage.page, 'https://example.test/a')).body.toString()).toBe('in the page');
    expect(inPage.nodeRequest).not.toHaveBeenCalled();
    const neither = fakeTab({ egress: 'vps', cdp: 'fails', inPage: 'fails' });
    await expect(fetchAsTab(neither.page, 'https://example.test/a')).rejects.toThrow(/through its egress/);
    expect(neither.nodeRequest).not.toHaveBeenCalled();
  });
});

describe('a document tab on an egress', () => {
  it('is read again through the egress', async () => {
    const { page, nodeRequest } = fakeTab({ egress: 'vps', cdp: 'works', contentType: 'text/plain', url: 'https://example.test/egress-doc.txt' });
    const view = await documentView(page);
    expect(view).toContain('through the egress');
    expect(nodeRequest).not.toHaveBeenCalled();
  });
});
