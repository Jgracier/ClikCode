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
import { reseedStartIndex } from '../../render/reseed-window.js';
import { liveTurnSpan } from '../../render/steer-rows.js';
import { pendingPromptText } from '../../render/pending-prompt.js';
import { renderMessageBlocks } from '../../render/message-blocks.js';
import { withoutOtherOrgThinkingNotice } from '../../../harness/protocol/claude-thinking-notice.js';
import type { TerminalHarnessPrompter } from '../../prompter.js';
import { ALTERNATE_TRANSCRIPT_ROWS } from '../state.js';
import type { HarnessSession } from '../../../session/model.js';
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

export type TranscriptInput = {
  session: HarnessSession; pending: HarnessSession['pendingTurn']; persistedMessages: ReturnType<typeof frameMessages>['persistedMessages'];
  hasTransientAssistant: boolean; conversationInner: number;
};

type Kit = {
  finished: string[]; emit: (rows: readonly string[]) => void;
  userRows: RowBuilders['userRows']; noticeRows: RowBuilders['noticeRows']; messageRows: RowBuilders['messageRows']; standaloneActivity: RowBuilders['standaloneActivity'];
  savedTools: ReturnType<typeof createTurnTools>['savedTools']; turnTools: ReturnType<typeof createTurnTools>['turnTools'];
  renderBlocks: (blocks: readonly MessageBlock[], firstOfMessage: boolean) => string[];
  renderLive: (blocks: readonly MessageBlock[], firstOfMessage: boolean) => string[];
};

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
    // A /search mention further back than that starts the window there.
    const focus = p.mentionFocus?.sessionId === session.id ? p.mentionFocus.messageIndex : undefined;
    const recent = reseedStartIndex(persistedMessages, ALTERNATE_TRANSCRIPT_ROWS, conversationInner);
    const from = focus === undefined ? recent : Math.min(recent, Math.max(0, focus - 1));
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
  const { finished, emit, userRows, noticeRows, messageRows, standaloneActivity, savedTools, turnTools, renderBlocks } = kit;
  let liveAssistant = startLiveAssistant;
  emit(standaloneActivity(firstUnwritten));
  // The turn this window drew live has all its calls on screen already: a
  // steer splits its saved answer into several messages, and the ones after
  // the first must not draw those calls a second time.
  let drewLiveTurn = false;
  for (let index = firstUnwritten; index < persistedMessages.length; index += 1) {
    let message = persistedMessages[index]!;
    p.messageLines.set(index, p.alternateTrimmed + p.alternateTranscript.length + p.pendingFinished.length + finished.length);
    // Something ClikCode told the model (a background shell's exit) is not part of the conversation the user reads.
    if (message.role === 'user' && isClikCodeNotice(message.content)) {
      p.emitted.wrote(message);
      emit(standaloneActivity(index + 1));
      continue;
    }
    const pastTools = message.role === 'assistant' && index !== liveAssistant && !drewLiveTurn ? savedTools(message, index) : [];
    // A steered turn is saved as several messages and was drawn live as
    // one answer: the span of them is that answer, written once.
    const spanEnd = index === liveAssistant && message.role === 'assistant'
      ? liveTurnSpan(persistedMessages, index, [...p.turnSteers.values()]) : index;
    if (index === liveAssistant && message.role === 'assistant') {
      // The answer that just streamed. Its rows are already in scrollback and
      // the transcript knows exactly which blocks it still owes, so a
      // persisted copy that runs longer than what streamed -- a re-derived
      // answer, an interrupted turn -- contributes only its tail, and one
      // identical to what streamed contributes nothing at all.
      const answer = persistedMessages.slice(index, spanEnd + 1).filter((item) => item.role === 'assistant').map((item) => item.content).join('');
      emit(p.turnTranscript.advance({
        content: sanitizeTerminalText(answer), tools: turnTools(true), turnEnded: true, renderBlocks,
      }).finished);
    } else if (pastTools.length) {
      // A saved turn: its calls go back where they happened, between the
      // paragraphs, as they were drawn while it ran.
      emit(new TurnTranscript().advance({
        content: sanitizeTerminalText(stripRepeatedTitles(message.content)), tools: pastTools,
        turnEnded: true, renderBlocks,
      }).finished);
    } else {
      // A change of speaker is a bigger break than a change of paragraph.
      // Every gap in the transcript was one row -- between messages and
      // between the blocks inside them alike -- so a new question read as
      // just another paragraph of the answer above it. Reported as "no
      // buffer" repeatedly, and it was: the buffer was there, it just
      // measured the same as everything else. Never at the very top, where
      // there is nothing to separate from.
      if (message.role === 'user' && index > 0) emit(['']);
      // A title tag never renders, however it got into the saved reply: a
      // vendor that repeated its first reply's tag, or an older transcript.
      // An older automatic /compact record is its notice, not the user's words.
      emit(message.role === 'assistant'
        ? messageRows(withoutOtherOrgThinkingNotice(stripRepeatedTitles(message.content)), '·')
        : message.automatic ? noticeRows(message.automatic) : userRows(message.content));
    }
    if (index === liveAssistant) {
      p.emitted.liveAnswerSettled();
      liveAssistant = undefined;
      drewLiveTurn = true;
      p.turnTranscript.reset();
      p.turnSteers.clear();
      // The steers and the answers after them were that same drawing.
      for (let covered = index + 1; covered <= spanEnd; covered += 1) {
        p.messageLines.set(covered, p.messageLines.get(index) ?? 0);
        p.emitted.wrote(persistedMessages[covered]!);
      }
      index = spanEnd;
      message = persistedMessages[index]!;
    }
    // What the turn needed on the way -- a sign-in, another account --
    // saved with its answer, then its closing line.
    if (message.role === 'assistant' && message.accountSwitch) emit(['', `  ${chalk.yellow(accountSwitchLine(message.accountSwitch))}`]);
    const ended = message.role === 'assistant' ? turnEndLine(persistedMessages, index) : undefined;
    if (ended) emit(['', `  ${chalk.dim(`─ ${ended} ─`)}`]);
    p.emitted.wrote(message);
    emit(['']);
    emit(standaloneActivity(index + 1));
  }
  p.emitted.settle(persistedMessages.length);
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
  const emit = (rows: readonly string[]): void => {
    for (const row of rows) {
      const last = finished.length ? finished[finished.length - 1] : p.lastFinishedRow;
      const before = finished.length > 1 ? finished[finished.length - 2]
        : finished.length ? p.lastFinishedRow : p.secondLastFinishedRow;
      // An empty row on each side of a message, so two of them separate a
      // message from the answer under it and from the message after it.
      // Never a third, and never a leading one at the top of a transcript.
      if (row === '' && (last === undefined || (last === '' && (before === '' || before === undefined)))) continue;
      finished.push(row);
    }
  };
  const builders = createRowBuilders(p, conversationInner);
  const { userRows, noticeRows, messageRows, standaloneActivity } = builders;
  const seam: TurnSeam = { materializedPendingTurn: false };
  const { savedTools, turnTools } = createTurnTools(p, builders, createToolRows(p, builders), pending, seam);
  const renderBlocks = (blocks: readonly MessageBlock[], firstOfMessage: boolean): string[] =>
    renderMessageBlocks(blocks.flatMap((block): MessageBlock[] => {
      if (block.kind !== 'paragraph' && block.kind !== 'heading' && block.kind !== 'list-item') return [block];
      const text = withoutOtherOrgThinkingNotice(block.text);
      return text.trim() ? [{ ...block, text }] : [];
    }), '·', conversationInner, firstOfMessage);
  const renderLive = (blocks: readonly MessageBlock[], firstOfMessage: boolean): string[] =>
    renderMessageBlocks(blocks, '·', conversationInner, firstOfMessage, true);
  const settled = settleSeam(p, finished, session, persistedMessages, conversationInner);
  seam.materializedPendingTurn = settled.materializedPendingTurn;
  const kit: Kit = { finished, emit, userRows, noticeRows, messageRows, standaloneActivity, savedTools, turnTools, renderBlocks, renderLive };
  writeMessages(p, kit, persistedMessages, settled.firstUnwritten, settled.liveAssistant);
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
  return { finished, liveConversation, userRows, materializedPendingTurn: settled.materializedPendingTurn };
}
