/** Model output as HTML that cannot run anything.
 *
 * The webview's CSP already forbids inline and remote scripts; this is the
 * second wall. Raw HTML in a message is shown as the text it is, links go
 * only to http(s)/mailto (opened by the extension, never navigated in the
 * webview), and images are never loaded -- a remote image is a request the
 * model would get to make from the user's machine.
 */
import { Marked, type Tokens } from 'marked';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
}

export function safeHref(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : undefined;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    link(this: { parser: { parseInline(tokens: Tokens.Link['tokens']): string } }, { href, title, tokens }: Tokens.Link): string {
      const label = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (!safe) return label;
      return `<a href="${escapeHtml(safe)}" data-href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`;
    },
    image({ href, text }: Tokens.Image): string {
      const safe = safeHref(href);
      return safe ? `<a href="${escapeHtml(safe)}" data-href="${escapeHtml(safe)}">${escapeHtml(text || safe)}</a>` : escapeHtml(text);
    },
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? '').match(/^[\w+-]+/)?.[0] ?? '';
      return `<pre class="code"${language ? ` data-lang="${escapeHtml(language)}"` : ''}><code>${escapeHtml(text)}</code></pre>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}
