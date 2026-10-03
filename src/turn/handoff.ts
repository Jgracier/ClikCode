/** Portable conversation branches and vendor transcript reconciliation. */
import { randomUUID } from 'node:crypto';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessDefaultSettings, HarnessSession, HarnessState } from '../session/model.js';
import { conversationIdFor } from '../session/options.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { ADOPTED_TRANSCRIPT_READERS } from '../session/discovery/registry.js';
import { mergeNativeTranscript } from '../session/discovery/transcript.js';
import { nativeProfileEnvironment } from '../harness/transport/profile-environment.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';

/** Create a portable child branch. The source keeps its provider-owned
 * identity; the child carries the ClikCode-owned transcript into its target. */
export function createHandoffBranch(input: {
  source: HarnessSession;
  target: AiLocalHarnessDefinition;
  accountId: string | null;
  model: string | null;
  defaults: HarnessDefaultSettings;
  now: string;
  id?: string;
  sourceDisplayName?: string;
  /** The interrupted turn this branch carries on (see handoff.turn). */
  turn?: string;
}): HarnessSession {
  const sourceCommand = input.source.nativeHarness ?? input.source.route;
  const id = input.id ?? randomUUID();
  const base = input.source.name?.replace(/\s+\(from [^)]+\)$/i, '').trim();
  return {
    id, conversationId: conversationIdFor(input.source), parentSessionId: input.source.id,
    handoff: { fromSessionId: input.source.id, fromHarness: sourceCommand, at: input.now, ...(input.turn ? { turn: input.turn } : {}) },
    route: 'local', accountId: input.accountId, provider: input.target.provider, model: input.model,
    effort: input.defaults.effort, permissionMode: input.defaults.permissionMode, accountFailover: input.defaults.accountFailover,
    workspace: input.source.workspace ?? process.cwd(), nativeHarness: input.target.command,
    ...(base ? { name: base } : {}),
    ...(sessionTranscriptMessages(input.source).length
      ? { messages: sessionTranscriptMessages(input.source).map((message) => ({ ...message })) }
      : {}),
    // Files attached for a request that has not finished (one that ran out
    // mid-turn keeps them) or for the next one. The transcript keeps only the
    // typed words, so without these the new provider's first turn retold the
    // request without what it was about.
    ...(input.source.attachments?.length ? { attachments: [...input.source.attachments] } : {}),
    createdAt: input.now, updatedAt: input.now, status: 'active',
  };
}

/** Pull turns added directly in a vendor CLI back into an already-linked
 * ClikCode conversation. The native CLI remains the only writer of its own
 * files; this only reconciles ClikCode's cached view after an exact-id resume. */
export async function synchronizeNativeTranscript(state: HarnessState, session: HarnessSession): Promise<boolean> {
  if (!session.nativeHarness || !session.nativeSessionId) return false;
  const harness = localHarnessForCommand(session.nativeHarness);
  const reader = harness ? ADOPTED_TRANSCRIPT_READERS[harness.command] : undefined;
  if (!harness || !reader) return false;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const source = await reader(
    harness, session.nativeSessionId, session.workspace ?? process.cwd(), nativeProfileEnvironment(account?.nativeProfile),
  ).catch(() => []);
  const previousLength = (session.messages ?? []).length;
  const merged = mergeNativeTranscript(session.messages ?? [], source);
  if (merged.length === (session.messages ?? []).length) return false;
  session.messages = merged;
  // If the vendor transcript now contains the prompt that was journaled by a
  // previously interrupted ClikCode process, the vendor copy is authoritative
  // and the separate checkpoint must not render or hand off a duplicate.
  if (session.pendingTurn) {
    const appended = merged.slice(previousLength);
    const promptIndex = appended.findIndex((message) =>
      message.role === 'user' && message.content.trim() === session.pendingTurn!.prompt.trim());
    if (promptIndex >= 0) {
      const nativeHasAnswer = appended.slice(promptIndex + 1).some((message) => message.role === 'assistant');
      if (!nativeHasAnswer) {
        const checkpointAnswer = sessionTranscriptMessages({ ...session, messages: [] })
          .find((message) => message.role === 'assistant');
        if (checkpointAnswer) session.messages.push(checkpointAnswer);
      }
      delete session.pendingTurn;
    }
  }
  session.updatedAt = new Date().toISOString();
  return true;
}
