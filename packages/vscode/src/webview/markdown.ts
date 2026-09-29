/** Model output as HTML that cannot run anything.
 *
 * The webview's CSP already forbids inline and remote scripts; this is the
 * second wall. Raw HTML in a message is shown as the text it is, links go
 * only to http(s)/mailto (opened by the extension, never navigated in the
 * webview), and images are never loaded -- a remote image is a request the
 * model would get to make from the user's machine.
 */
import { Marked, type Tokens } from 'marked';
import { pathIn } from './format';

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
      return `<div class="codeblock"><div class="codebar"><span>${escapeHtml(language || 'text')}</span>`
        + '<button class="icon-button codecopy" data-copy title="Copy" aria-label="Copy code"><i class="codicon codicon-copy"></i></button></div>'
        + `<pre class="code"${language ? ` data-lang="${escapeHtml(language)}"` : ''}><code>${escapeHtml(text)}</code></pre></div>`;
    },
    /** Inline code that is a path opens the file. */
    codespan({ text }: Tokens.Codespan): string {
      const raw = text;
      const found = pathIn(raw);
      if (found && found.index === 0 && found.path.length + (found.line ? String(found.line).length + 1 : 0) === raw.length) {
        return `<code class="file-link" role="link" tabindex="0" data-file="${escapeHtml(found.path)}"${found.line ? ` data-line="${found.line}"` : ''}>${escapeHtml(text)}</code>`;
      }
      return `<code>${escapeHtml(text)}</code>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}
