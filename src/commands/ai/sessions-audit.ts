/** `clikcode sessions audit` and `clikcode sessions repair`: is a conversation as long as the evidence
 * says it was, and rebuilding its log when it is not (session/audit.ts). */

import { emitResult } from '../../cli/structured-output.js';
import { applyRepair, auditConversations, planRepair, type AuditEntry } from '../../session/audit.js';
import { readState } from '../../session/state/read.js';

/** A conversation by its id or the start of it. */
async function resolveId(reference: string): Promise<string> {
  const state = await readState({ transcripts: [] });
  const matches = state.sessions.filter((session) => session.id === reference || session.id.startsWith(reference));
  if (matches.length !== 1) throw new Error(matches.length ? `"${reference}" starts more than one conversation id` : `no conversation id starts with "${reference}"`);
  return matches[0]!.id;
}

/** Evidence by how much it adds, the first few: a long conversation can have a dozen threads. */
function shortened(entry: AuditEntry): Omit<AuditEntry, 'evidence'> & { evidence: AuditEntry['evidence']; moreEvidence?: number } {
  const ranked = [...entry.evidence].sort((a, b) => b.beyondStore - a.beyondStore || b.userTurns - a.userTurns);
  return { ...entry, evidence: ranked.slice(0, EVIDENCE_SHOWN), ...(ranked.length > EVIDENCE_SHOWN ? { moreEvidence: ranked.length - EVIDENCE_SHOWN } : {}) };
}
const EVIDENCE_SHOWN = 6;

/** Reads only. Lists the conversations whose store is behind the evidence (every one with `--all`). */
export async function aiSessionsAudit(options: { all?: boolean; id?: string } = {}): Promise<void> {
  const entries = await auditConversations(options.id ? [await resolveId(options.id)] : undefined);
  const flagged = entries.filter((entry) => entry.status !== 'ok');
  emitResult({
    checked: entries.length,
    behind: flagged.filter((entry) => entry.status === 'behind').length,
    logMissing: flagged.filter((entry) => entry.status === 'log-missing').length,
    note: 'Nothing was changed. `clikcode sessions repair <id>` shows what a rebuild would do; add --apply to do it.',
    conversations: (options.all || options.id ? entries : flagged).map(shortened),
  });
}

/** A dry run unless `--apply`: what the log would be rebuilt from. With it, every file the
 * conversation has is copied first (under repair-backups/), and then the log is written. */
export async function aiSessionsRepair(reference: string, options: { apply?: boolean } = {}): Promise<void> {
  const id = await resolveId(reference);
  const plan = await planRepair(id);
  const { messages: _messages, ...shown } = plan;
  if (!options.apply) {
    emitResult({ applied: false, ...shown, next: plan.steps.length ? `Run again with --apply to rebuild the log (everything it has is copied to repair-backups/${id}/ first).` : 'Nothing in the evidence extends this conversation.' });
    return;
  }
  const done = await applyRepair(plan);
  emitResult({ applied: true, ...shown, ...done });
}
