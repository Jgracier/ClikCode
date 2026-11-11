/** The append-only transcript of a frame: what is retired into scrollback this frame, and the live answer under it. */
import chalk from 'chalk';
import { sanitizeTerminalText } from '../../render/text.js';
import { isClikCodeNotice } from '../../../session/clikcode-notice.js';
import { stripRepeatedTitles } from '../../../session/title.js';
import { TurnTranscript } from '../../../turn/transcript.js';
import type { MessageBlock } from '../../../harness/prompter.js';
import { transientAssistantRequired } from '../../render/activity-log.js';
import { turnEndLine } from '../../render/turn-end-line.js';
import { accountSwitchLine } from '../../../turn/failover.js';
import { reseedRowsFor, reseedStartIndex } from '../../render/reseed-window.js';
import { liveTurnSpan } from '../../render/steer-rows.js';
import { pendingPromptText } from '../../render/pending-prompt.js';
import { renderMessageBlocks } from '../../render/message-blocks.js';
import { withoutOtherOrgThinkingNotice } from '../../../harness/protocol/claude-thinking-notice.js';
import type { TerminalHarnessPrompter } from '../../prompter.js';
import { inlineHistoryMode } from '../../inline.js';
import { INLINE_TRANSCRIPT_ROWS } from '../state.js';
import type { HarnessSession, TranscriptMessage } from '../../../session/model.js';
import { type RowBuilders, createRowBuilders, createToolRows, createTurnTools, type TurnSeam } from './rows.js';


/** The messages this frame draws: the session's, plus the prompt a pending
 * turn has not yet saved, and whether an empty assistant anchor is owed. */
export function frameMessages(p: TerminalHarnessPrompter, session: HarnessSession) {
  const stableMessages = session.messages ?? [];
  const pending = p.turn ? session.pendingTurn : undefined;
  const pendingPrompt = pendingPromptText({
    ...(pending?.prompt ? { durable: pending.prompt } : {}),
    ...(p.submittedPrompt ? { sticky: p.submittedPrompt } : {}),
    lastMessage: stableMessages[stableMessages.length - 1],
  });
  const persistedMessages = pendingPrompt
    ? [...stableMessages, { role: 'user' as const, content: pendingPrompt, ...(pending?.automatic && pendingPrompt === pending.prompt ? { automatic: pending.automatic } : {}) }]
    : p.transcriptMessages(session);
  // Tool events often arrive before the first prose token. They still belong
  // to the in-flight assistant message. Render an empty temporary assistant
  // anchor immediately; otherwise the tools remain invisible and then all
  // appear at once when the first sentence arrives.
  const settledMessage = pendingPrompt ? undefined : persistedMessages[persistedMessages.length - 1];
  // Nothing of a turn stepped out of is drawn until it is followed again.
  // While a turn runs, its tools are anchored where it began (activityAnchor)
  // -- the same anchor turnTools reads them by. Comparing against the
  // transcript's length missed them whenever the transcript already held
  // the prompt (a window attached to a worker): every tool stayed invisible
  // until the first word of the answer, then all appeared at once.
  const hasTransientAssistant = !p.steppedOut && (transientAssistantRequired(
    p.liveResponse, Boolean(p.turn), p.turn ? p.activityAnchor : persistedMessages.length, p.activityEntries,
    settledMessage?.role === 'assistant' ? settledMessage.content : undefined,
  ) || Boolean(pending?.steers?.length));
  return { pending, pendingPrompt, persistedMessages, hasTransientAssistant };
}

type TranscriptInput = {
  session: HarnessSession; pending: HarnessSession['pendingTurn']; persistedMessages: ReturnType<typeof frameMessages>['persistedMessages'];
  hasTransientAssistant: boolean; conversationInner: number;
};

/** What turns a saved message into rows at one width: the row builders, its saved calls, and settled blocks. `claim`: the activity
 * between messages is being written for good, each entry once (the transcript); unset, it is only being drawn again (history). */
export type MessageKit = {
  builders: RowBuilders;
  claim?: boolean;
  savedTools: ReturnType<typeof createTurnTools>['savedTools'];
  renderBlocks: (blocks: readonly MessageBlock[], firstOfMessage: boolean) => string[];
};

type Kit = MessageKit & {
  finished: string[]; emit: (rows: readonly string[]) => void;
  turnTools: ReturnType<typeof createTurnTools>['turnTools'];
};

/** The rows of saved message `index`: THE way a message becomes rows, for the transcript as it is written (writeMessages), the
 * history the view scrolls back into (history-window.ts renderChunk) and the dump written under the shell (through renderChunk).
 * One writer, so a message scrolled back to reads as it did when it was written, and its measured height is the height it had.
 *
 * A notice ClikCode gave the model is not the user's to read: only the activity after it. Otherwise a blank row before a user's
 * message (a change of speaker is a bigger break than a paragraph), the message -- with its saved calls back between its
 * paragraphs, or as text -- then what the turn needed on the way (another account), its closing line, a blank row and the activity
 * after it. `body`: rows already decided for the message (the answer that streamed live), and `closedBy`: the message whose
 * closing lines end it (the last of a steered turn's span). `tools: false`: its calls are on screen already (the live turn's).
 * Blank rows are collapsed by whoever emits them (blankCollapser). */
export function savedMessageRows(
  kit: MessageKit, messages: readonly TranscriptMessage[], index: number,
  options: { body?: readonly string[]; closedBy?: number; tools?: boolean } = {},
): string[] {
  const { builders, savedTools, renderBlocks } = kit;
  const message = messages[index]!;
  const claim = kit.claim ?? false;
  if (message.role === 'user' && isClikCodeNotice(message.content)) return builders.standaloneActivity(index + 1, claim);
  const rows: string[] = [];
  const tools = options.body || options.tools === false || message.role !== 'assistant' ? [] : savedTools(message, index);
  if (options.body) rows.push(...options.body);
  else if (tools.length) {
    rows.push(...new TurnTranscript().advance({
      content: sanitizeTerminalText(stripRepeatedTitles(message.content)), tools, turnEnded: true, renderBlocks,
    }).finished);
  } else {
    if (message.role === 'user' && index > 0) rows.push('');
    // A title tag never renders, however it got into the saved reply: a vendor that repeated its first reply's tag, or an older
    // transcript. An older automatic /compact record is its notice, not the user's words.
    rows.push(...(message.role === 'assistant'
      ? builders.messageRows(withoutOtherOrgThinkingNotice(stripRepeatedTitles(message.content)), '·')
      : message.automatic ? builders.noticeRows(message.automatic) : builders.userRows(message.content)));
  }
  const closing = options.closedBy ?? index;
  const last = messages[closing]!;
  if (last.role === 'assistant' && last.accountSwitch) rows.push('', `  ${chalk.yellow(accountSwitchLine(last.accountSwitch))}`);
  const ended = last.role === 'assistant' ? turnEndLine(messages, closing) : undefined;
  if (ended) rows.push('', `  ${chalk.dim(`─ ${ended} ─`)}`);
  rows.push('', ...builders.standaloneActivity(closing + 1, claim));
  return rows;
}

/** Appends rows to `into`, an empty row on each side of a message at most: two of them separate a message from the answer under it
 * and from the message after it, never a third, and never a leading one at the top. `seed`: the two rows before `into` (what was
 * written before it), so the rule holds across the boundary. */
export function blankCollapser(into: string[], seed: { last?: string; before?: string } = {}): (rows: readonly string[]) => void {
  return (rows) => {
    for (const row of rows) {
      const last = into.length ? into[into.length - 1] : seed.last;
      const before = into.length > 1 ? into[into.length - 2] : into.length ? seed.last : seed.before;
      if (row === '' && (last === undefined || (last === '' && (before === '' || before === undefined)))) continue;
      into.push(row);
    }
  };
}

/** Where this list carries on from, whether the pending turn is already in
 * it, and where the live answer landed (a reseed first, if one is owed). */
function settleSeam(p: TerminalHarnessPrompter, finished: string[], session: HarnessSession, persistedMessages: TranscriptInput['persistedMessages'], conversationInner: number) {
  let reseeding = Boolean(p.emitted.pendingReseed());
  const applyReseed = (): void => {
    if (p.emitted.pendingReseed()) {
      finished.length = 0;
      p.clearTranscript();
      // The first frame of the process, of a newly opened session, or at a
      // new width writes a recent window of the conversation -- enough to
      // fill the viewport and scroll a little. A full-history rewrite made
      // opening a long chat wait on every message before anything drew.
      p.emitted.reseeded();
      p.turnTranscript.reset();
    }
  };
  applyReseed();
  // Where this list carries on from, whether the pending turn is already
  // in it, and where the live answer landed. All three are stated -- with
  // the failures each one prevents -- in render/transcript-seam.ts.
  // A list that no longer contains the row on screen is rewritten from
  // the list. Matching that row's text is what duplicated a live turn.
  let resume = p.emitted.resume(persistedMessages);
  if (resume.diverged) {
    reseeding = true;
    applyReseed();
    resume = p.emitted.resume(persistedMessages);
  }
  let { firstUnwritten, materializedPendingTurn } = resume;
  // Cleared below once the live answer has been consumed, so it stays a let.
  let liveAssistant = resume.liveAssistant;
  // A reseed of a long chat only paints a recent window. Older messages are
  // marked written so the seam stays honest; they are not in
  // alternateTranscript (same trade-off as its row cap). The first frame
  // then costs O(viewport), not O(history).
  if (reseeding && firstUnwritten === 0 && persistedMessages.length > 0) {
    // Older messages are not written here at all: the window renders them on demand when the view scrolls up to them
    // (history-window.ts), at any distance, so nothing of the conversation is out of reach.
    const from = reseedStartIndex(persistedMessages, inlineHistoryMode() ? INLINE_TRANSCRIPT_ROWS : reseedRowsFor(p.viewportRows()), conversationInner);
    p.scrollWindow.first = from;
    if (from > 0) {
      for (let index = 0; index < from; index += 1) p.emitted.wrote(persistedMessages[index]!);
      p.emitted.settle(from);
      firstUnwritten = from;
      if (liveAssistant !== undefined && liveAssistant < from) liveAssistant = undefined;
    }
  }

  return { firstUnwritten, liveAssistant, materializedPendingTurn };
}

/** The persisted messages not yet written, each retired once with its calls. */
function writeMessages(
  p: TerminalHarnessPrompter, kit: Kit, persistedMessages: TranscriptInput['persistedMessages'], firstUnwritten: number, startLiveAssistant: number | undefined,
): void {
  const { finished, emit, turnTools, renderBlocks } = kit;
  let liveAssistant = startLiveAssistant;
  emit(kit.builders.standaloneActivity(firstUnwritten));
  // The turn this window drew live has all its calls on screen already: a
  // steer splits its saved answer into several messages, and the ones after
  // the first must not draw those calls a second time.
  let drewLiveTurn = false;
  for (let index = firstUnwritten; index < persistedMessages.length; index += 1) {
    const message = persistedMessages[index]!;
    const line = p.alternateTrimmed + p.alternateTranscript.length + p.pendingFinished.length + finished.length;
    if (!p.scrollWindow.detached) p.messageLines.set(index, line);
    if (index !== liveAssistant || message.role !== 'assistant') {
      emit(savedMessageRows(kit, persistedMessages, index, { tools: !drewLiveTurn }));
      p.emitted.wrote(message);
      continue;
    }
    // The answer that just streamed. Its rows are already in scrollback and the transcript knows exactly which blocks it still
    // owes, so a persisted copy that runs longer than what streamed -- a re-derived answer, an interrupted turn -- contributes only
    // its tail, and one identical to what streamed contributes nothing at all. A steered turn is saved as several messages and was
    // drawn live as one answer: the span of them is that answer, written once.
    const spanEnd = liveTurnSpan(persistedMessages, index, [...p.turnSteers.values()]);
    const answer = persistedMessages.slice(index, spanEnd + 1).filter((item) => item.role === 'assistant').map((item) => item.content).join('');
    const body = p.turnTranscript.advance({ content: sanitizeTerminalText(answer), tools: turnTools(true), turnEnded: true, renderBlocks }).finished;
    p.emitted.liveAnswerSettled();
    liveAssistant = undefined;
    drewLiveTurn = true;
    p.turnTranscript.reset();
    p.turnSteers.clear();
    // The steers and the answers after them were that same drawing.
    for (let covered = index; covered <= spanEnd; covered += 1) {
      if (!p.scrollWindow.detached) p.messageLines.set(covered, line);
      p.emitted.wrote(persistedMessages[covered]!);
    }
    emit(savedMessageRows(kit, persistedMessages, index, { body, closedBy: spanEnd }));
    index = spanEnd;
  }
  p.emitted.settle(persistedMessages.length);
}

/** Settled blocks as rows at `inner` columns: the notice a vendor adds about another org's thinking never shows. */
export function makeRenderBlocks(inner: number) {
  return (blocks: readonly MessageBlock[], firstOfMessage: boolean): string[] =>
    renderMessageBlocks(blocks.flatMap((block): MessageBlock[] => {
      if (block.kind !== 'paragraph' && block.kind !== 'heading' && block.kind !== 'list-item') return [block];
      const text = withoutOtherOrgThinkingNotice(block.text);
      return text.trim() ? [{ ...block, text }] : [];
    }), '·', inner, firstOfMessage);
}

/** One frame's transcript: the rows retired this frame (`finished`) and the
 * live conversation (the block still receiving tokens). */
export function writeTranscript(p: TerminalHarnessPrompter, input: TranscriptInput) {
  const { session, pending, persistedMessages, hasTransientAssistant, conversationInner } = input;
  // -------------------------------------------------------------------
  // The append-only transcript. A finished row is retired into it exactly
  // once and never rewritten in place (only a change of width writes the
  // whole of it again); the live region below it -- the block still
  // receiving tokens, queued turns and the footer -- is rebuilt each frame.
  // TurnTranscript decides what can no longer change, and that is the whole
  // decision.
  // -------------------------------------------------------------------
  const finished: string[] = [];
  const emit = blankCollapser(finished, { ...(p.lastFinishedRow !== undefined ? { last: p.lastFinishedRow } : {}), ...(p.secondLastFinishedRow !== undefined ? { before: p.secondLastFinishedRow } : {}) });
  const builders = createRowBuilders(p, conversationInner);
  const seam: TurnSeam = { materializedPendingTurn: false };
  const { savedTools, turnTools } = createTurnTools(p, builders, createToolRows(p, builders), pending, seam);
  const renderBlocks = makeRenderBlocks(conversationInner);
  const renderLive = (blocks: readonly MessageBlock[], firstOfMessage: boolean): string[] =>
    renderMessageBlocks(blocks, '·', conversationInner, firstOfMessage, true);
  const settled = settleSeam(p, finished, session, persistedMessages, conversationInner);
  seam.materializedPendingTurn = settled.materializedPendingTurn;
  const kit: Kit = { finished, emit, builders, claim: true, savedTools, turnTools, renderBlocks };
  p.scrollWindow.source = { messages: persistedMessages, inner: conversationInner, conversation: session.id };
  writeMessages(p, kit, persistedMessages, settled.firstUnwritten, settled.liveAssistant);
  // Where the rows of the answer still streaming begin: everything before is a persisted message (the dump writes those from the list).
  p.scrollWindow.liveFrom = p.alternateTrimmed + p.alternateTranscript.length + p.pendingFinished.length + finished.length;
  const liveConversation: string[] = [];
  if (hasTransientAssistant) {
    p.emitted.liveAssistantIndex = p.emitted.writtenCount();
    const content = sanitizeTerminalText(p.liveResponse);
    const step = p.turnTranscript.advance({
      content,
      // The live answer is lexed from its last blank-line boundary rather
      // than re-parsed from the top on every delta.
      blocks: p.streamingBlocks(content),
      tools: turnTools(!p.turn),
      turnEnded: !p.turn,
      renderBlocks,
      renderLive,
    });
    emit(step.finished);
    liveConversation.push(...step.live);
  }
  return { finished, liveConversation, userRows: builders.userRows, materializedPendingTurn: settled.materializedPendingTurn };
}
