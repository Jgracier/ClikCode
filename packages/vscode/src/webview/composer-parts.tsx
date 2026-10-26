/** Pieces of the composer: what it shows above and below the message box. */
import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { COPIED_MS } from '../../../../src/harness/protocol/timings';
import { loginPortForwardHint } from '../../../../src/gateway/login/link-info';
import { compactCount, formatElapsed } from '../../../../src/harness/protocol/format';
import { queuedRowLabel, type ChatModel } from '../model';
import { post, uid } from './bus';
import { Icon, Spinner, useSlowWait } from './ui';
import { useNow } from './clock';
import type { Attachment } from './composer-text';

export type Menu = 'provider' | 'model' | 'effort' | 'mode' | 'machines' | 'account' | undefined;

/** Messages waiting for the turn to end: each can be taken back or removed. */
export function QueueRows({ model, enterAgain, firstWaiting }: { model: ChatModel; enterAgain: boolean; firstWaiting: number }): JSX.Element {
  return (
    <div class="queued" aria-label="Queued messages">
      {model.queued.map((item, index) => (
        <div key={item.id} class="queued-item">
          <Icon name={item.command ? 'terminal-cmd' : 'clock'} /><span class="queued-text" title={item.text}>{item.text}</span>
          <span class="muted">{queuedRowLabel(model, item, index === firstWaiting && enterAgain)}</span>
          <button type="button" class="icon-button tiny" title="Edit: take it back into the message box" aria-label="Edit queued message"
            onClick={() => post({ type: 'unqueue', id: item.id, edit: true })}><Icon name="edit" /></button>
          <button type="button" class="icon-button tiny" title="Remove from the queue" aria-label="Remove queued message"
            onClick={() => post({ type: 'unqueue', id: item.id })}><Icon name="close" /></button>
        </div>
      ))}
    </div>
  );
}

/** The chips above the message box: references, images and held pastes. */
export function AttachmentChips({ attachments, onExpand, onRemove }: { attachments: readonly Attachment[]; onExpand: (attachment: Attachment) => void; onRemove: (attachment: Attachment) => void }): JSX.Element {
  return (
    <div class="attachments">
      {attachments.map((attachment) => (
        <span key={attachment.key} class={`attachment${attachment.preview ? ' with-thumb' : ''}${attachment.kind === 'pasted' ? ' pasted' : ''}`} title={attachment.mention?.label ?? attachment.path}>
          {attachment.preview ? <img class="attachment-thumb" src={attachment.preview} alt="" /> : <Icon name={attachment.kind === 'image' ? 'file-media' : attachment.kind === 'pasted' ? 'clippy' : 'code'} />}
          {attachment.kind === 'pasted' ? (
            <button type="button" class="attachment-expand" title="Put the pasted text back in the message box, to edit" onClick={() => onExpand(attachment)}>{attachment.label}</button>
          ) : <span>{attachment.label}</span>}
          <button type="button" class="icon-button tiny" aria-label={`Remove ${attachment.label}`} onClick={() => onRemove(attachment)}><Icon name="close" /></button>
        </span>
      ))}
    </div>
  );
}

/** The status row's account button, which opens its menu. */
export function StatusButtons({ model, menu, setMenu, connected }: { model: ChatModel; menu: Menu; setMenu: (menu: Menu) => void; connected: boolean }): JSX.Element {
  const account = model.currentAccount;
  return (
    <>
      {/* The Gateway has no account of its own: its button is for its credit. */}
      {account || model.providerId === 'gateway' ? (
        <button type="button" id="account-button" class={`status-account${menu === 'account' ? ' open' : ''}`} data-popover-anchor aria-haspopup="dialog" aria-expanded={menu === 'account'}
          title={account ? `${account.label}: this provider's accounts` : 'Gateway credit'} disabled={!connected} onClick={() => setMenu(menu === 'account' ? undefined : 'account')}>
          <Icon name={account?.problem ? 'warning' : account ? 'account' : 'credit-card'} /><span class="status-label">{account?.label ?? 'Credit'}</span><Icon name="chevron-down" />
        </button>
      ) : null}
    </>
  );
}

/** What ClikCode is doing between turns ("preparing…", a local model's
 * download at 42%), as the terminal's band shows it: the page's spinner
 * and clock, and only once it is slow (useSlowWait) -- "preparing…" came
 * and went before every turn. */
export function BusyLine({ label }: { label: string | undefined }): JSX.Element | null {
  const shown = useSlowWait(label !== undefined);
  const last = useRef<{ label: string; since: number }>();
  if (label !== undefined && !last.current) last.current = { label, since: Date.now() };
  if (label !== undefined && last.current) last.current.label = label;
  if (label === undefined && !shown) last.current = undefined;
  const now = useNow(shown);
  if (!shown || !last.current) return null;
  const elapsed = now - last.current.since;
  return <span class="muted busy" role="status"><Spinner />{last.current.label}{elapsed >= 1000 ? ` · ${formatElapsed(elapsed)}` : ''}</span>;
}

/** How full the conversation's context window is, as a ring that fills. All the stats are on hover --
 * context, what the chat has cost, the last turn -- and nothing is written into the chat. */
export function ContextMeter({ context, tokens, cost }: { context: NonNullable<ChatModel['context']>; tokens?: string; cost?: string }): JSX.Element {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const percent = context.percent;
  const figures = context.used ? `${compactCount(context.used)}${context.window ? ` of ${compactCount(context.window)}` : ''} tokens` : '';
  const label = `Context ${percent < 10 ? percent.toFixed(1) : Math.round(percent)}% used${figures ? ` (${figures})` : ''}`;
  return (
    <span class={`context-meter${percent >= 90 ? ' high' : percent >= 70 ? ' warn' : ''}`} tabIndex={0} role="img" title={`${label}${cost ? `\nThis chat: ${cost}` : ''}${tokens ? `\nLast turn: ${tokens}` : ''}`} aria-label={`${label}${cost ? `. This chat: ${cost}` : ''}`}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={radius} class="context-track" />
        <circle cx="8" cy="8" r={radius} class="context-fill" stroke-dasharray={`${(percent / 100) * circumference} ${circumference}`} transform="rotate(-90 8 8)" />
      </svg>
      <span>{percent > 0 && percent < 1 ? '<1' : Math.round(percent)}%</span>
    </span>
  );
}

/** A sign-in in progress: its link opened in the browser and its code to
 * confirm there, once the vendor gives one; a key it takes instead as a row
 * under them (the terminal's hint line under the link); questions it asks
 * come up as sheets over it. Cancel ends it. Nothing is typed into a terminal. */
export function SignInCard({ signIn }: { signIn: NonNullable<ChatModel['signIn']> }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [key, setKey] = useState('');
  return (
    <div class="install-card signin-link" role="status" id="sign-in-link">
      <div class="install-text"><Icon name="key" /> {signIn.url ? `Sign in to ${signIn.name} in your browser` : `Signing in to ${signIn.name}…`}</div>
      {signIn.url ? <div class="signin-code"><button type="button" class="secondary" data-open onClick={() => post({ type: 'signInOpen', url: signIn.url! })}>Open full consent page</button><button type="button" class="icon-button tiny" title="Copy full sign-in link" aria-label="Copy full sign-in link" onClick={() => { void navigator.clipboard?.writeText(signIn.url ?? ''); }}><Icon name="copy" /></button></div> : null}
      {signIn.url && loginPortForwardHint(signIn.url) ? <div class="muted">{loginPortForwardHint(signIn.url)}</div> : null}
      {signIn.code ? (
        <div class="signin-code">
          <span class="muted">Confirm this code there</span>
          <code data-code>{signIn.code}</code>
          <button type="button" class="icon-button tiny" title={copied ? 'Copied' : 'Copy code'} aria-label={copied ? 'Copied' : 'Copy code'}
            onClick={() => { void navigator.clipboard?.writeText(signIn.code ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), COPIED_MS); }); }}>
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
        </div>
      ) : null}
      {signIn.ask ? (
        <form class="signin-key" onSubmit={(event) => { event.preventDefault(); if (!key.trim()) return; post({ type: 'signInAnswer', id: signIn.id, text: key.trim() }); setKey(''); }}>
          <input id="sign-in-key" type={signIn.ask.secret ? 'password' : 'text'} value={key} placeholder={signIn.ask.prompt} aria-label={signIn.ask.prompt}
            autocomplete="off" spellcheck={false} onInput={(event) => setKey((event.target as HTMLInputElement).value)} />
          <button type="submit" class="secondary" disabled={!key.trim()}>Use key</button>
        </form>
      ) : null}
      <div class="banner-actions">
        <button type="button" class="secondary" data-cancel onClick={() => post({ type: 'signInCancel', id: signIn.id })}>Cancel</button>
      </div>
    </div>
  );
}
