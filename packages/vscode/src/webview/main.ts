/** The chat webview: renders the ChatModel the extension posts, and turns
 * clicks and keys into messages back. Holds no conversation state of its own
 * beyond the composer's text. */
import type { ChatModel, Note } from '../model';
import type { FromWebview, ToWebview } from '../webview-protocol';
import { escapeHtml, renderMarkdown } from './markdown';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void; getState(): unknown; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
const post = (message: FromWebview): void => vscode.postMessage(message);

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const header = $('header');
const banner = $('banner');
const log = $('log');
const transcript = $('transcript');
const live = $('live');
const approvals = $('approvals');
const queued = $('queued');
const status = $('status');
const input = $<HTMLTextAreaElement>('input');
const sendButton = $<HTMLButtonElement>('send');
const stopButton = $<HTMLButtonElement>('stop');

let model: ChatModel | undefined;
let transcriptKey = '';
const markdownCache = new Map<string, string>();

function markdown(text: string): string {
  const cached = markdownCache.get(text);
  if (cached !== undefined) return cached;
  const html = renderMarkdown(text);
  if (markdownCache.size > 500) markdownCache.clear();
  markdownCache.set(text, html);
  return html;
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function chip(label: string, value: string | undefined, command: string, title: string): string {
  return `<button class="chip" data-command="${command}" title="${escapeHtml(title)}"><span class="chip-label">${escapeHtml(label)}</span>${escapeHtml(value ?? '—')}</button>`;
}

function renderHeader(current: ChatModel): void {
  const chips = current.sessionId ? [
    chip('provider', current.harness ?? 'choose…', 'clikcode.chooseProvider', 'Choose the harness this chat runs on'),
    chip('model', current.model ?? 'default', 'clikcode.chooseModel', 'Choose the model'),
    ...(current.route === 'local' ? [chip('account', current.account ?? 'default', 'clikcode.chooseAccount', 'Choose the account')] : []),
    ...(current.effort !== undefined ? [chip('effort', current.effort, 'clikcode.chooseEffort', 'Reasoning effort')] : []),
    ...(current.permissions !== undefined ? [chip('permissions', current.permissions, 'clikcode.choosePermissions', 'What needs your approval')] : []),
  ] : [];
  header.innerHTML = `<div class="title">${escapeHtml(current.title ?? (current.sessionId ? 'New chat' : 'ClikCode'))}</div><div class="chips">${chips.join('')}</div>`
    + (current.accountUsage ? `<div class="usage">${escapeHtml(current.accountUsage)}</div>` : '');
}

const REMEDY_BUTTONS: Record<NonNullable<ChatModel['remedy']>, { command: string; label: string }> = {
  'install': { command: 'clikcode.install', label: 'Install ClikCode' },
  'update-clikcode': { command: 'clikcode.update', label: 'Update ClikCode' },
  'update-extension': { command: 'clikcode.updateExtension', label: 'Update Extension' },
};

function renderBanner(current: ChatModel): void {
  if (current.connection === 'ready' && current.sessionId) { banner.hidden = true; banner.innerHTML = ''; return; }
  banner.hidden = false;
  if (current.connection === 'error' || current.connection === 'stopped') {
    banner.innerHTML = `<p>${escapeHtml(current.connectionError ?? 'ClikCode stopped.')}</p><div class="actions">`
      + (current.remedy ? `<button data-command="${REMEDY_BUTTONS[current.remedy].command}">${REMEDY_BUTTONS[current.remedy].label}</button>` : '')
      + '<button data-command="clikcode.restart">Retry</button><button class="secondary" data-command="clikcode.configure">Settings</button>'
      + '<button class="secondary" data-command="clikcode.showLog">Log</button></div>';
    return;
  }
  if (current.connection === 'starting') { banner.innerHTML = '<p class="muted">Starting ClikCode…</p>'; return; }
  banner.innerHTML = '<p>No chat is open.</p><div class="actions"><button data-command="clikcode.newChat">New chat</button><button class="secondary" data-command="clikcode.resumeChat">Resume…</button></div>';
}

function noteHtml(note: Note): string {
  if (note.kind === 'panel') {
    // A long panel (/help) starts folded; a short answer is shown.
    const open = note.text.split('\n').length <= 12 ? ' open' : '';
    return `<details class="panel"${open}><summary>${escapeHtml(note.title ?? '')}</summary><pre>${escapeHtml(note.text)}</pre></details>`;
  }
  return `<div class="notice ${note.level ?? 'info'}">${escapeHtml(note.text)}</div>`;
}

function messageHtml(role: 'user' | 'assistant', content: string): string {
  return role === 'user'
    ? `<div class="message user"><div class="bubble">${escapeHtml(content)}</div></div>`
    : `<div class="message assistant"><div class="markdown">${markdown(content)}</div></div>`;
}

function renderTranscript(current: ChatModel): void {
  const last = current.messages[current.messages.length - 1];
  const key = `${current.sessionId}|${current.messages.length}|${last?.content.length ?? 0}|${current.notes.length}|${current.pendingPrompt ?? ''}`;
  if (key === transcriptKey) return;
  transcriptKey = key;
  const parts: string[] = [];
  const notesAt = (index: number): void => {
    for (const note of current.notes) if (note.after === index) parts.push(noteHtml(note));
  };
  notesAt(0);
  current.messages.forEach((message, index) => {
    parts.push(messageHtml(message.role, message.content));
    notesAt(index + 1);
  });
  // Notes anchored past the transcript (the transcript was replaced by a
  // shorter one, e.g. a compacted chat) still show, at the end.
  for (const note of current.notes) if (note.after > current.messages.length) parts.push(noteHtml(note));
  if (current.pendingPrompt) parts.push(messageHtml('user', current.pendingPrompt));
  if (!current.messages.length && !current.pendingPrompt && current.sessionId) {
    parts.push('<div class="empty muted">Ask anything. <code>/</code> runs a ClikCode command, <code>!</code> a shell command.</div>');
  }
  transcript.innerHTML = parts.join('');
}

const ACTIVITY_ICON: Record<string, string> = { 'tool-start': '◌', 'tool-done': '✓', 'tool-error': '✗', thinking: '·' };

function renderLive(current: ChatModel): void {
  const parts: string[] = [];
  if (current.plan.length) {
    parts.push(`<div class="plan">${current.plan.map((entry) => `<div class="plan-entry ${escapeHtml(entry.status ?? '')}">${entry.status === 'completed' ? '☑' : entry.status === 'in_progress' ? '▸' : '☐'} ${escapeHtml(entry.content)}</div>`).join('')}</div>`);
  }
  if (current.live) {
    const activities = current.live.activities.slice(-12).map((activity) => `<div class="activity ${activity.kind}">`
      + `<span class="icon">${ACTIVITY_ICON[activity.kind] ?? '·'}</span> ${escapeHtml(activity.label)}`
      + (activity.output?.length ? `<pre>${escapeHtml(activity.output.slice(-6).join('\n'))}</pre>` : '')
      + '</div>').join('');
    parts.push(`<div class="message assistant live">${activities ? `<div class="activities">${activities}</div>` : ''}`
      + (current.live.text ? `<div class="markdown">${renderMarkdown(current.live.text)}</div>` : '')
      + `<div class="waiting"><span class="spinner"></span>${escapeHtml(current.live.phase ?? current.live.waitingLabel)}…</div></div>`);
  } else if (current.running) {
    parts.push('<div class="message assistant live"><div class="waiting"><span class="spinner"></span>starting…</div></div>');
  }
  for (const submission of current.submissions) {
    const said = submission.disposition === 'steered' ? 'sent into this turn' : submission.disposition === 'queued' ? 'queued for the next turn' : submission.disposition === 'error' ? 'not sent' : 'sending…';
    parts.push(`<div class="submission"><span class="muted">${escapeHtml(said)}:</span> ${escapeHtml(submission.text)}</div>`);
  }
  live.innerHTML = parts.join('');
}

function renderApprovals(current: ChatModel): void {
  approvals.innerHTML = current.approvals.map((approval) => `<div class="approval" data-id="${escapeHtml(approval.id)}">`
    + `<div class="approval-title">${escapeHtml(approval.title)}</div>`
    + (approval.detail ? `<pre class="approval-detail">${escapeHtml(approval.detail)}</pre>` : '')
    + '<div class="actions">'
    + `<button data-approve="yes">Approve</button>`
    + (approval.rule ? `<button class="secondary" data-approve="always" title="${escapeHtml(approval.rule)}">Always allow</button>` : '')
    + `<button class="secondary" data-approve="no">Deny</button>`
    + (approval.hasDiff ? '<button class="link" data-diff="1">View diff</button>' : '')
    + '</div></div>').join('');
}

function renderQueued(current: ChatModel): void {
  queued.innerHTML = current.queued.length
    ? `<div class="muted">Queued</div>${current.queued.map((item) => `<div class="queued-item">${item.command ? '<span class="muted">command</span> ' : ''}${escapeHtml(item.text)}</div>`).join('')}`
    : '';
}

function renderStatus(current: ChatModel): void {
  const usage = current.turnUsage;
  const tokens = usage && (usage.inputTokens || usage.outputTokens)
    ? `${usage.inputTokens ?? 0} in · ${usage.outputTokens ?? 0} out` : '';
  status.textContent = [current.busy ? `${current.busy}` : '', tokens].filter(Boolean).join(' · ');
  stopButton.hidden = !current.running;
  input.placeholder = current.running ? 'Steer the running turn, or queue a message…' : 'Message ClikCode — / for commands';
  input.disabled = current.connection !== 'ready' || !current.sessionId;
  sendButton.disabled = input.disabled;
}

function render(current: ChatModel): void {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  renderHeader(current);
  renderBanner(current);
  renderTranscript(current);
  renderLive(current);
  renderApprovals(current);
  renderQueued(current);
  renderStatus(current);
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function send(): void {
  const text = input.value.trim();
  if (!text || !model || input.disabled) return;
  post({ type: 'send', text, id: uid() });
  input.value = '';
  autosize();
  vscode.setState({ draft: '' });
}

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  } else if (event.key === 'Escape' && model?.running) {
    event.preventDefault();
    post({ type: 'cancel', restoreDraft: !input.value });
  }
});
input.addEventListener('input', () => { autosize(); vscode.setState({ draft: input.value }); });
sendButton.addEventListener('click', send);
stopButton.addEventListener('click', () => post({ type: 'cancel', restoreDraft: !input.value }));

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const link = target.closest('a[data-href]');
  if (link) {
    event.preventDefault();
    post({ type: 'openLink', href: link.getAttribute('data-href') ?? '' });
    return;
  }
  if (target.closest('a')) { event.preventDefault(); return; }
  const commandButton = target.closest('[data-command]');
  if (commandButton) { post({ type: 'command', command: commandButton.getAttribute('data-command') ?? '' }); return; }
  const approval = target.closest('.approval');
  const id = approval?.getAttribute('data-id');
  if (!id) return;
  const answer = target.closest('[data-approve]')?.getAttribute('data-approve');
  if (answer) post({ type: 'approve', id, approved: answer === 'always' ? 'always' : answer === 'yes' });
  else if (target.closest('[data-diff]')) post({ type: 'viewDiff', id });
});

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  if (message.type === 'model') { model = message.model; render(model); return; }
  if (message.type === 'setDraft') { input.value = message.text; autosize(); input.focus(); return; }
  if (message.type === 'insert') {
    input.value = input.value ? `${input.value.replace(/\s*$/, '')}\n\n${message.text}` : message.text;
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return;
  }
  if (message.type === 'focus') input.focus();
});

const saved = vscode.getState() as { draft?: string } | undefined;
if (saved?.draft) { input.value = saved.draft; autosize(); }
post({ type: 'ready' });
