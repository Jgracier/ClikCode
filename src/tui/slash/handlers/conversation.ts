/** Conversation commands: starting, naming, forking, listing and reading conversations, and what they show. */
import { stripVTControlCharacters } from 'node:util';
import { searchConversations } from '../../../search/engine.js';
import { searchResultsPayload } from '../../../search/navigate.js';
import { shownSummary } from '../../../session/conversation-summary.js';
import { changesPath, fileTurnRows, fileTurnsText, isChangesPath } from '../file-changes.js';
import { clikCodeAgentLabel, isClikCodeAgent } from '../../../session/route.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { HarnessSession } from '../../../session/model.js';
import { compactPath } from '../../../harness/protocol/labels.js';
import { localHarnessForProvider } from '../../../runtime/lazy-bridge.js';
import { harnessCommand } from '../../../session/state/paths.js';
import { readState } from '../../../session/state/read.js';
import { writeState } from '../../../session/state/write.js';
import { emitHarnessOutput, renderSessionCard } from '../../../harness/output.js';
import { SELECTION_MODE, setSelectionMode } from '../../modes.js';
import { TERMINAL } from '../../active-terminal.js';
import { copyToClipboard, decodeAttachmentPath, expandHomePath, queueAttachment } from '../../../session/attachments.js';
import { conversationIdFor } from '../../../session/conversation-rows.js';
import { slashControls, slashHelpText, type SlashHandlerKey } from '../registry.js';
import { sessionTranscriptMessages } from '../../../turn/checkpoint.js';
import { textTranscript } from '../../../turn/turn-activities.js';
import { newConversationSession } from '../../../commands/ai/conversations.js';
import { aiSessionClose, aiSessionLeave } from '../../../commands/ai/sessions.js';
import { capabilitiesText } from '../capabilities-text.js';
import { compactConversation } from '../compact.js';
import { sessionHarness, slashExtrasFor } from '../context.js';
import { contextUsageText } from '../cost.js';
import { usageReport, usageReportAll } from '../usage-report.js';
import { forkPoint, messagesThrough } from '../fork-at.js';
import { exportTranscript } from '../export-transcript.js';
import { initPrompt, readMemoryFile, reviewPrompt } from '../memory.js';
import { addSessionDirectory, changeSessionWorkspace, workspaceDiff } from '../workspace.js';
import { redoFrom } from '../../../session/redo.js';
import { readTurnChanges, turnChangesAgo, turnChangesDiff, turnChangesList } from '../../../session/turn-changes.js';
import { stateDirectory } from '../../../session/store/paths.js';
import { type HeadlessSlashHandler, sendSessionTurn } from './shared.js';

/** What /copy copies: the conversation's last answer. */
export function lastAnswer(session: HarnessSession): string {
  const last = textTranscript(sessionTranscriptMessages(session)).reverse().find((message) => message.role === 'assistant');
  if (!last) throw new Error('There is no assistant response to copy yet.');
  return last.content;
}

export const conversationHandlers = {
  help: async ({ session }) => {
    const harness = sessionHarness(session);
    const extras = slashExtrasFor(session, harness);
    return emitHarnessOutput({ panel: 'help', helpText: slashHelpText(session, harness, extras), controls: slashControls() });
  },
  status: async ({ state, session }) => {
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
    // `text` too: the card as plain lines, for a surface that draws a
    // panel's text (VS Code) rather than the session it carries.
    return emitHarnessOutput({ panel: 'status', session, account, text: stripVTControlCharacters(renderSessionCard(session, account)) });
  },
  new: async ({ state, session, args }) => {
    // `/reset` and `/clear` are aliases, not an in-place wipe. Clearing the
    // transcript on the existing record destroyed history with no confirmation.
    // A fresh conversation gives the same clean slate and keeps the previous
    // one resumable. Text after the command is the new conversation's first
    // turn, sent ON the new session -- it used to be dropped, leaving an orphan.
    const created = newConversationSession(state, session);
    state.sessions.push(created);
    await writeState(state);
    if (!args) emitHarnessOutput({ panel: 'conversation-reset', session: created });
    else await sendSessionTurn(created.id, args);
    return created.id;
  },
  history: async ({ session }) => {
    const summary = shownSummary(session);
    return emitHarnessOutput({
      panel: 'history', messages: textTranscript(sessionTranscriptMessages(session)),
      ...(summary ? { summary: { through: summary.through, source: summary.source, text: summary.text } } : {}),
    });
  },
  copy: async ({ session }) => {
    const via = await copyToClipboard(lastAnswer(session));
    return emitHarnessOutput({ panel: 'copied', text: via === 'osc52' ? 'Last response sent to your terminal clipboard (OSC 52).' : 'Last response copied to the clipboard.' });
  },
  select: async ({ words }) => {
    // Mouse tracking is what makes a swipe scroll; it is also what stops the
    // terminal selecting text, because the drag is delivered to ClikCode
    // instead. No setting gives both, so this hands the mouse back on demand.
    const asked = words.join(' ').trim().toLowerCase();
    const active = asked === 'on' ? true : asked === 'off' ? false : !SELECTION_MODE.active;
    if (!TERMINAL.active) {
      throw new Error('Selection mode needs the interactive terminal; there is no mouse to release here.');
    }
    return emitHarnessOutput({ panel: 'select', text: setSelectionMode(active) });
  },
  mention: async ({ state, session, words }) => {
    const action = words.join(' ').trim();
    if (!action) return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [] });
    if (action === 'clear') {
      session.attachments = [];
    } else {
      const unquoted = decodeAttachmentPath(action);
      const workspace = session.workspace ?? process.cwd();
      const expanded = expandHomePath(unquoted);
      const path = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
      await queueAttachment(session, path);
    }
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    // `changed`: this is the confirmation of an attach or a clear, not the
    // list someone asked to see (that is the no-argument form above).
    return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [], changed: true });
  },
  search: async ({ args }) => {
    if (!args.trim()) throw new Error('usage: /search <words>');
    const result = await searchConversations(args);
    if (!result) throw new Error('usage: /search <words>');
    return emitHarnessOutput(searchResultsPayload(result));
  },
  diff: async ({ session }) => {
    const diff = await workspaceDiff(session.workspace ?? process.cwd());
    return emitHarnessOutput(diff === undefined ? { panel: 'diff', text: 'Not a git repository' } : { panel: 'diff', diff });
  },
  review: async ({ id, session, head, words }) => {
    // Gateway refusal lives in the registry's availability(), shared by both dispatchers.
    return sendSessionTurn(id, head === 'review' ? reviewPrompt(words.join(' ').trim()) : initPrompt(session));
  },
  rename: async ({ state, session, words }) => {
    const name = words.join(' ').trim();
    if (!name) throw new Error('Enter a name after /rename.');
    session.name = name.slice(0, 120);
    session.nameSource = 'user';
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-renamed', text: `Conversation renamed to “${session.name}”.` });
  },
  archive: async ({ state, session }) => {
    session.status = 'archived';
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-archived', text: 'Conversation archived.' });
  },
  delete: async ({ id, state, words }) => {
    if (words[0]?.toLowerCase() !== 'confirm') throw new Error('Use /delete confirm to permanently delete this ClikCode conversation. Provider-owned history is not deleted.');
    state.sessions = state.sessions.filter((item) => item.id !== id);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-deleted', text: 'Conversation deleted from ClikCode.' });
  },
  fork: async ({ state, session, words }) => {
    // `/fork @N [name]`: only through user message N and its answer. Stored
    // as a reference into this conversation's history (TranscriptRef).
    const at = forkPoint(words[0]);
    if (at !== undefined) words.shift();
    const messages = sessionTranscriptMessages(session);
    const now = new Date().toISOString();
    const fork: HarnessSession = {
      ...session, id: randomUUID(), name: words.join(' ').trim() || (session.name ? `${session.name} (fork)` : undefined),
      conversationId: conversationIdFor(session), parentSessionId: session.id, fork: true,
      messages: at === undefined ? messages : messagesThrough(messages, at), pendingTurn: undefined,
      // No vendor thread: the next turn replays the kept messages to rebuild
      // the context, so a fork at N does not carry what came after it.
      nativeSessionId: undefined, nativeStartedAt: undefined, createdAt: now, updatedAt: now, status: 'active', closedAt: undefined,
    };
    // A turn parked for the reset is the original's to send.
    delete fork.resumeAt;
    state.sessions.push(fork);
    await writeState(state);
    // The fork is where the user goes next: returning its id switches to it.
    const text = at === undefined
      ? `Forked as ${fork.id.slice(0, 8)} -- you are in the fork; the original is still in your conversations.`
      : `Forked after message ${at} as ${fork.id.slice(0, 8)} -- you are in the fork; the original is still in your conversations. Files on disk are not rewound: /changes lists what each turn edited, /redo puts it back.`;
    emitHarnessOutput({ panel: 'session-forked', text, session: fork });
    return fork.id;
  },
  sessions: async ({ state, words }) => {
    const action = words.shift()?.toLowerCase();
    const targetId = words.shift();
    if (action === 'close') {
      if (!targetId) throw new Error('usage: /sessions close <id>');
      return aiSessionClose(targetId);
    }
    if (action === 'show' || action === 'open' || action === 'resume') {
      if (!targetId) throw new Error(`usage: /sessions ${action} <id>`);
      const target = (await readState({ transcripts: [targetId] })).sessions.find((item) => item.id === targetId);
      if (!target) throw new Error(`AI session "${targetId}" was not found`);
      return emitHarnessOutput({ panel: 'session', session: target, next: `${harnessCommand()} sessions open ${target.id}` });
    }
    if (action && action !== 'list' && action !== 'ls') throw new Error('usage: /sessions [list|show <id>|open <id>|close <id>]');
    return emitHarnessOutput({
      panel: 'sessions',
      sessions: state.sessions.map((item) => ({
        id: item.id, status: item.status, harness: item.nativeHarness, nativeSessionId: item.nativeSessionId,
        provider: item.provider, model: item.model, workspace: item.workspace, updatedAt: item.updatedAt,
      })),
      controls: ['sessions list', 'sessions open <id>', 'sessions close <id>'],
    });
  },
  usage: async ({ state, session, words }) => {
    if (words[0]?.toLowerCase() === 'all') {
      const report = usageReportAll(state, session, { providerName: (provider) => localHarnessForProvider(provider)?.displayName ?? provider });
      return emitHarnessOutput({ panel: 'usage', text: report.text });
    }
    const harness = sessionHarness(session);
    const report = usageReport(state, session, {
      ...(harness ? { providerName: harness.displayName, providerId: harness.provider } : {}),
    });
    return emitHarnessOutput({ panel: 'usage', text: report.text, totals: report.totals });
  },
  export: async ({ session, words }) => {
    const force = words.includes('--force');
    const path = await exportTranscript(session, words.filter((word) => word !== '--force').join(' '), async () => force);
    return emitHarnessOutput({ panel: 'exported', text: `Transcript written to ${compactPath(path)}.`, path });
  },
  cwd: async ({ state, session, args }) => {
    if (!args) return emitHarnessOutput({ panel: 'cwd', text: compactPath(session.workspace ?? process.cwd()), workspace: session.workspace ?? process.cwd() });
    const notice = await changeSessionWorkspace(state, session, args);
    // The new directory is on the status line; this only confirms the change.
    return emitHarnessOutput({ panel: 'cwd', text: notice, workspace: session.workspace, changed: true });
  },
  'add-dir': async ({ state, session, args }) => emitHarnessOutput({ panel: 'add-dir', text: await addSessionDirectory(state, session, args) }),
  memory: async ({ session, words }) => {
    if (words[0]?.toLowerCase() === 'edit') throw new Error('/memory edit opens $EDITOR and is only available in the interactive ClikCode session.');
    const memory = await readMemoryFile(session);
    return emitHarnessOutput({ panel: 'memory', text: `${compactPath(memory.path)}\n\n${memory.content ?? '(not created yet — /init writes it)'}`, path: memory.path, exists: memory.content !== undefined });
  },
  changes: async ({ state, session, args, words }) => {
    if (isChangesPath(args)) {
      const file = changesPath(args, session.workspace ?? process.cwd());
      const rows = await fileTurnRows(state, file);
      return emitHarnessOutput({
        panel: 'changes', text: fileTurnsText(file, rows), file,
        turns: rows.map((row) => ({ sessionId: row.sessionId, turn: row.turnsAgo, at: row.record.at, prompt: row.record.prompt, additions: row.additions, removals: row.removals })),
      });
    }
    const records = await readTurnChanges(stateDirectory(), session.id);
    if (!words[0]) return emitHarnessOutput({ panel: 'changes', text: turnChangesList(records, session.workspace) });
    const n = Number(words[0]);
    const record = turnChangesAgo(records, n);
    if (!record) throw new Error(records.length ? `usage: /changes [N|path]  -- N from 1 (the last turn) to ${records.length}` : 'No turns recorded yet in this conversation.');
    return emitHarnessOutput({ panel: 'changes', text: turnChangesDiff(record, n, session.workspace), diff: record.changes });
  },
  redo: async ({ state, session, words }) => {
    const n = forkPoint(words[0]);
    if (n === undefined) throw new Error('usage: /redo @N [keep]  -- N as /fork numbers your prompts; keep leaves files as they are');
    const who = isClikCodeAgent(session) ? clikCodeAgentLabel(session) : sessionHarness(session)?.displayName ?? 'This provider';
    const redone = await redoFrom(state, session, n, { keepFiles: words[1] === 'keep', stateDir: stateDirectory(), who });
    await writeState(state);
    return emitHarnessOutput({ panel: 'redo', text: redone.text, prompt: redone.prompt });
  },
  compact: async ({ id, session, args }) => compactConversation(id, session, args, sendSessionTurn),
  context: async ({ session }) => emitHarnessOutput({ panel: 'context', text: contextUsageText(session), usage: session.lastUsage ?? null }),
  capabilities: async ({ session }) => emitHarnessOutput({ panel: 'capabilities', text: capabilitiesText(session) }),
  redraw: async () => emitHarnessOutput({ panel: 'redraw', text: 'Nothing to repaint outside the interactive session.' }),
  exit: async ({ id }) => aiSessionLeave(id),
} satisfies Partial<Record<SlashHandlerKey, HeadlessSlashHandler>>;
