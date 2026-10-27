/** The one reading of "every pressable control on the page" for the sign-in drivers (OAuth consent and keygrab). It runs in the page, so
 * the function below is self-contained: everything it needs arrives in its argument. What counts as a link that leaves the page is decided
 * once here (OPENS_ANOTHER_APP), so a mailto: link whose text is the user's email is never offered by either driver. */

/** A link whose address starts a program other than the page (mailto:, tel:, sms:, callto:, facetime:, an app's own scheme). The browser hands
 * it to the operating system, which opens a mail client or a chooser, and the page never moves on: the sign-in driver would press it again.
 * Google's "hasn't verified this app" page prints the developer's address as a mailto: link, which a text match for the profile's email took for
 * the account to choose. Web, javascript:, about: and relative addresses are the page's own. */
export const OPENS_ANOTHER_APP = /^\s*(?!https?:|javascript:|about:)[a-z][a-z0-9+.-]*:/i;

/** What can be pressed on a consent screen (also account cards that carry their address in an attribute, and click handlers). */
export const PRESSABLE = 'button, [role=button], a, [role=link], input[type=submit], input[type=button], summary, [data-identifier], [data-email], [data-test-id], [onclick]';
/** What can be pressed on a vendor's own site: menus and tabs too, but no bare click handlers. */
export const PRESSABLE_SITE = 'button, [role=button], a, [role=link], [role=menuitem], [role=tab], input[type=submit], input[type=button], summary';

export interface PageControlsOptions {
  pressable: string;
  /** Source of OPENS_ANOTHER_APP. */
  otherApp: string;
  /** How many elements are looked at. */
  cap: number;
  /** Also look inside open shadow roots. */
  shadow?: boolean;
  /** Add the address in data-identifier / data-email to the name (account cards). */
  identifiers?: boolean;
  /** Add href, footer, nav and menu flags. */
  detail?: boolean;
}
export interface PageControl { name: string; leaf: boolean; href?: string; footer?: true; nav?: true; menu?: true }

/** Runs in the page. Self-contained: no imports, no module variables. */
export function readPageControls(opts: PageControlsOptions): PageControl[] {
  const leavesPage = new RegExp(opts.otherApp, 'i');
  type Root = { querySelectorAll(s: string): ArrayLike<unknown> };
  type El = { closest(s: string): { getAttribute(n: string): string | null } | null; matches(s: string): boolean; getClientRects(): { length: number }; children: { length: number }; textContent: string | null; getAttribute(n: string): string | null; value?: string; href?: string; tagName: string };
  const doc = (globalThis as unknown as { document: Root }).document;
  const selector = `${opts.pressable}, span, div, p, li, label`;
  let nodes: El[] = [];
  if (opts.shadow) {
    const walk = (root: Root): void => {
      for (const n of Array.from(root.querySelectorAll(selector))) nodes.push(n as El);
      for (const host of Array.from(root.querySelectorAll('*')) as unknown as Array<{ shadowRoot?: Root | null }>) if (host.shadowRoot) walk(host.shadowRoot);
    };
    walk(doc);
  } else nodes = Array.from(doc.querySelectorAll(selector)) as El[];
  const out: PageControl[] = [];
  const seen = new Set<string>();
  for (const n of nodes.slice(0, opts.cap)) {
    if (!n.getClientRects().length) continue;
    // Not on, or inside, a link that opens another program: pressing it would never change the page.
    if (leavesPage.test(n.closest('a[href]')?.getAttribute('href') ?? '')) continue;
    const isPress = n.matches(opts.pressable);
    if (!isPress && n.children.length) continue;
    const text = (n.getAttribute('aria-label') || n.value || n.textContent || '').replace(/\s+/g, ' ').trim();
    let name = text;
    if (opts.identifiers) {
      const ident = n.getAttribute('data-identifier') || n.getAttribute('data-email') || '';
      name = (ident && !text.includes(ident) ? `${text} ${ident}` : text).trim();
    }
    if (!name || name.length > 120) continue;
    const key = `${isPress}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!opts.detail) { out.push({ name, leaf: !isPress }); continue; }
    const popup = n.getAttribute('aria-haspopup');
    out.push({
      name, leaf: !isPress,
      ...(n.tagName === 'A' && n.href ? { href: n.href } : {}),
      ...(n.closest('footer, [role=contentinfo]') ? { footer: true as const } : {}),
      ...(n.closest('nav, aside, [role=navigation], [role=complementary]') ? { nav: true as const } : {}),
      ...(name.length <= 40 && ((popup && popup !== 'false') || n.getAttribute('aria-expanded') === 'false' || n.closest('[aria-haspopup]:not([aria-haspopup=false]), [aria-expanded=false], [role=listbox], [role=combobox], .dropdown, [class*=dropdown], [class*=avatar], [class*=user-menu], [class*=UserMenu]')) ? { menu: true as const } : {}),
    });
  }
  return out;
}

/** Source of an expression that runs `fn` in the page, handing it a reader that returns the controls for `opts`; for page.evaluate / frame.evaluate, which run a string as written. */
export const withPageControls = (fn: (controls: () => PageControl[]) => unknown, opts: PageControlsOptions): string =>
  `(function(){ var read = ${readPageControls.toString()}; return (${fn.toString()})(function(){ return read(${JSON.stringify(opts)}); }); })()`;
