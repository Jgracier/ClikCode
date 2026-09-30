/** Model output as HTML that cannot run anything.
 *
 * The webview's CSP already forbids inline and remote scripts; this is the
 * second wall. Raw HTML in a message is shown as the text it is, links go
 * only to http(s)/mailto (opened by the extension, never navigated in the
 * webview), and images are never loaded -- a remote image is a request the
 * model would get to make from the user's machine.
 */
import { Marked, type Token, type Tokens } from 'marked';
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

/** A blank line ends this block for good. Not so for a list (the next item
 * after a blank line joins it and makes it loose), indented code (it runs on
 * across blank lines) or raw HTML (some kinds do too). */
function closedBy(before: Token | undefined): boolean {
  if (!before) return true;
  if (before.type === 'list' || before.type === 'html') return false;
  return !(before.type === 'code' && (before as Tokens.Code).codeBlockStyle === 'indented');
}

/** The live answer as `stable` (every block before the last blank-line
 * boundary, rendered once and then only appended to) and `tail` (the block
 * still growing, re-rendered on each delta). Re-parsing the whole answer every
 * 40 ms made a long one quadratic. The TUI's createStreamingBlockParser uses
 * the same boundary: text only grows at the end, and a blank line stops a
 * later line from merging into the construct before it (see closedBy), so
 * what comes before it renders the same forever. Link reference definitions resolve across the
 * whole text, so an answer with any is rendered whole. */
export function createStreamingMarkdown(): (text: string) => { stable: string; tail: string } {
  let stableText = '';
  let stableHtml = '';
  let incremental = true;
  return (text) => {
    if (!text.startsWith(stableText)) {
      // A replacement stream rewrote earlier text: start over.
      stableText = '';
      stableHtml = '';
      incremental = true;
    }
    if (!incremental) return { stable: '', tail: renderMarkdown(text) };
    const rest = text.slice(stableText.length);
    const tokens = marked.lexer(rest);
    if (Object.keys(tokens.links).length) {
      incremental = false;
      stableText = '';
      stableHtml = '';
      return { stable: '', tail: renderMarkdown(text) };
    }
    let offset = 0;
    let cut = 0;
    let cutIndex = 0;
    tokens.forEach((token, index) => {
      if (index > 0 && token.type !== 'space' && tokens[index - 1]!.type === 'space' && closedBy(tokens[index - 2])) {
        cut = offset;
        cutIndex = index;
      }
      offset += token.raw.length;
    });
    if (cutIndex > 0) {
      stableHtml += marked.parser(tokens.slice(0, cutIndex));
      stableText += rest.slice(0, cut);
    }
    return { stable: stableHtml, tail: marked.parser(tokens.slice(cutIndex)) };
  };
}
