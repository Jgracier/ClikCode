/** The full-screen terminal renderer -- one paint()/select()/question() loop
 * shared by every harness and the Gateway path alike. A single frame string
 * per repaint (never multiple writes mid-frame), a fixed-capacity footer
 * band computed once per prompt rather than per keystroke, and DEC autowrap
 * disabled for the whole frame -- all three exist because getting any one
 * of them wrong reproduces a real scroll/flicker/duplication bug this class
 * has already been through. */

import chalk from 'chalk';
import { stdin as input, stdout as output } from 'node:process';
import {
  composerLayout, formatParagraph, nextCharacterIndex, previousCharacterIndex, renderInlineMarkdown,
  splitIntoBlocks, terminalCellWidth, visibleSlice, wrapWords,
} from './markdown-render.js';
import { compactPath, harnessSupportsEffort, localHarnessForCommand, renderActivityLine, sessionProviderLabel } from './native-harness-protocol.js';
import { CLAUDE_ALIAS_LABELS } from './native-account-data.js';
import type { HarnessActivityEvent, HarnessPrompter, HarnessSession, PickerOption } from './types.js';

export type WaitingInputAction = 'cancel' | 'scroll-up' | 'scroll-down' | 'page-up' | 'page-down';

/** Decode only keys that remain meaningful while a provider turn owns the
 * composer. Keeping this separate from cancellation prevents arrow/page keys
 * from being swallowed during generation. */
export function waitingInputActions(chunk: Buffer | string): WaitingInputAction[] {
  const keys = String(chunk).match(/\u001b\[[AB]|\u001b\[[56]~|[\s\S]/g) ?? [];
  return keys.flatMap((key): WaitingInputAction[] => {
    if (key === '\u001b' || key === '\u0003') return ['cancel'];
    if (key === '\u001b[A') return ['scroll-up'];
    if (key === '\u001b[B') return ['scroll-down'];
    if (key === '\u001b[5~') return ['page-up'];
    if (key === '\u001b[6~') return ['page-down'];
    return [];
  });
}

export type InterleavedResponsePart = { kind: 'text'; text: string } | { kind: 'activity'; lines: string[] };

/** Preserve the chronology of prose and tool events within one assistant
 * message. Provider protocols send them as separate event streams, so the
 * response offset captured at arrival is the stable join key. */
export function interleaveResponseContent(
  content: string,
  activities: ReadonlyArray<{ responseOffset: number; lines: string[] }>,
): InterleavedResponsePart[] {
  const parts: InterleavedResponsePart[] = [];
  let offset = 0;
  for (const activity of [...activities].sort((left, right) => left.responseOffset - right.responseOffset)) {
    const nextOffset = Math.max(offset, Math.min(content.length, activity.responseOffset));
    if (nextOffset > offset) parts.push({ kind: 'text', text: content.slice(offset, nextOffset) });
    parts.push({ kind: 'activity', lines: activity.lines });
    offset = nextOffset;
  }
  if (offset < content.length || !activities.length) parts.push({ kind: 'text', text: content.slice(offset) });
  return parts;
}

export class FullScreenHarnessPrompter implements HarnessPrompter {
  private closed = false;
  private history: string[] = [];
  private currentSession?: HarnessSession;
  private currentAccount?: string;
  private currentNotice?: string;
  private draft = '';
  private draftOptions: readonly PickerOption<string>[] = [];
  private draftSelected = 0;
  private draftPrompt = '› ';
  private draftCursor = 0;
  private draftPalette?: { capacity?: number; hint?: string; hideCursor?: boolean };
  private waitingTimer?: NodeJS.Timeout;
  private waitingFrame = 0;
  private waitingLabel = '';
  private waitingStartedAt = 0;
  private activityEntries: Array<{ anchor: number; responseOffset?: number; event?: HarnessActivityEvent; lines: string[] }> = [];
  private liveResponse = '';
  private responsePaintTimer?: NodeJS.Timeout;
  private activityAnchor = 0;
  /** Lines back from the very end of the conversation. 0 means "showing the
   * latest" (the default, and where every repaint clamps back to if the
   * conversation is shorter than this). Deliberately a line count, not a
   * message index: paging by whole screens needs to know how many wrapped
   * lines actually fit, which messages alone don't tell you. */
  private historyScroll = 0;
  private usageLabel?: string;
  private selecting = false;
  /** True while the slash palette (inside question()) has its own fixed-capacity
   * footer band open. usage()/activity() are called from fire-and-forget async
   * work (a background usage refresh, a turn's tool-call log) that has no idea
   * the palette owns a specific row layout right now; an unguarded repaint from
   * either recomputes capacity from whatever draftOptions happens to be, which
   * doesn't match the palette's own fixed capacity — the two disagree on where
   * the footer starts, and the status line gets drawn at both rows. Guarded the
   * same way `selecting` already guards this for select() pickers. */
  private paletteActive = false;
  private cancelWaiting?: () => void;
  private waitingCancelled = false;
  private pendingApproval?: { resolve: (accepted: boolean) => void; previousLabel: string };
  private readonly onWaitingInput = (chunk: Buffer | string): void => {
    if (this.pendingApproval) {
      const key = String(chunk).toLowerCase();
      if (key === 'y' || key === 'n' || key === '\r' || key === '\n' || key === '\u001b' || key === '\u0003') {
        const pending = this.pendingApproval;
        this.pendingApproval = undefined;
        this.waitingLabel = pending.previousLabel || 'thinking';
        pending.resolve(key === 'y');
        this.updateWaiting();
      }
      return;
    }
    for (const action of waitingInputActions(chunk)) {
      if (action === 'cancel') {
        if (this.waitingCancelled) continue;
        this.waitingCancelled = true;
        this.waitingLabel = 'stopping…';
        this.updateWaiting();
        this.cancelWaiting?.();
      } else if (action === 'scroll-up') {
        this.historyScroll += 3;
        this.updateWaiting();
      } else if (action === 'scroll-down') {
        this.historyScroll = Math.max(0, this.historyScroll - 3);
        this.updateWaiting();
      } else if (action === 'page-up') {
        this.historyScroll += 10;
        this.updateWaiting();
      } else if (action === 'page-down') {
        this.historyScroll = Math.max(0, this.historyScroll - 10);
        this.updateWaiting();
      }
    }
  };
  private readonly onResize = (): void => {
    if (!this.closed) {
      output.write('\u001b[2J');
      this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
    }
  };

  constructor() {
    output.write('\u001b[?1049h\u001b[?25h');
    process.on('SIGWINCH', this.onResize);
  }

  render(session: HarnessSession, account?: string, notice?: string): void {
    if (this.currentSession?.id !== session.id) this.activityEntries = [];
    this.currentSession = session;
    this.currentAccount = account;
    this.currentNotice = notice;
    // A render receives authoritative persisted state. Drop the transient
    // stream so the just-saved assistant message is never painted twice.
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.liveResponse = '';
    this.paint('', [], 0, '› ', 0);
  }

  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    if (!text) return;
    this.liveResponse = mode === 'replace' ? text : this.liveResponse + text;
    this.schedulePaint();
  }

  activity(message: string): void {
    const normalized = message.trim();
    const last = this.activityEntries[this.activityEntries.length - 1];
    if (!normalized || last?.lines[last.lines.length - 1] === normalized) return;
    this.activityEntries = [...this.activityEntries.slice(-49), {
      anchor: this.currentSession?.messages?.length ?? 0,
      ...(this.waitingLabel ? { responseOffset: this.liveResponse.length } : {}),
      lines: [normalized],
    }];
    this.schedulePaint();
  }

  activityEvent(event: HarnessActivityEvent): void {
    const anchor = this.currentSession?.messages?.length ?? 0;
    const match = event.kind === 'tool-done'
      ? [...this.activityEntries].reverse().find((entry) => entry.anchor === anchor && entry.event?.kind === 'tool-start'
        && (event.id ? entry.event.id === event.id : entry.event.label === event.label))
      : undefined;
    const effective = match ? {
      ...event,
      ...(event.label === 'tool' ? { label: match.event!.label } : {}),
      ...(event.diff ? {} : match.event?.diff ? { diff: match.event.diff } : {}),
    } : event;
    const lines = renderActivityLine(effective).map((line) => line.trim());
    if (match) {
      match.event = effective;
      match.lines = lines;
    } else {
      this.activityEntries = [...this.activityEntries.slice(-49), {
        anchor,
        ...(this.waitingLabel ? { responseOffset: this.liveResponse.length } : {}),
        event: effective,
        lines,
      }];
    }
    this.schedulePaint();
  }

  panel(title: string, body: string): void {
    const lines = body.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    this.activityEntries = [{ anchor: this.currentSession?.messages?.length ?? 0, lines: [chalk.bold(title), ...lines].slice(-6) }];
    this.activityAnchor = this.currentSession?.messages?.length ?? 0;
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }

  startWaiting(message: string, onCancel?: () => void): void {
    this.stopWaiting(false);
    this.liveResponse = '';
    this.activityAnchor = this.currentSession?.messages?.length ?? 0;
    this.waitingLabel = message;
    this.cancelWaiting = onCancel;
    this.waitingCancelled = false;
    this.waitingFrame = 0;
    this.waitingStartedAt = Date.now();
    if (input.isTTY) {
      input.setRawMode(true);
      input.resume();
      input.on('data', this.onWaitingInput);
    }
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
    this.waitingTimer = setInterval(() => {
      this.waitingFrame++;
      this.updateWaiting();
    }, 120);
    this.waitingTimer.unref();
  }

  stopWaiting(refresh = true): void {
    if (this.waitingTimer) clearInterval(this.waitingTimer);
    this.waitingTimer = undefined;
    input.off('data', this.onWaitingInput);
    if (input.isTTY) input.setRawMode(false);
    this.cancelWaiting = undefined;
    this.waitingCancelled = false;
    this.pendingApproval = undefined;
    this.waitingLabel = '';
    if (refresh && !this.closed) this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }

  phase(message: string): void {
    if (!this.waitingLabel || this.waitingCancelled || this.waitingLabel === message) return;
    this.waitingLabel = message;
    this.updateWaiting();
  }

  approval(title: string, detail?: string): Promise<boolean> {
    if (this.pendingApproval) return Promise.resolve(false);
    return new Promise((resolveApproval) => {
      this.pendingApproval = { resolve: resolveApproval, previousLabel: this.waitingLabel };
      this.waitingLabel = `${title}${detail ? ` · ${visibleSlice(detail.replace(/\s+/g, ' '), 90)}` : ''} · approve? [y/N]`;
      this.updateWaiting();
    });
  }

  usage(label?: string): void {
    if (this.usageLabel === label) return;
    this.usageLabel = label;
    this.schedulePaint();
  }

  private statusText(): string {
    const session = this.currentSession;
    if (!session) return '';
    const context = compactPath(session.workspace ?? process.cwd());
    const provider = `${sessionProviderLabel(session)}${this.usageLabel ? `  ${this.usageLabel}` : ''}`;
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    const rawModel = harness?.modelArgvPrefix ? session.model ?? 'automatic' : undefined;
    const model = rawModel && harness?.command === 'claude' ? CLAUDE_ALIAS_LABELS[rawModel] ?? rawModel : rawModel;
    const effort = harness && harnessSupportsEffort(harness) ? session.effort : undefined;
    // The title used to share this line with provider/model/directory, which
    // meant a long title truncated whichever of those came after it — the
    // exact information you'd want intact regardless of how long the title
    // is. It gets its own line now (see titleText below).
    return [provider, [model, effort].filter(Boolean).join(' '), context].filter(Boolean).join('  •  ');
  }

  /** The only other place a chat's title ever appeared was a transient line in
   * the /resume picker itself — once you were actually inside a resumed
   * conversation there was nothing on screen confirming which one, so
   * switching looked like it hadn't done anything even when the transcript
   * above had in fact changed. Right-aligned on its own line so it never
   * competes with statusText()'s provider/model/directory for space. */
  private titleText(): string | undefined {
    return this.currentSession?.name || undefined;
  }

  /** Elapsed time alongside the label -- matching a native CLI's own "Cogitated
   * for 5m 31s" style -- so a long turn reads as "still working, N seconds in"
   * rather than the same static label sitting there with no sense of how long
   * it's actually been (only the spinner glyph itself changing every 90ms). */
  private waitingText(): string {
    // ASCII frames render reliably in restricted fonts and remote terminals;
    // unsupported Braille spinner glyphs visibly flashed as question marks.
    const frames = ['|', '/', '-', '\\'];
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.waitingStartedAt) / 1000));
    const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
    return `${frames[this.waitingFrame % frames.length]} ${this.waitingLabel} (${elapsed})`;
  }

  private updateWaiting(): void {
    if (!this.waitingLabel || this.closed || this.selecting || this.paletteActive) return;
    this.schedulePaint();
  }

  /** Token deltas, spinner ticks, tool events, phases, and usage refreshes can
   * all arrive in the same few milliseconds. One shared scheduler collapses
   * those signals into a single atomic frame instead of queueing competing
   * full-screen writes that briefly expose half-updated cursor/footer state. */
  private schedulePaint(delay = 32): void {
    if (this.responsePaintTimer || this.closed || this.selecting || this.paletteActive) return;
    this.responsePaintTimer = setTimeout(() => {
      this.responsePaintTimer = undefined;
      if (!this.closed && !this.selecting && !this.paletteActive) {
        this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
      }
    }, delay);
    this.responsePaintTimer.unref();
  }

  /** `palette` fixes the reserved footer band to `capacity` rows for the whole time a
   * palette is open (instead of resizing per keystroke as matches narrow), and
   * `footerOnly` skips repainting the conversation area above it. Together these turn
   * "retype the whole screen on every keystroke" into "rewrite only what changed",
   * which is what stopped the palette from visibly flickering/jumping as you type.
   * The whole frame is assembled into one string and written with a single syscall,
   * with the terminal cursor hidden for the duration: the previous per-line writes
   * let the terminal actually render the cursor mid-hop between rows on every paint,
   * which is what "cursor glitches all over the place" was — not a logic bug, a
   * rendering-granularity one. `select()` reuses this same path (see below) so a
   * provider/model/effort picker is a windowed slice of this palette block, anchored
   * next to the composer, instead of a separate full-screen takeover. */
  private paint(composer: string, options: readonly PickerOption<string>[], selected: number, prompt: string, cursor: number, palette?: { capacity?: number; footerOnly?: boolean; hint?: string; hideCursor?: boolean }): void {
    const session = this.currentSession;
    if (!session) return;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.draft = composer;
    this.draftOptions = options;
    this.draftSelected = selected;
    this.draftPrompt = prompt;
    this.draftCursor = cursor;
    this.draftPalette = palette ? { capacity: palette.capacity, hint: palette.hint, hideCursor: palette.hideCursor } : undefined;
    // No -1 margin: DEC autowrap is off for this whole frame (see the
    // `[?7l` at the top of it), so the real last column is safe to
    // use, not just columns-1.
    const width = Math.max(12, output.columns || 100);
    const inner = width - 4;
    // The conversation transcript gets its own, tighter margin: a bare
    // marker-and-space (2 columns) instead of inner's extra 2-space wrapper
    // on top of its own 4-column reservation (6 total) -- next to a native
    // CLI's own output, which runs close to the full terminal width with
    // only a bullet-and-space margin, ClikCode's wider gutter read as
    // noticeably narrower and "bleaker" for no real reason; this doesn't
    // touch inner itself, so the notice/composer/meta lines below (which
    // share it) are unaffected.
    const conversationInner = width - 2;
    const rule = chalk.dim('─'.repeat(width));
    const persistedMessages = session.messages ?? [];
    const allMessages = this.liveResponse
      ? [...persistedMessages, { role: 'assistant' as const, content: this.liveResponse }]
      : persistedMessages;
    // 40, not 6: matches the same replay/adoption cap used elsewhere
    // (failoverPrompt, ADOPTED_TRANSCRIPT_LIMIT) and — now that the
    // conversation area supports scrolling — gives Page Up somewhere real to
    // go instead of a pool too small to scroll through at all.
    const messages = allMessages.slice(-40);
    const messageStart = allMessages.length - messages.length;
    // The final status row is written without a trailing newline, so using
    // the complete terminal height is safe and important: leaving one row
    // unpainted allowed an obsolete status line to remain visibly duplicated.
    const targetHeight = Math.max(5, output.rows || 30);
    const requestedPaletteCapacity = palette?.capacity ?? (options.length ? Math.min(options.length, 8) + 2 : 0);
    const paletteCapacity = Math.min(requestedPaletteCapacity, Math.max(0, targetHeight - 5));
    const footerOnly = palette?.footerOnly ?? false;
    const paletteRows = paletteCapacity;
    const noticeRows = this.currentNotice ? 1 : 0;
    const composerWidth = Math.max(8, inner - terminalCellWidth(prompt));
    const composerRows = composerLayout(composer, cursor, composerWidth);
    // Three non-composer footer rows: rule, title rule, and meta. Composer
    // rows expand upward and reduce transcript space instead of scrolling
    // horizontally off-screen.
    const rows = Math.max(1, targetHeight - 3 - composerRows.rows.length - paletteRows - noticeRows);
    const conversation: Array<{ text: string }> = [];
    const appendActivity = (anchor: number): void => {
      for (const entry of this.activityEntries.filter((item) => item.anchor === anchor && item.responseOffset === undefined)) {
        for (const activity of entry.lines) conversation.push({ text: `${chalk.dim('·')} ${visibleSlice(activity, Math.max(1, conversationInner - 2))}` });
      }
      if (this.waitingLabel && anchor === this.activityAnchor) conversation.push({ text: `${chalk.cyan('●')} ${chalk.dim(this.waitingText())}` });
    };
    appendActivity(messageStart);
    for (const [messageIndex, message] of messages.entries()) {
      const marker = message.role === 'assistant' ? chalk.white('·') : chalk.white('›');
      let firstLine = true;
      const appendMessageText = (content: string): void => {
        for (const block of splitIntoBlocks(content)) {
          if (block.kind === 'code') {
            // Not word-wrapped -- re-flowing code would change what it means.
            // Hard-truncated instead, same as visibleSlice does for a single
            // overlong token elsewhere in this file.
            for (const codeLine of block.lines) {
              const prefix = firstLine ? `${marker} ` : '  ';
              conversation.push({ text: `${prefix}  ${chalk.cyan(visibleSlice(codeLine, Math.max(1, conversationInner - 2)))}` });
              firstLine = false;
            }
            continue;
          }
          const { prefix: bulletPrefix, hangIndent, text, bold, rule } = formatParagraph(block.paragraph || ' ');
          if (rule) {
            const prefix = firstLine ? `${marker} ` : '  ';
            conversation.push({ text: `${prefix}${chalk.dim('─'.repeat(Math.max(1, conversationInner)))}` });
            firstLine = false;
            continue;
          }
          const styled = renderInlineMarkdown(text);
          const budget = Math.max(1, conversationInner - terminalCellWidth(bulletPrefix || hangIndent));
          // conversationInner is already the full per-line budget after the
          // 2-column marker/indent prefix; wrapWords breaks at spaces (falling
          // back to a hard break only for a single word wider than the whole
          // line) instead of the flat character-count slice this replaced,
          // which split words wherever the count happened to land.
          const wrapped = wrapWords(styled, budget);
          for (const [lineIndex, line] of wrapped.entries()) {
            const prefix = firstLine ? `${marker} ` : '  ';
            const structural = lineIndex === 0 ? bulletPrefix : hangIndent;
            conversation.push({ text: `${prefix}${structural}${bold ? chalk.bold(line) : line}` });
            firstLine = false;
          }
        }
      };
      const absoluteMessageIndex = messageStart + messageIndex;
      const embeddedActivities = this.activityEntries
        .filter((entry) => entry.anchor === absoluteMessageIndex && entry.responseOffset !== undefined)
        .map((entry) => ({ responseOffset: entry.responseOffset!, lines: entry.lines }));
      for (const part of interleaveResponseContent(message.content, embeddedActivities)) {
        if (part.kind === 'text') appendMessageText(part.text);
        else for (const activity of part.lines) conversation.push({ text: `${chalk.dim('·')} ${visibleSlice(activity, Math.max(1, conversationInner - 2))}` });
      }
      conversation.push({ text: '' });
      appendActivity(messageStart + messageIndex + 1);
    }
    // Clamped here (not just where scroll changes) because the available
    // content shifts underneath the same scroll value on every repaint: a
    // new message arriving grows `conversation`, a session switch can shrink
    // it out from under a scroll position that made sense for the old one.
    const maxScroll = Math.max(0, conversation.length - rows);
    this.historyScroll = Math.min(this.historyScroll, maxScroll);
    const windowStart = Math.max(0, conversation.length - rows - this.historyScroll);
    const shown = conversation.slice(windowStart, windowStart + rows);
    if (this.historyScroll > 0 && shown.length) {
      shown[0] = { text: `  ${chalk.dim(`── ${this.historyScroll} line${this.historyScroll === 1 ? '' : 's'} below · PgDn to catch up ──`)}` };
    }
    const meta = this.statusText();
    // DEC autowrap must stay off while an absolute-positioned frame is written.
    // A provider-supplied label can otherwise occupy two physical terminal rows
    // while the renderer still counts one, shifting every subsequent footer-only
    // repaint and leaving stale option rows above the composer.
    let frame = '\u001b[?25l\u001b[?7l';
    const screenLine = (text = ''): void => { frame += `\r\u001b[2K${text}\n`; };
    if (footerOnly) {
      frame += `\u001b[${rows + noticeRows + 1};1H`;
    } else {
      frame += '\u001b[H';
      if (shown.length) for (const row of shown) screenLine(row.text);
      else {
        screenLine();
        screenLine(`  ${chalk.dim('Start a conversation. Type / to open the command palette.')}`);
        screenLine();
      }
      const renderedConversationRows = shown.length || 3;
      const padding = Math.max(0, rows - renderedConversationRows);
      for (let index = 0; index < padding; index++) screenLine();
      if (this.currentNotice) screenLine(`  ${chalk.yellow(visibleSlice(this.currentNotice, inner))}`);
    }
    if (paletteCapacity) {
      screenLine(rule);
      const visibleRows = paletteCapacity - 2;
      const start = Math.max(0, Math.min(selected - Math.floor(visibleRows / 2), options.length - visibleRows));
      const windowed = options.slice(start, start + visibleRows);
      windowed.forEach((option, index) => {
        const absoluteIndex = start + index;
        const selectedOption = absoluteIndex === selected;
        const available = Math.max(1, width - 4);
        const label = visibleSlice(option.label, available);
        const remaining = available - terminalCellWidth(label);
        const detail = option.detail && remaining > 3 ? visibleSlice(option.detail, remaining - 2) : '';
        screenLine(`  ${selectedOption ? chalk.cyan('❯') : ' '} ${selectedOption ? chalk.bold(label) : label}${detail ? `  ${chalk.dim(detail)}` : ''}`);
      });
      for (let index = windowed.length; index < visibleRows; index++) screenLine();
      screenLine(`  ${chalk.dim(visibleSlice(palette?.hint ?? '↑↓ select · Tab complete · Enter run', width - 2))}`);
    }
    screenLine(rule);
    for (const [index, row] of composerRows.rows.entries()) {
      screenLine(`  ${index === 0 ? chalk.white(prompt) : ' '.repeat(terminalCellWidth(prompt))}${row}`);
    }
    // The rule below the composer carries the chat's title at its right
    // edge instead of a plain dashed line -- dashes fill from the left up to
    // wherever the title starts, so a longer title just eats more of the
    // rule rather than needing a line of its own. Provider/model/directory
    // (meta) stay on their own separate line below, never sharing space with
    // the title the way they used to.
    const title = this.titleText();
    const titleSuffix = title ? ` ${visibleSlice(title, Math.max(0, width - 4))}` : '';
    const ruleWidth = Math.max(0, width - terminalCellWidth(titleSuffix));
    screenLine(`${chalk.dim('─'.repeat(ruleWidth))}${chalk.dim(titleSuffix)}`);
    // meta is the true last line: total frame height is exactly the terminal
    // height, so a newline after the very last line would land the cursor on
    // the last row and scroll the whole screen by one -- invisible in a
    // one-off full repaint (which starts over from \x1b[H next time), but
    // fatal for footerOnly/select() repaints, which jump back to a fixed
    // absolute row: every such scroll left that target one row stale, so the
    // old line was never overwritten, only added to -- the "adds a line
    // every time you scroll" reports in the palette and pickers.
    frame += `\r\x1b[2K  ${chalk.dim(visibleSlice(meta, inner))}\x1b[?7h`;
    if (!palette?.hideCursor) {
      const rowsUp = 2 + (composerRows.rows.length - 1 - composerRows.cursorRow);
      frame += `\x1b[${rowsUp}A\r\x1b[${2 + terminalCellWidth(prompt) + composerRows.cursorWidth}C\x1b[?25h`;
    }
    output.write(frame);
  }

  async question(prompt: string, commands: readonly PickerOption<string>[] = [], settings?: { cancellable?: boolean }): Promise<string> {
    if (!input.isTTY) {
      // A single check here used to end the whole session the instant it
      // failed once -- fatal specifically after a long suspend/resume
      // window (a vendor login's own OAuth wait, the one case this
      // codebase has anything that runs for 20+ seconds with the real
      // terminal handed over), where a connection hiccup reconnecting a
      // moment later still read as isTTY=false on the very next check and
      // silently discarded whatever the suspended command was about to
      // save, with no error and no crash log to show for it (this exact
      // path, confirmed live: real OAuth completed, then the whole process
      // was just gone). Retrying briefly gives a transient blip a real
      // chance to resolve before treating the terminal as genuinely closed.
      for (let attempt = 0; attempt < 20 && !input.isTTY; attempt++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
      if (!input.isTTY) throw Object.assign(new Error('terminal input is closed'), { code: 'ERR_USE_AFTER_CLOSE' });
    }
    return new Promise((resolveQuestion, rejectQuestion) => {
      let value = '';
      let cursor = 0;
      let selected = 0;
      let historyIndex = this.history.length;
      let showedPalette = false;
      // Reserved once for the whole prompt, not recomputed per keystroke: keeping the
      // footer band a fixed height is what stops the conversation area above it from
      // reflowing (and the cursor from jumping) as the number of matches narrows.
      const paletteCapacity = commands.length ? Math.min(commands.length, 8) + 2 : 0;
      let paletteOpen = false;
      // No .slice(0, 8) here: that used to cap the real match list itself,
      // not just what's visible at once, so typing "/" (matching every
      // command) could never scroll to anything past the 8th regardless of
      // how far down you pressed -- selected's own wraparound never saw
      // past index 7 because options.length itself was capped there. The
      // windowed scroll in paint() below already exists specifically to
      // show a scrollable slice of a longer list; capping the list before
      // it ever got there defeated that.
      const matches = () => value.startsWith('/') && !value.includes(' ')
        ? commands.filter((option) => option.value.startsWith(value))
        : [];
      // Scrolling the conversation needs the full paint() path — the normal
      // (no-palette) branch below only ever touches the composer's own line
      // for performance, so a scroll action changing what's shown *above* the
      // composer would otherwise never actually repaint, which is exactly
      // what silently ate the first attempt at this: the key was received
      // and historyScroll did change, nothing on screen ever reflected it.
      const draw = (forceFullRepaint = false): void => {
        const options = matches();
        if (selected >= options.length) selected = 0;
        if (options.length || showedPalette) {
          this.paint(value, options, selected, prompt, cursor, { capacity: paletteCapacity, footerOnly: paletteOpen });
          paletteOpen = true;
          this.paletteActive = true;
        } else if (forceFullRepaint) {
          // No real palette here — pass no palette config at all, otherwise
          // paint() would size a footer band for one anyway (its own
          // capacity default comes from the full slash-command list, not
          // "is a palette actually showing").
          this.paint(value, [], 0, prompt, cursor);
        } else {
          const available = Math.max(8, (output.columns || 100) - 4 - terminalCellWidth(prompt));
          const currentLayout = composerLayout(value, cursor, available);
          const previousLayout = composerLayout(this.draft, this.draftCursor, available);
          if (currentLayout.rows.length > 1 || previousLayout.rows.length > 1) {
            this.paint(value, [], 0, prompt, cursor);
          } else {
            output.write(`\u001b[?25l\r\u001b[2K  ${chalk.white(prompt)}${currentLayout.rows[0] ?? ''}\r\u001b[${2 + terminalCellWidth(prompt) + currentLayout.cursorWidth}C\u001b[?25h`);
          }
          this.draft = value;
          this.draftOptions = [];
          this.draftSelected = selected;
          this.draftPrompt = prompt;
          this.draftCursor = cursor;
          paletteOpen = false;
          this.paletteActive = false;
        }
        showedPalette = options.length > 0;
      };
      const finish = (answer: string): void => {
        if (finished) return;
        finished = true;
        this.paletteActive = false;
        input.off('data', onData);
        input.setRawMode(false);
        output.write('\u001b[?25h');
        if (answer && !answer.startsWith('/') && this.history[this.history.length - 1] !== answer) this.history.push(answer);
        resolveQuestion(answer);
      };
      let finished = false;
      // Opt-in, not a default: this same question() drives the persistent
      // chat composer too, where Esc doing nothing is the existing,
      // intentional behavior (there's nothing to "cancel" mid-draft the way
      // there is for a one-off prompt). Callers that need real cancel
      // semantics -- like the API-key env-var-name prompt, previously
      // "esc doesn't cancel" with no way out short of Ctrl+C -- pass
      // { cancellable: true } and get a real rejection to catch, instead of
      // an empty string indistinguishable from "accepted the default".
      const cancel = (): void => {
        if (finished) return;
        finished = true;
        this.paletteActive = false;
        input.off('data', onData);
        input.setRawMode(false);
        output.write('\u001b[?25h');
        rejectQuestion(Object.assign(new Error('cancelled'), { code: 'ERR_PROMPT_CANCELLED' }));
      };
      const handleKey = (key: string): void => {
        const options = matches();
        if (key === '\u0003' || key === '\u0004') return finish('/exit');
        if (key === '\u001b' && settings?.cancellable) return cancel();
        if (key === '\r' || key === '\n') {
          if (options.length && value.startsWith('/') && !value.includes(' ')) {
            const command = options[selected].value;
            this.paint('', [], 0, prompt, 0);
            return finish(command);
          }
          return finish(value);
        }
        if (key === '\t' && options.length) {
          value = options[selected].value;
          cursor = value.length;
          return draw();
        }
        // Plain Up/Down scroll the conversation now, not prompt history: a
        // swipe gesture or a terminal app's own on-screen scrollbar (common
        // on mobile SSH clients, which is how this was actually being tried)
        // sends exactly these two sequences, nothing else -- Page Up/Down
        // below is real and works from a physical keyboard, but was
        // unreachable from a touch interface, which is what "I can see the
        // scrollbar but the chat doesn't move, even using the scrollbar
        // itself" was: the keys arrived, but at prompt-history recall, which
        // silently did nothing when there was no history yet to recall.
        // Prompt history moves to Ctrl+P/Ctrl+N (common readline-style
        // bindings) so it isn't lost, just no longer on the key that has to
        // mean "scroll" for a touch interface to be usable at all.
        if (key === '\u001b[A') {
          if (options.length) { selected = (selected - 1 + options.length) % options.length; return draw(); }
          this.historyScroll += 3;
          return draw(true);
        }
        if (key === '\u001b[B') {
          if (options.length) { selected = (selected + 1) % options.length; return draw(); }
          this.historyScroll = Math.max(0, this.historyScroll - 3);
          return draw(true);
        }
        if (key === '\u0010' && !options.length) { if (historyIndex > 0) { historyIndex--; value = this.history[historyIndex] ?? ''; cursor = value.length; } return draw(); }
        if (key === '\u000e' && !options.length) { historyIndex = Math.min(this.history.length, historyIndex + 1); value = this.history[historyIndex] ?? ''; cursor = value.length; return draw(); }
        if (key === '\u001b[D') { cursor = previousCharacterIndex(value, cursor); return draw(); }
        if (key === '\u001b[C') { cursor = nextCharacterIndex(value, cursor); return draw(); }
        // Page Up/Down scroll by a full page instead of 3 lines, for a real
        // keyboard's own dedicated keys.
        if (key === '\u001b[5~') { this.historyScroll += 10; return draw(true); }
        if (key === '\u001b[6~') { this.historyScroll = Math.max(0, this.historyScroll - 10); return draw(true); }
        if (key === '\u007f' || key === '\b') {
          if (cursor > 0) { const previous = previousCharacterIndex(value, cursor); value = value.slice(0, previous) + value.slice(cursor); cursor = previous; }
          return draw();
        }
        if (key === '\u0015') { value = ''; cursor = 0; return draw(); }
        if (key === '\u0001') { cursor = 0; return draw(); }
        if (key === '\u0005') { cursor = value.length; return draw(); }
        if (!key.startsWith('\u001b') && !/[\u0000-\u001f]/.test(key)) {
          value = value.slice(0, cursor) + key + value.slice(cursor);
          cursor += key.length;
          selected = 0;
          draw();
        }
      };
      const onData = (chunk: Buffer | string): void => {
        const keys = String(chunk).match(/\u001b\[[ABCD]|\u001b\[[56]~|[\s\S]/g) ?? [];
        for (const key of keys) {
          if (finished) break;
          handleKey(key);
        }
      };
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      draw();
    });
  }

  /** Provider/model/effort pickers used to be a separate full-screen takeover with
   * their own from-scratch repaint-everything draw loop — the conversation and
   * composer vanished while picking, and every arrow key redrew the whole list from
   * `\u001b[H`. This now renders as a windowed slice of the same palette band `paint()`
   * already draws for slash commands: the picker sits right where the composer is,
   * the conversation stays visible above it, and after the first frame every arrow
   * key is a footer-only repaint instead of a full-screen one. */
  /** Type-to-filter: a picker with more than a screenful of options (the
   * /resume list, across every ClikCode session plus every discovered vendor
   * chat, easily exceeds 50) was arrow-keys-only with no count, no scroll
   * indicator, and silent wraparound at each end -- a real conversation could
   * sit in the middle of a list that long and be effectively unfindable by
   * scrolling alone. Letters/digits/space now narrow the list live by
   * substring match against label and detail (title, provider, status);
   * arrow keys still navigate whatever is currently visible. This is why the
   * old 'j'/'k'/'q' single-letter aliases are gone: they would collide with
   * typing a real filter query character (searching for "qwen" or "junk"). */
  select<T>(title: string, options: readonly PickerOption<T>[], onAction?: (value: T, action: string) => Promise<void>): Promise<T | undefined> {
    if (!options.length) return Promise.resolve(undefined);
    return new Promise((resolveSelection) => {
      this.selecting = true;
      let query = '';
      let selected = 0;
      let painted = false;
      const capacity = Math.min(options.length, 8) + 2;
      const visibleOptions = (): readonly PickerOption<T>[] => {
        if (!query) return options;
        const needle = query.toLowerCase();
        return options.filter((option) =>
          option.label.toLowerCase().includes(needle) || (option.detail ?? '').toLowerCase().includes(needle));
      };
      const draw = (): void => {
        const visible = visibleOptions();
        if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
        const renderOptions = visible.map((option) => ({ label: option.label, detail: option.detail, value: '' }));
        const hint = query
          ? `"${query}" - ${visible.length} match${visible.length === 1 ? '' : 'es'} \u00b7 \u2191\u2193 move \u00b7 Enter choose \u00b7 Esc clear`
          : `${options.length} total \u00b7 \u2191\u2193 move \u00b7 Enter choose \u00b7 Esc cancel \u00b7 type to filter`;
        this.paint(title, renderOptions, selected, '', 0, { capacity, footerOnly: painted, hideCursor: true, hint });
        painted = true;
      };
      let finished = false;
      const finish = (value: T | undefined): void => {
        if (finished) return;
        finished = true;
        this.selecting = false;
        input.off('data', onData);
        input.setRawMode(false);
        this.paint('', [], 0, '\u203a ', 0);
        resolveSelection(value);
      };
      // Right arrow, not Enter, opens an option's own actions (disconnect,
      // reauthenticate, ...) -- only when it actually declares any,
      // otherwise this is a no-op so every existing picker that never sets
      // `actions` is completely unaffected. Runs a small nested select() for
      // the action list itself, pausing this picker's own key handling
      // while it's open (both would otherwise react to the same keypress --
      // Node lets multiple 'data' listeners stack) and redrawing this
      // picker's own view once it's done, since the nested call's own
      // cleanup repaints the plain composer over top of it.
      const openActions = async (option: PickerOption<T>): Promise<void> => {
        if (!option.actions?.length) return;
        input.off('data', onData);
        const actionValue = await this.select(option.label, option.actions.map((action) => ({ label: action.label, value: action.value })));
        if (finished) return;
        if (actionValue) await onAction?.(option.value, actionValue);
        if (finished) return;
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
        draw();
      };
      const handleKey = (key: string): void => {
        const visible = visibleOptions();
        if (key === '\u001b[A') selected = visible.length ? (selected - 1 + visible.length) % visible.length : 0;
        else if (key === '\u001b[B') selected = visible.length ? (selected + 1) % visible.length : 0;
        else if (key === '\u001b[C') { if (visible[selected]) void openActions(visible[selected]); return; }
        else if (key === '\r' || key === '\n') { if (visible[selected]) finish(visible[selected].value); return; }
        else if (key === '\u0003') return finish(undefined);
        else if (key === '\u001b') { if (query) { query = ''; selected = 0; } else return finish(undefined); }
        else if (key === '\u007f' || key === '\b') { if (!query) return; query = query.slice(0, -1); selected = 0; }
        else if (key.length === 1 && key >= ' ') { query += key; selected = 0; }
        else return;
        draw();
      };
      const onData = (chunk: Buffer | string): void => {
        const keys = String(chunk).match(/\u001b\[[ABCD]|[\s\S]/g) ?? [];
        for (const key of keys) {
          if (finished) break;
          handleKey(key);
        }
      };
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      draw();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.stopWaiting(false);
    process.off('SIGWINCH', this.onResize);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    output.write('\u001b[?25h\u001b[?1049l');
  }

  /** Hands the real terminal to a vendor CLI's own interactive flow (typically
   * login) without tearing the session down, so ClikCode's UI can resume in
   * place once that process exits. */
  async suspend(): Promise<void> {
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    output.write('\u001b[?25h\u001b[?1049l');
    // Best-effort mitigation, not a confirmed root cause: a vendor login's
    // own paste handling erroring right after handoff is plausibly a race
    // between the terminal actually finishing its mode switch (raw -> cooked,
    // alt-screen -> main buffer) and the child process starting to read --
    // both writes above are fire-and-forget from Node's side, with no way to
    // know when the terminal itself has caught up. A short settle window
    // before the caller spawns anything costs nothing on the success path
    // and closes the gap if that race is real.
    await new Promise((resolveSettle) => setTimeout(resolveSettle, 50));
  }

  resume(): void {
    if (this.closed) return;
    // \x1b[2J explicitly clears the whole alt-screen buffer before painting
    // -- suspend() hands control to the real terminal for a login prompt,
    // and the terminal's actual dimensions can genuinely change in that
    // window (most plausibly a mobile SSH client's on-screen keyboard
    // appearing/disappearing). Every other repaint in this file only clears
    // the exact lines it's about to rewrite (screenLine's \x1b[2K on each
    // line as the cursor advances), which is fine when the frame height is
    // stable between paints, but would leave old content below a shorter
    // new frame -- e.g. an old meta/status line -- never revisited. That's
    // the concrete "meta line duplicates after switching providers" report
    // this fixes: switching to a provider needing login is exactly the
    // path that goes through suspend/resume.
    output.write('\u001b[?1049h\u001b[2J');
    if (input.isTTY) input.resume();
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }
}
