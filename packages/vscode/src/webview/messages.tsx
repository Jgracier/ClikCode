/** Messages: the user's, ClikCode's answer (finished and streaming) and notices it sent in the user's place. */
import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useRef, useState } from 'preact/hooks';
import { isClikCodeNotice } from '../../../../src/session/clikcode-notice';
import { COPIED_MS } from '../../../../src/harness/protocol/timings';
import { withoutOtherOrgThinkingNotice } from '../../../../src/harness/protocol/claude-thinking-notice';
import { post, uid } from './bus';
import { createStreamingMarkdown, renderMarkdown } from './markdown';
import { Icon } from './ui';
import { splitEditorContext } from '../editor-context';


/** Finished messages, rendered once each and kept across a redraw of the
 * transcript (another conversation and back). Keyed by conversation and
 * position, checked against the text; the live answer never goes in here. */
export const finishedHtml = new Map<string, { text: string; html: string }>();
export const FINISHED_LIMIT = 400;

export function renderFinished(key: string, text: string): string {
  const hit = finishedHtml.get(key);
  if (hit?.text === text) return hit.html;
  const html = renderMarkdown(withoutOtherOrgThinkingNotice(text));
  finishedHtml.delete(key);
  finishedHtml.set(key, { text, html });
  if (finishedHtml.size > FINISHED_LIMIT) finishedHtml.delete(finishedHtml.keys().next().value!);
  return html;
}

/** Copies an answer as written (its markdown), and says so for a moment. */
export function CopyAnswer({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" class="icon-button tiny message-copy" title={copied ? 'Copied' : 'Copy answer'} aria-label={copied ? 'Copied' : 'Copy answer'}
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), COPIED_MS); }); }}>
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  );
}

export const AssistantMessage = memo(({ cacheKey, text }: { cacheKey: string; text: string }): JSX.Element => (
  <div class="message assistant" role="article" aria-label="ClikCode">
    <div class="markdown" dangerouslySetInnerHTML={{ __html: renderFinished(cacheKey, text) }} />
    <div class="message-actions"><CopyAnswer text={text} /></div>
  </div>
));

/** The answer still streaming: the settled blocks and the growing one are
 * separate nodes, so a delta replaces only the last block's HTML. */
export function LiveMarkdown({ text }: { text: string }): JSX.Element {
  const render = useRef(createStreamingMarkdown());
  const { parts, tail } = render.current(withoutOtherOrgThinkingNotice(text));
  // One node per settled chunk, keyed by its place: a chunk is final, so
  // growing the answer adds nodes and leaves the earlier ones' DOM alone.
  return (
    <div class="markdown">
      {parts.map((html, index) => <div key={index} class="md-part" dangerouslySetInnerHTML={{ __html: html }} />)}
      <div class="md-part tail" dangerouslySetInnerHTML={{ __html: tail }} />
    </div>
  );
}

/** A sent prompt. Settled ones (`prompt`: its number, as /redo counts them)
 * show two actions on hover: copy it, or redo from it -- the conversation
 * goes back to before it and it returns to the message box (/redo). */
export const UserMessage = memo(({ text: content, prompt }: { text: string; prompt?: number }): JSX.Element => {
  // Something ClikCode told the model, not a message of the user's: never drawn.
  if (isClikCodeNotice(content)) return <></>;
  const { text, file, problems, selections } = splitEditorContext(content);
  return (
    <div class="message user" role="article" aria-label="You">
      {prompt !== undefined ? (
        <div class="message-actions">
          <button type="button" class="icon-button" title="Copy" aria-label="Copy prompt" onClick={() => { void navigator.clipboard?.writeText(text); }}><Icon name="copy" /></button>
          <button type="button" class="icon-button" title="Redo from here" aria-label="Redo from this prompt" onClick={() => post({ type: 'send', text: `/redo @${prompt}`, id: uid() })}><Icon name="discard" /></button>
        </div>
      ) : null}
      <div class="bubble">
        {text}
        {selections.length ? (
          <div class="bubble-context" title="Sent with the selected lines">
            {selections.map((selection) => <span key={selection} class="bubble-chip"><Icon name="code" />{selection}</span>)}
          </div>
        ) : null}
        {file ? (
          <div class="bubble-context" title={`Sent with the open file${problems ? ` and ${problems} problem${problems === 1 ? '' : 's'} VS Code reported there` : ''}`}>
            <Icon name="file" /><span>{file.split(/[\\/]/).pop()}</span>{problems ? <span class="context-problems"><Icon name="warning" />{problems}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});
