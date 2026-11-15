/** Find a vendor's API reference the way a person with a browser does, with no model. The server's finder reads
 * raw HTML, so it misses every docs site that draws itself in the browser (ReadMe, Redoc, Stoplight, Mintlify,
 * Swagger UI, Postman): those fetch the machine-readable description after the page loads. Here the docs are
 * opened in ClikCode's browser and every file the pages load is looked at; the one that says it is OpenAPI,
 * Swagger or a Postman collection is the reference. Pure rules in this file; the browser is a port
 * (connector-reference-live.ts). */

export type ReferenceKind = 'openapi' | 'swagger' | 'postman' | 'readme';
export interface FoundReference { url: string; kind: ReferenceKind; /** The document itself, when it was read from the page's own traffic. */ document?: string; via: string }
export interface ReferenceSearch {
  reference?: FoundReference;
  /** Pages that read like API documentation (endpoints, curl examples): what an agent writes a spec from when no file exists. */
  docsUrls: string[];
  visited: string[];
}

/** What a loaded file is, from its own first words: only a document that says so counts. */
export function referenceKindOf(text: string): Exclude<ReferenceKind, 'readme'> | undefined {
  const head = text.slice(0, 4000).trimStart();
  if (head.startsWith('{')) {
    // The document itself must say so at its top: a file that only wraps one is taken apart by embeddedReference.
    if (text.length > 12_000_000 || !/"(?:openapi|swagger|schema)"\s*:/.test(text.slice(0, 400_000))) return undefined;
    let doc: Record<string, unknown>;
    try { doc = JSON.parse(text) as Record<string, unknown>; } catch { return undefined; }
    const hasPaths = !!doc.paths && typeof doc.paths === 'object' && Object.keys(doc.paths).length > 0;
    if (typeof doc.openapi === 'string' && doc.openapi.startsWith('3') && hasPaths) return 'openapi';
    if (typeof doc.swagger === 'string' && doc.swagger.startsWith('2') && hasPaths) return 'swagger';
    const info = doc.info as { schema?: unknown } | undefined;
    if (typeof info?.schema === 'string' && info.schema.includes('schema.getpostman.com/json/collection') && Array.isArray(doc.item) && doc.item.length) return 'postman';
    return undefined;
  }
  if (/^(?:#[^\n]*\n|\s)*openapi\s*:\s*["']?3/m.test(head) && /^paths\s*:/m.test(text)) return 'openapi';
  if (/^(?:#[^\n]*\n|\s)*swagger\s*:\s*["']?2/m.test(head) && /^paths\s*:/m.test(text)) return 'swagger';
  return undefined;
}

/** A description carried inside another file: docs platforms (ReadMe's page data, Next-based portals) wrap the
 * OpenAPI document in their own JSON. The wrapped document with the most paths is taken out, as JSON text. */
export function embeddedReference(text: string): string | undefined {
  if (text.length > 12_000_000 || !/"(?:openapi|swagger)"\s*:\s*"[23]/.test(text) || !/"paths"\s*:/.test(text)) return undefined;
  let root: unknown;
  try { root = JSON.parse(text); } catch { return undefined; }
  let best: unknown, bestPaths = 0, visits = 0;
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 10 || ++visits > 200_000) return;
    if (Array.isArray(node)) { for (const item of node.slice(0, 400)) walk(item, depth + 1); return; }
    const record = node as Record<string, unknown>;
    if ((typeof record.openapi === 'string' || typeof record.swagger === 'string') && record.paths && typeof record.paths === 'object') {
      const count = Object.keys(record.paths).length;
      if (count > bestPaths) { best = record; bestPaths = count; }
      return;
    }
    for (const key of Object.keys(record).slice(0, 400)) walk(record[key], depth + 1);
  };
  walk(root, 0);
  return best ? JSON.stringify(best) : undefined;
}

/** A response worth reading: its address or type says data, not a picture, a script or a style. */
export function worthReading(url: string, contentType: string): boolean {
  if (/\.(?:png|jpe?g|gif|svg|webp|ico|css|woff2?|ttf|mp4|js|mjs|map)(?:\?|$)/i.test(url)) return false;
  return /json|yaml|yml|text\/plain|octet-stream/i.test(contentType) || /openapi|swagger|api-docs|postman|\.ya?ml|\.json|\/spec\b|\/oas\b/i.test(url);
}

const DEV_TEXT = /^(?:developers?|api(?: docs| reference| documentation)?|documentation|docs|developer (?:docs|portal|hub|center|centre)|api & webhooks|integrations? api|rest api|for developers|build with)\b/i;
const DEV_HREF = /(?:^https?:\/\/(?:docs|developers?|api|dev|apidocs|reference)\.)|\/(?:developers?|api-?docs?|api-reference|api|docs|reference|documentation)(?:[/?#]|$)/i;
const NOT_DOCS = /\/(?:blog|careers|jobs|pricing|legal|privacy|terms|login|signin|signup|contact|about|customers|press|news|status)(?:[/?#]|$)|\.(?:pdf|zip|png|jpe?g)(?:\?|$)|^mailto:|^tel:/i;

/** The vendor's own name in a host: "docs.acme.com" and "acme.readme.io" belong to acme.com; "github.com" does not. */
function sameVendor(url: string, homepage: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase(), home = new URL(homepage).hostname.toLowerCase().replace(/^www\./, '');
    const name = home.split('.').slice(0, -1).join('.').split('.').pop() ?? home;
    return host === home || host.endsWith(`.${home}`) || (name.length >= 4 && host.split('.').some(part => part === name || part.startsWith(`${name}-`) || part.endsWith(`-${name}`)));
  } catch { return false; }
}

/** Where to look, best first: the documentation links the homepage shows, then the usual developer addresses. */
export function docCandidates(homepage: string, links: ReadonlyArray<{ href: string; text: string }>, limit = 7): string[] {
  let origin: string, host: string;
  try { const u = new URL(homepage); origin = u.origin; host = u.hostname.replace(/^www\./, ''); } catch { return []; }
  const scored = links.filter(l => /^https:/i.test(l.href) && !NOT_DOCS.test(l.href) && sameVendor(l.href, homepage))
    .map(l => ({ href: l.href.split('#')[0]!, score: (DEV_TEXT.test(l.text.trim()) ? 3 : 0) + (DEV_HREF.test(l.href) ? 2 : 0) + (/api/i.test(l.text) ? 1 : 0) }))
    .filter(l => l.score >= 2).sort((a, b) => b.score - a.score).map(l => l.href);
  const guesses = [`https://docs.${host}/`, `https://developers.${host}/`, `https://developer.${host}/`, `${origin}/developers`, `${origin}/api`, `${origin}/docs/api`, `https://api.${host}/docs`, `${origin}/api-docs`];
  const out: string[] = [];
  const seen = new Set<string>();
  // Linked pages first (they exist); guesses fill what is left.
  for (const url of [...scored.slice(0, 4), ...guesses]) {
    const key = url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

/** Inside a documentation site: the links that lead to the endpoint reference itself. */
export function referencePages(page: string, links: ReadonlyArray<{ href: string; text: string }>, homepage: string, limit = 2): string[] {
  const here = page.split('#')[0]!.replace(/\/$/, '');
  return [...new Set(links.filter(l => /^https:/i.test(l.href) && !NOT_DOCS.test(l.href) && (sameVendor(l.href, homepage) || sameVendor(l.href, page))
    && (/^(?:api reference|rest api|api docs|api documentation|reference|endpoints|api explorer|api overview|open ?api|swagger|postman(?: collection)?)\b/i.test(l.text.trim()) || /\/(?:api-reference|reference|rest|openapi|swagger|api-explorer)(?:[/?#]|$)/i.test(l.href)))
    .map(l => l.href.split('#')[0]!).filter(href => href.replace(/\/$/, '') !== here))].slice(0, limit);
}

/** Links on a page that name a reference file outright ("Download OpenAPI", a .json under /openapi). */
export function referenceFileLinks(links: ReadonlyArray<{ href: string; text: string }>): string[] {
  return [...new Set(links.filter(l => /^https:/i.test(l.href) && (/(?:openapi|swagger|api-docs|postman)[^?#]*\.(?:json|ya?ml)(?:\?|$)|\/(?:openapi|swagger)(?:\.json|\.ya?ml)?(?:\?|$)|\.postman_collection\.json/i.test(l.href)
    || /^(?:download )?(?:open ?api|swagger|postman)(?: spec(?:ification)?| file| json| yaml| collection| definition)?$/i.test(l.text.trim()))).map(l => l.href))].slice(0, 6);
}

/** A page that documents endpoints in words: several "GET /path" lines or curl examples. */
export function readsLikeApiDocs(text: string): boolean {
  const verbs = text.match(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/[^\s"'<>]+|\/[\w{}:.\-/]+)/g) ?? [];
  const curls = text.match(/\bcurl\s+(?:-[A-Za-z-]+\s+\S+\s+)*["']?https?:\/\//g) ?? [];
  return new Set(verbs).size >= 3 || curls.length >= 2 || (new Set(verbs).size >= 1 && /\b(?:api key|bearer token|authorization header|rate limits?)\b/i.test(text) && /\bendpoints?\b/i.test(text));
}

/** What the browser does for the search: open an address and say what it showed and what it loaded. */
export interface ReferencePorts {
  open(url: string): Promise<{ url: string; ok: boolean; text: string; links: Array<{ href: string; text: string }>; readme: boolean; loaded: Array<{ url: string; text: string }> } | undefined>;
  /** Fetch a file by address (a link that names a reference file); undefined when it cannot be had. */
  fetch(url: string): Promise<string | undefined>;
  now(): number;
}

export async function searchReference(homepage: string, ports: ReferencePorts, budgetMs = 100_000): Promise<ReferenceSearch> {
  const began = ports.now();
  const left = (): boolean => ports.now() - began < budgetMs;
  const out: ReferenceSearch = { docsUrls: [], visited: [] };
  const tried = new Set<string>();
  let readme: string | undefined;
  let readmePages: string[] = [];
  /** Looks at one page; true when the reference was found there. */
  const look = async (url: string, via: string): Promise<{ found: boolean; links: Array<{ href: string; text: string }>; at: string }> => {
    const key = url.replace(/\/$/, '').toLowerCase();
    if (tried.has(key) || !left()) return { found: false, links: [], at: url };
    tried.add(key);
    const page = await ports.open(url).catch(() => undefined);
    if (!page?.ok) return { found: false, links: [], at: url };
    out.visited.push(page.url);
    for (const file of page.loaded) {
      const whole = referenceKindOf(file.text);
      const text = whole ? file.text : embeddedReference(file.text);
      const kind = whole ?? (text ? referenceKindOf(text) : undefined);
      if (kind && text) {
        let document = text;
        // ReadMe hands a page only its own endpoint (reduce=true); the same address unreduced is the whole API.
        if (!whole && /[?&]reduce=true\b/.test(file.url) && left()) {
          const all = await ports.fetch(file.url.replace(/([?&])reduce=true\b/, '$1reduce=false')).catch(() => undefined);
          const full = all ? embeddedReference(all) : undefined;
          if (full && full.length > document.length) document = full;
        }
        out.reference = { url: whole ? file.url : page.url, kind, document, via: `${via}: ${whole ? 'loaded by' : 'inside the data of'} ${page.url}` };
        return { found: true, links: page.links, at: page.url };
      }
    }
    for (const link of referenceFileLinks(page.links)) {
      if (tried.has(link) || !left()) continue;
      tried.add(link);
      const text = await ports.fetch(link).catch(() => undefined);
      const kind = text ? referenceKindOf(text) : undefined;
      if (kind && text) { out.reference = { url: link, kind, document: text, via: `${via}: linked from ${page.url}` }; return { found: true, links: page.links, at: page.url }; }
    }
    // A ReadMe-hosted site with no description on this page: its reference pages carry one each, so they are looked at next.
    if (page.readme && !readme) {
      readme = page.url;
      // Its endpoint pages, not the introduction, are where the description sits.
      const pages = [...new Set(page.links.map(l => l.href.split('#')[0]!).filter(href => /\/reference\/[a-z0-9_-]+$/i.test(href)))];
      const endpointLike = (href: string): boolean => /\/reference\/[a-z0-9_-]*(?:get|list|create|add|send|update|delete|post|put|search|retrieve)[a-z0-9_-]*$/i.test(href);
      readmePages = [...pages.filter(endpointLike), ...pages.filter(href => !endpointLike(href)).reverse()].slice(0, 3);
    }
    if (readsLikeApiDocs(page.text) && out.docsUrls.length < 4) out.docsUrls.push(page.url);
    return { found: false, links: page.links, at: page.url };
  };
  const home = await look(homepage, 'homepage');
  if (home.found) return out;
  for (const candidate of docCandidates(homepage, home.links)) {
    if (!left()) break;
    const docs = await look(candidate, 'docs');
    if (docs.found) return out;
    for (const inner of referencePages(docs.at, docs.links, homepage)) {
      if (!left()) break;
      if ((await look(inner, 'reference page')).found) return out;
    }
    // A ReadMe site was reached: its endpoint pages are the next place, before any other guess.
    if (readme) break;
  }
  for (const page of readmePages) {
    if (!left()) break;
    if ((await look(page, 'ReadMe endpoint page')).found) return out;
  }
  // Nothing readable in the browser, but the site is ReadMe's: the server's own reader of ReadMe sites gets a try.
  if (readme) out.reference = { url: readme, kind: 'readme', via: 'a ReadMe docs site' };
  return out;
}
