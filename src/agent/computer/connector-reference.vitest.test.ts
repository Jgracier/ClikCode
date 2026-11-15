/** Finding a vendor's API reference with a browser: the rules, over a fake browser. */
import { describe, expect, it } from 'vitest';
import { docCandidates, embeddedReference, readsLikeApiDocs, referenceFileLinks, referenceKindOf, searchReference, worthReading, type ReferencePorts } from './connector-reference.js';
import { docsToSpecPrompt, referenceTask } from './connector-runner.js';

const openapi = JSON.stringify({ openapi: '3.0.1', info: { title: 'Acme' }, paths: { '/widgets': { get: {} }, '/widgets/{id}': { get: {} } } });
type Site = Record<string, { text?: string; links?: Array<[string, string]>; readme?: boolean; loaded?: Array<[string, string]> }>;
function browser(site: Site, files: Record<string, string> = {}): ReferencePorts & { opened: string[] } {
  let clock = 0;
  const opened: string[] = [];
  return {
    opened,
    now: () => (clock += 1_000),
    open: async url => {
      opened.push(url);
      const page = site[url.replace(/\/$/, '')];
      if (!page) return { url, ok: false, text: '', links: [], readme: false, loaded: [] };
      return { url, ok: true, text: page.text ?? '', links: (page.links ?? []).map(([href, text]) => ({ href, text })), readme: page.readme === true, loaded: (page.loaded ?? []).map(([u, text]) => ({ url: u, text })) };
    },
    fetch: async url => files[url],
  };
}

describe('what a file is', () => {
  it('takes only a document that says at its top that it is OpenAPI, Swagger or a Postman collection', () => {
    expect(referenceKindOf(openapi)).toBe('openapi');
    expect(referenceKindOf(JSON.stringify({ swagger: '2.0', paths: { '/a': {} } }))).toBe('swagger');
    expect(referenceKindOf(JSON.stringify({ info: { name: 'Acme', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'List' }] }))).toBe('postman');
    expect(referenceKindOf('openapi: "3.1.0"\ninfo:\n  title: Acme\npaths:\n  /widgets:\n    get: {}\n')).toBe('openapi');
    // No paths, a page of settings, or a file that only wraps a description: not a reference by itself.
    expect(referenceKindOf(JSON.stringify({ openapi: '3.0.0', paths: {} }))).toBeUndefined();
    expect(referenceKindOf(JSON.stringify({ data: { api: { schema: JSON.parse(openapi) } } }))).toBeUndefined();
    expect(referenceKindOf('{"theme": "dark"}')).toBeUndefined();
  });

  it('takes the description out of a docs platform\'s own page data, the one with the most paths', () => {
    const small = { openapi: '3.0.0', paths: { '/one': {} } };
    const wrapped = JSON.stringify({ data: { title: 'List widgets', api: { schema: small }, related: [{ oas: JSON.parse(openapi) }] } });
    expect(Object.keys(JSON.parse(embeddedReference(wrapped)!).paths)).toEqual(['/widgets', '/widgets/{id}']);
    expect(embeddedReference('{"data": {"title": "Pricing"}}')).toBeUndefined();
    expect(embeddedReference('not json "openapi": "3 "paths":')).toBeUndefined();
  });

  it('reads data files and skips pictures, styles and scripts', () => {
    expect(worthReading('https://docs.acme.com/api/openapi.json', 'application/json')).toBe(true);
    expect(worthReading('https://docs.acme.com/spec', 'text/plain')).toBe(true);
    expect(worthReading('https://docs.acme.com/app.js', 'application/javascript')).toBe(false);
    expect(worthReading('https://docs.acme.com/logo.png', 'image/png')).toBe(false);
  });
});

describe('where to look', () => {
  it('puts the documentation links the homepage shows first, then the usual developer addresses, and stays on the vendor\'s own sites', () => {
    const found = docCandidates('https://www.acme.com/', [
      { href: 'https://www.acme.com/pricing', text: 'Pricing' }, { href: 'https://developers.acme.com/', text: 'Developers' },
      { href: 'https://github.com/acme', text: 'API' }, { href: 'https://www.acme.com/blog/api-launch', text: 'API launch' }, { href: 'https://acme.readme.io/docs', text: 'Docs' },
    ]);
    expect(found.slice(0, 2).sort()).toEqual(['https://acme.readme.io/docs', 'https://developers.acme.com/']);
    expect(found).toContain('https://docs.acme.com/');
    expect(found.some(url => /github|pricing|blog/.test(url))).toBe(false);
  });

  it('knows a link that names a reference file, and a page that documents endpoints in words', () => {
    expect(referenceFileLinks([{ href: 'https://api.acme.com/v2/openapi.yaml', text: 'spec' }, { href: 'https://acme.com/files/collection', text: 'Download Postman collection' }, { href: 'https://acme.com/about', text: 'About' }])).toEqual(['https://api.acme.com/v2/openapi.yaml', 'https://acme.com/files/collection']);
    expect(readsLikeApiDocs('List widgets\nGET /v1/widgets\nCreate\nPOST /v1/widgets\nDelete\nDELETE /v1/widgets/{id}')).toBe(true);
    expect(readsLikeApiDocs('Our platform helps teams get more done. Post updates and delete clutter.')).toBe(false);
  });
});

describe('the search', () => {
  it('finds the description a documentation page loads after it opens', async () => {
    const ports = browser({
      'https://acme.com': { links: [['https://docs.acme.com/', 'API docs']] },
      'https://docs.acme.com': { text: 'Acme API', loaded: [['https://docs.acme.com/assets/theme.json', '{"theme":"dark"}'], ['https://docs.acme.com/_spec/v1.json', openapi]] },
    });
    const found = await searchReference('https://acme.com/', ports);
    expect(found.reference).toMatchObject({ url: 'https://docs.acme.com/_spec/v1.json', kind: 'openapi' });
    expect(ports.opened).toEqual(['https://acme.com/', 'https://docs.acme.com/']);
  });

  it('asks a ReadMe site for the whole API when a page carries only its own endpoint', async () => {
    const one = JSON.stringify({ data: { api: { schema: { openapi: '3.0.0', paths: { '/widgets': {} } } } } });
    const all = JSON.stringify({ data: { api: { schema: JSON.parse(openapi) } } });
    const ports = browser({
      'https://acme.com': { links: [['https://docs.acme.com/reference/introduction', 'API reference']] },
      'https://docs.acme.com/reference/introduction': { readme: true, links: [['https://docs.acme.com/reference/authentication', 'Authentication'], ['https://docs.acme.com/reference/list-widgets', 'List widgets']] },
      'https://docs.acme.com/reference/list-widgets': { readme: true, loaded: [['https://docs.acme.com/acme/api-next/v2/branches/1.0/reference/list-widgets?reduce=true', one]] },
    }, { 'https://docs.acme.com/acme/api-next/v2/branches/1.0/reference/list-widgets?reduce=false': all });
    const found = await searchReference('https://acme.com/', ports);
    expect(found.reference?.kind).toBe('openapi');
    expect(Object.keys(JSON.parse(found.reference!.document!).paths)).toHaveLength(2);
  });

  it('reports the pages that read like API documentation when there is no file, and stops at its budget', async () => {
    const ports = browser({
      'https://acme.com': { links: [['https://acme.com/developers', 'Developers']] },
      'https://acme.com/developers': { text: 'GET /v1/a\nPOST /v1/a\nDELETE /v1/a/{id}\nUse your API key.' },
    });
    const found = await searchReference('https://acme.com/', ports);
    expect(found.reference).toBeUndefined();
    expect(found.docsUrls).toEqual(['https://acme.com/developers']);
    // Each look costs the fake clock a second: a five-second budget ends the search after a few pages.
    const short = browser({ 'https://acme.com': {} });
    await searchReference('https://acme.com/', short, 5_000);
    expect(short.opened.length).toBeLessThan(5);
  });
});

describe('the no-reference task', () => {
  it('reads the homepage and the documentation pages out of the task', () => {
    expect(referenceTask('docs-to-spec: SAMWAD (https://samwad.tech/) has no machine-readable API reference we could find, and needs its official documentation inspected: https://samwad.tech/api/ , https://samwad.tech/guide/. Read the docs and write an OpenAPI 3 document')).toEqual({ homepage: 'https://samwad.tech/', docs: ['https://samwad.tech/api/', 'https://samwad.tech/guide/'] });
    expect(referenceTask('find-reference: acme (https://acme.com/) has no API reference on record.')).toEqual({ homepage: 'https://acme.com/', docs: [] });
    expect(referenceTask('write the spec from https://www.pennylane.com. Discovered auth hints: registration endpoint published; route dcr. Save it with connector_spec_put (a draft); do not connect or publish')).toEqual({ homepage: 'https://www.pennylane.com', docs: [] });
    expect(referenceTask('Connector "acme": no reference.\ndocs-to-spec: acme (https://acme.com/) has none')?.homepage).toBe('https://acme.com/');
    expect(referenceTask('open https://acme.com and get a test key')).toBeUndefined();
  });

  it('tells the agent which pages to write from, or to look itself, and how to say there is no API', () => {
    expect(docsToSpecPrompt('acme', 'https://acme.com/', ['https://acme.com/developers'])).toMatch(/read like its API documentation: https:\/\/acme\.com\/developers/);
    expect(docsToSpecPrompt('acme', 'https://acme.com/', [])).toMatch(/look for its developer or API pages yourself/);
    expect(docsToSpecPrompt('acme', 'https://acme.com/', [])).toMatch(/RESULT: wall no-api/);
    expect(referenceTask(docsToSpecPrompt('acme', 'https://acme.com/', []))?.homepage).toBe('https://acme.com/');
  });
});
