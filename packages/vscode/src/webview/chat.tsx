/** The conversation: messages, the running turn, its tool activity, plans,
 * notices and approvals. */
import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { reconnecting, turnNoticeNotes, type ChatModel, type Note, type TurnTrace } from '../model';
import { Animating, Icon } from './ui';
import { userMessageIndexes } from '../../../../src/tui/slash/fork-at';
import { withoutOtherOrgThinkingNotice } from '../../../../src/harness/protocol/claude-thinking-notice';
import { AssistantMessage, UserMessage } from './messages';
import { FinishedTurn, LiveTurnView, NoteView, waitingOnUser } from './turn';

export { waitingOnUser, workingLabelClass } from './turn';

/** Messages drawn at first; a long conversation shows its latest and loads
 * earlier ones on demand, so opening it stays instant. */
const WINDOW = 120;

/** The settled conversation. Memoized on the fields it draws, which keep
 * their objects while a turn streams, so a delta does not redraw it. */
/** The notices that arrived during one turn, or nothing (a stable value, so
 * a turn without any is not redrawn when another's note arrives). */
function turnNotes(notes: readonly Note[], userIndex: number): Note[] | undefined {
  const found = notes.filter((note) => note.turn === userIndex);
  return found.length ? found : undefined;
}

/** A finished turn's notices: the window's own and the worker's saved ones. */
function turnNotices(notes: readonly Note[], trace: TurnTrace): Note[] | undefined {
  const all = turnNoticeNotes(turnNotes(notes, trace.userIndex), trace);
  return all.length ? all : undefined;
}

const History = memo(({ sessionId, messages, traces, notes, workspace, reveal }: Pick<ChatModel, 'sessionId' | 'messages' | 'traces' | 'notes' | 'workspace'> & { reveal?: number }): JSX.Element => {
  const byUser = useMemo(() => new Map(traces.map((trace) => [trace.userIndex, trace])), [traces]);
  // Each prompt's number as /redo counts them (ClikCode's own continuation
  // prompts are not the user's and get none).
  const promptNumbers = useMemo(() => new Map(userMessageIndexes(messages).map((at, position) => [at, position + 1])), [messages]);
  const [shown, setShown] = useState(WINDOW);
  useEffect(() => { setShown(WINDOW); }, [sessionId]);
  // A message /search went to is drawn, however far back it is.
  useEffect(() => { if (reveal !== undefined && messages.length - reveal > shown) setShown(messages.length - reveal + WINDOW / 4); }, [reveal, messages.length]);
  const start = Math.max(0, messages.length - shown);
  const parts: JSX.Element[] = [];
  if (start > 0) {
    parts.push(
      <button key="earlier" type="button" class="more-steps earlier" onClick={() => setShown(shown + WINDOW)}>
        <Icon name="fold-up" /> {start} earlier message{start === 1 ? '' : 's'}
      </button>,
    );
  }
  const notesAt = (index: number): void => {
    // A note from a turn with a trace is drawn in that turn, at its offset.
    notes.forEach((note, position) => { if (note.after === index && !(note.turn !== undefined && byUser.has(note.turn))) parts.push(<NoteView key={`n${position}`} note={note} />); });
  };
  if (start === 0) notesAt(0);
  messages.forEach((message, index) => {
    if (index < start) return;
    const trace = message.role === 'assistant' ? byUser.get(index - 1) : undefined;
    // `display: contents`: an anchor /search finds the message by, with no box of its own.
    parts.push(
      <div key={`m${index}`} class="message-anchor" data-message={index}>
        {message.role === 'user' ? <UserMessage text={message.content} {...(promptNumbers.has(index) ? { prompt: promptNumbers.get(index)! } : {})} />
          : trace ? <FinishedTurn text={message.content} trace={trace} cacheKey={`${sessionId}#${index}`} workspace={workspace} notes={turnNotices(notes, trace)} />
            : <AssistantMessage cacheKey={`${sessionId}#${index}`} text={message.content} />}
      </div>,
    );
    notesAt(index + 1);
  });
  return <>{parts}</>;
});

/** What a screen reader hears of a turn: the working status line (its own
 * live region) while it runs, and the finished answer once -- not every
 * delta of the streaming text, nor the log's every redraw. */
function FinalAnswer({ running, messages }: Pick<ChatModel, 'running' | 'messages'>): JSX.Element {
  const owed = useRef(false);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (running) { owed.current = true; setSaid(''); return; }
    const last = messages[messages.length - 1];
    if (owed.current && last?.role === 'assistant') {
      owed.current = false;
      const answer = withoutOtherOrgThinkingNotice(last.content);
      setSaid(answer.length > 1000 ? `${answer.slice(0, 1000)}…` : answer);
    }
  }, [running, messages]);
  return <div class="visually-hidden" role="status" aria-live="polite">{said}</div>;
}

export function Transcript({ model, reveal }: { model: ChatModel; reveal?: number }): JSX.Element {
  const parts: JSX.Element[] = [];
  if (model.pendingPrompt) parts.push(<UserMessage key="pending" text={model.pendingPrompt} />);
  // The plan and the turn's notices are rows of the turn, drawn once each
  // where they first appeared (TurnFlow), not cards of their own.
  const inTurn = model.live && model.turnUserIndex !== undefined ? model.turnUserIndex : undefined;
  if (model.running) {
    parts.push(<LiveTurnView key="live" live={model.live} workspace={model.workspace} asking={waitingOnUser(model)} plan={model.plan} notes={model.notes} away={reconnecting(model)}
      {...(model.turnUsage ? { usage: model.turnUsage } : {})}
      {...(inTurn !== undefined ? { turn: inTurn } : {})} />);
  }
  // Notes from the running turn that could not be placed in it follow it.
  model.notes.forEach((note, position) => {
    if (note.after > model.messages.length && !(inTurn !== undefined && note.turn === inTurn)) parts.push(<NoteView key={`n${position}`} note={note} />);
  });
  const queuedTexts = new Set(model.queued.map((item) => item.text));
  const steered = new Set(model.live?.steers.map((steer) => steer.text));
  for (const submission of model.submissions) {
    // A queued message is drawn once, from the stored queue under the
    // composer; one the turn took is drawn in the turn, where it landed.
    if (submission.disposition === 'queued' || (!submission.disposition && queuedTexts.has(submission.text)) || steered.has(submission.text)) continue;
    const said = submission.disposition === 'steered' ? 'Sent into this turn' : submission.disposition === 'queued' ? 'Queued for the next turn' : submission.disposition === 'error' ? 'Not sent' : 'Sending…';
    parts.push(<div key={`s${submission.id}`} class="submission"><Icon name="arrow-small-right" /><span class="muted">{said}:</span> <span>{submission.text}</span></div>);
  }
  return (
    <Animating.Provider value={!reconnecting(model)}>
      <div class="transcript" role="log" aria-live="off" aria-relevant="additions">
        <History sessionId={model.sessionId} messages={model.messages} traces={model.traces} notes={model.notes} workspace={model.workspace} reveal={reveal} />
        {parts}
        <FinalAnswer running={model.running} messages={model.messages} />
      </div>
    </Animating.Provider>
  );
}
